import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { GenealogyDb } from './db.ts'
import type { AppSettings, GenealogyMeta, Skin } from '../shared/types'

interface Registry { genealogies: GenealogyMeta[] }

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) as T } catch { return fallback }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  fs.renameSync(tmp, file)
}

export interface CreateGenealogyInput {
  name: string; hall?: string; surname?: string; origin?: string; compiler?: string; note?: string
}

export class DataStore {
  private configPath: string
  private settings: AppSettings
  private openDb: GenealogyDb | null = null
  private openId: string | null = null

  constructor(configPath: string, defaultDataDir: string) {
    this.configPath = configPath
    const saved = readJson<Partial<AppSettings>>(configPath, {})
    this.settings = {
      dataDir: saved.dataDir || defaultDataDir,
      skin: (saved.skin as Skin) || 'system',
      autoBackup: saved.autoBackup !== false,
      autoBackupKeep: saved.autoBackupKeep ?? 10,
      lunarDefault: saved.lunarDefault === true,
    }
    fs.mkdirSync(this.settings.dataDir, { recursive: true })
    this.saveSettings()
  }

  getSettings(): AppSettings { return { ...this.settings } }

  private saveSettings(): void { writeJson(this.configPath, this.settings) }

  updateSettings(patch: Partial<Omit<AppSettings, 'dataDir'>>): AppSettings {
    Object.assign(this.settings, patch)
    this.saveSettings()
    return this.getSettings()
  }

  private registryPath(): string { return path.join(this.settings.dataDir, 'registry.json') }
  private registry(): Registry { return readJson<Registry>(this.registryPath(), { genealogies: [] }) }
  private saveRegistry(r: Registry): void { writeJson(this.registryPath(), r) }

  genealogyDir(id: string): string { return path.join(this.settings.dataDir, id) }
  backupRoot(): string { return path.join(this.settings.dataDir, '.backups') }
  trashRoot(): string { return path.join(this.settings.dataDir, '.trash') }

  checkDataDir(dir: string): { ok: boolean; message?: string } {
    try {
      fs.mkdirSync(dir, { recursive: true })
      const probe = path.join(dir, `.write-test-${randomUUID()}`)
      fs.writeFileSync(probe, 'ok')
      fs.unlinkSync(probe)
      return { ok: true }
    } catch (e) {
      return { ok: false, message: `目录不可写：${(e as Error).message}` }
    }
  }

  setDataDir(newDir: string): { ok: boolean; message?: string; migrated: number } {
    const resolved = path.resolve(newDir)
    if (resolved === path.resolve(this.settings.dataDir)) return { ok: true, migrated: 0 }
    const check = this.checkDataDir(resolved)
    if (!check.ok) return { ok: false, message: check.message, migrated: 0 }
    this.closeGenealogy()
    if (fs.existsSync(path.join(resolved, 'registry.json'))) {
      this.settings.dataDir = resolved
      this.saveSettings()
      return { ok: true, migrated: 0, message: '已切换到现有数据目录' }
    }
    let migrated = 0
    const oldDir = this.settings.dataDir
    for (const entry of fs.readdirSync(oldDir, { withFileTypes: true })) {
      if (entry.name === '.trash') continue
      fs.cpSync(path.join(oldDir, entry.name), path.join(resolved, entry.name), { recursive: true })
      if (entry.isDirectory()) migrated++
    }
    this.settings.dataDir = resolved
    this.saveSettings()
    return { ok: true, migrated }
  }

  listGenealogies(): GenealogyMeta[] {
    const reg = this.registry()
    for (const g of reg.genealogies) {
      const dbFile = path.join(this.genealogyDir(g.id), 'genealogy.db')
      if (fs.existsSync(dbFile)) {
        if (this.openId === g.id && this.openDb) {
          g.memberCount = this.openDb.countMembers()
        } else {
          try {
            const db = new GenealogyDb(dbFile)
            g.memberCount = db.countMembers()
            db.close()
          } catch { /* keep cached count */ }
        }
      }
    }
    reg.genealogies.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    return reg.genealogies
  }

  createGenealogy(input: CreateGenealogyInput): GenealogyMeta {
    if (!input.name.trim()) throw new Error('家谱名称不能为空')
    const id = randomUUID()
    const t = Date.now()
    const dir = this.genealogyDir(id)
    fs.mkdirSync(path.join(dir, 'photos'), { recursive: true })
    const db = new GenealogyDb(path.join(dir, 'genealogy.db'))
    db.setMeta('id', id)
    db.setMeta('name', input.name.trim())
    db.setMeta('hall', input.hall ?? '')
    db.setMeta('surname', input.surname ?? '')
    db.setMeta('origin', input.origin ?? '')
    db.setMeta('compiler', input.compiler ?? '')
    db.setMeta('note', input.note ?? '')
    db.setMeta('createdAt', String(t))
    db.close()
    const meta: GenealogyMeta = {
      id, name: input.name.trim(), hall: input.hall ?? '', surname: input.surname ?? '',
      origin: input.origin ?? '', compiler: input.compiler ?? '', note: input.note ?? '',
      createdAt: t, updatedAt: t, memberCount: 0, lastOpenedAt: t,
    }
    const reg = this.registry()
    reg.genealogies.push(meta)
    this.saveRegistry(reg)
    return meta
  }

  openGenealogy(id: string): GenealogyMeta {
    const reg = this.registry()
    const meta = reg.genealogies.find((g) => g.id === id)
    if (!meta) throw new Error('家谱不存在')
    this.closeGenealogy()
    const dir = this.genealogyDir(id)
    fs.mkdirSync(path.join(dir, 'photos'), { recursive: true })
    this.openDb = new GenealogyDb(path.join(dir, 'genealogy.db'))
    this.openId = id
    meta.lastOpenedAt = Date.now()
    this.saveRegistry(reg)
    return meta
  }

  closeGenealogy(): void {
    if (this.openDb && this.openId) {
      const reg = this.registry()
      const meta = reg.genealogies.find((g) => g.id === this.openId)
      if (meta) {
        meta.memberCount = this.openDb.countMembers()
        meta.updatedAt = Date.now()
        this.saveRegistry(reg)
      }
      this.openDb.close()
    }
    this.openDb = null
    this.openId = null
  }

  current(): GenealogyDb {
    if (!this.openDb) throw new Error('尚未打开家谱')
    return this.openDb
  }

  currentId(): string | null { return this.openId }

  currentMeta(): GenealogyMeta | null {
    if (!this.openId) return null
    const meta = this.registry().genealogies.find((g) => g.id === this.openId) ?? null
    if (meta && this.openDb) meta.memberCount = this.openDb.countMembers()
    return meta
  }

  updateGenealogyMeta(id: string, patch: Partial<Pick<GenealogyMeta, 'name' | 'hall' | 'surname' | 'origin' | 'compiler' | 'note'>>): void {
    const reg = this.registry()
    const meta = reg.genealogies.find((g) => g.id === id)
    if (!meta) throw new Error('家谱不存在')
    Object.assign(meta, patch, { updatedAt: Date.now() })
    this.saveRegistry(reg)
    if (this.openId === id && this.openDb) {
      for (const [k, v] of Object.entries(patch)) if (v != null) this.openDb.setMeta(k, String(v))
    }
  }

  deleteGenealogy(id: string): { name: string } {
    const reg = this.registry()
    const idx = reg.genealogies.findIndex((g) => g.id === id)
    if (idx < 0) throw new Error('家谱不存在')
    const meta = reg.genealogies[idx]
    if (this.openId === id) this.closeGenealogy()
    const trashDir = path.join(this.trashRoot(), `${id}-${Date.now()}`)
    fs.mkdirSync(this.trashRoot(), { recursive: true })
    fs.renameSync(this.genealogyDir(id), trashDir)
    reg.genealogies.splice(idx, 1)
    this.saveRegistry(reg)
    writeJson(path.join(trashDir, '.trash-meta.json'), { meta, deletedAt: Date.now() })
    return { name: meta.name }
  }

  undoDelete(trashName: string): GenealogyMeta | null {
    const trashDir = path.join(this.trashRoot(), trashName)
    const info = readJson<{ meta: GenealogyMeta } | null>(path.join(trashDir, '.trash-meta.json'), null)
    if (!info) return null
    fs.renameSync(trashDir, this.genealogyDir(info.meta.id))
    const reg = this.registry()
    reg.genealogies.push(info.meta)
    this.saveRegistry(reg)
    return info.meta
  }

  lastTrash(): string | null {
    if (!fs.existsSync(this.trashRoot())) return null
    const entries = fs.readdirSync(this.trashRoot()).filter((n) => fs.existsSync(path.join(this.trashRoot(), n, '.trash-meta.json')))
    if (!entries.length) return null
    entries.sort()
    return entries[entries.length - 1]
  }

  duplicateGenealogy(id: string, newName: string): GenealogyMeta {
    const reg = this.registry()
    const src = reg.genealogies.find((g) => g.id === id)
    if (!src) throw new Error('家谱不存在')
    const newId = randomUUID()
    const t = Date.now()
    if (this.openId === id) this.closeGenealogy()
    fs.cpSync(this.genealogyDir(id), this.genealogyDir(newId), { recursive: true })
    const db = new GenealogyDb(path.join(this.genealogyDir(newId), 'genealogy.db'))
    db.setMeta('id', newId)
    db.setMeta('name', newName)
    db.close()
    const meta: GenealogyMeta = { ...src, id: newId, name: newName, createdAt: t, updatedAt: t, lastOpenedAt: t }
    reg.genealogies.push(meta)
    this.saveRegistry(reg)
    return meta
  }

  savePhoto(genealogyId: string, sourcePath: string): string {
    const ext = path.extname(sourcePath).toLowerCase()
    if (!['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) throw new Error('不支持的图片格式')
    const rel = path.join('photos', `${randomUUID()}${ext}`)
    fs.copyFileSync(sourcePath, path.join(this.genealogyDir(genealogyId), rel))
    return rel.split(path.sep).join('/')
  }

  resolvePhoto(genealogyId: string, relPath: string): string | null {
    const base = this.genealogyDir(genealogyId)
    const full = path.resolve(base, relPath)
    if (!full.startsWith(path.resolve(base) + path.sep)) return null
    return fs.existsSync(full) ? full : null
  }

  dispose(): void { this.closeGenealogy() }
}