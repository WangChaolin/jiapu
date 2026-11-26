import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import AdmZip from 'adm-zip'
import { GenealogyDb } from './db.ts'
import type { BackupEntry, GenealogyMeta, RestoreResult } from '../shared/types'

const FORMAT_VERSION = 1

interface Manifest {
  formatVersion: number
  genealogyId: string
  genealogyName: string
  hall: string
  surname: string
  createdAt: number
  memberCount: number
  kind: 'manual' | 'auto'
  note: string
  appVersion: string
}

function stamp(t: number): string {
  const d = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || 'genealogy'
}

function readManifest(zipPath: string): Manifest | null {
  try {
    const zip = new AdmZip(zipPath)
    const entry = zip.getEntry('manifest.json')
    if (!entry) return null
    const m = JSON.parse(entry.getData().toString('utf-8')) as Manifest
    if (m.formatVersion !== FORMAT_VERSION) return null
    return m
  } catch { return null }
}

export function createBackup(
  db: GenealogyDb, meta: GenealogyMeta, genealogyDir: string, backupRoot: string,
  kind: 'manual' | 'auto', note: string, appVersion: string,
): BackupEntry {
  const t = Date.now()
  const dir = path.join(backupRoot, meta.id)
  fs.mkdirSync(dir, { recursive: true })
  const tmpDb = path.join(os.tmpdir(), `jiapu-snap-${randomUUID()}.db`)
  db.vacuumInto(tmpDb)
  const manifest: Manifest = {
    formatVersion: FORMAT_VERSION, genealogyId: meta.id, genealogyName: meta.name,
    hall: meta.hall, surname: meta.surname, createdAt: t, memberCount: db.countMembers(),
    kind, note, appVersion,
  }
  const file = path.join(dir, `${safeName(meta.name)}-${stamp(t)}-${randomUUID().slice(0, 4)}-${kind}.zip`)
  const zip = new AdmZip()
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'))
  zip.addLocalFile(tmpDb, '', 'genealogy.db')
  const photos = path.join(genealogyDir, 'photos')
  if (fs.existsSync(photos)) zip.addLocalFolder(photos, 'photos')
  zip.writeZip(file)
  fs.unlinkSync(tmpDb)
  return {
    file, genealogyId: meta.id, genealogyName: meta.name, createdAt: t,
    size: fs.statSync(file).size, memberCount: manifest.memberCount, kind, note,
  }
}

export function listBackups(backupRoot: string): BackupEntry[] {
  const out: BackupEntry[] = []
  if (!fs.existsSync(backupRoot)) return out
  for (const gid of fs.readdirSync(backupRoot)) {
    const dir = path.join(backupRoot, gid)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.zip')) continue
      const file = path.join(dir, f)
      const m = readManifest(file)
      if (!m) continue
      out.push({
        file, genealogyId: m.genealogyId, genealogyName: m.genealogyName, createdAt: m.createdAt,
        size: fs.statSync(file).size, memberCount: m.memberCount, kind: m.kind, note: m.note,
      })
    }
  }
  out.sort((a, b) => b.createdAt - a.createdAt)
  return out
}

export function verifyBackup(zipPath: string): { ok: boolean; message?: string; manifest?: Manifest } {
  const m = readManifest(zipPath)
  if (!m) return { ok: false, message: '备份文件无效或格式版本不支持' }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jiapu-verify-'))
  try {
    const zip = new AdmZip(zipPath)
    const dbEntry = zip.getEntry('genealogy.db')
    if (!dbEntry) return { ok: false, message: '备份缺少数据库文件' }
    const dbFile = path.join(tmp, 'genealogy.db')
    fs.writeFileSync(dbFile, dbEntry.getData())
    const db = new GenealogyDb(dbFile)
    const ok = db.integrityCheck()
    const count = db.countMembers()
    db.close()
    if (!ok) return { ok: false, message: '数据库完整性校验失败' }
    if (count !== m.memberCount) return { ok: false, message: `成员数不一致（清单 ${m.memberCount}，实际 ${count}）` }
    return { ok: true, manifest: m }
  } catch (e) {
    return { ok: false, message: `校验失败：${(e as Error).message}` }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

export function extractBackup(zipPath: string, targetDir: string): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jiapu-restore-'))
  try {
    new AdmZip(zipPath).extractAllTo(tmp, true)
    fs.mkdirSync(targetDir, { recursive: true })
    for (const f of ['genealogy.db-wal', 'genealogy.db-shm']) {
      const p = path.join(targetDir, f)
      if (fs.existsSync(p)) fs.unlinkSync(p)
    }
    fs.copyFileSync(path.join(tmp, 'genealogy.db'), path.join(targetDir, 'genealogy.db'))
    const photos = path.join(targetDir, 'photos')
    if (fs.existsSync(photos)) fs.rmSync(photos, { recursive: true, force: true })
    if (fs.existsSync(path.join(tmp, 'photos'))) {
      fs.cpSync(path.join(tmp, 'photos'), photos, { recursive: true })
    } else {
      fs.mkdirSync(photos, { recursive: true })
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

export function pruneAutoBackups(backupRoot: string, genealogyId: string, keep: number): number {
  const dir = path.join(backupRoot, genealogyId)
  if (!fs.existsSync(dir)) return 0
  const autos = fs.readdirSync(dir).filter((f) => f.endsWith('-auto.zip'))
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  let removed = 0
  for (const f of autos.slice(Math.max(keep, 1))) { fs.unlinkSync(f); removed++ }
  return removed
}

export function exportJson(db: GenealogyDb, meta: GenealogyMeta): string {
  const graph = db.graph()
  return JSON.stringify({
    formatVersion: FORMAT_VERSION, exportedAt: Date.now(), meta,
    members: graph.members, relations: graph.edges,
    branches: db.listBranches(), zibei: db.listZibei(),
  }, null, 2)
}

export function importJson(db: GenealogyDb, json: string): number {
  const data = JSON.parse(json) as {
    formatVersion: number
    members: Parameters<GenealogyDb['createMember']>[0][] & { id?: string }[]
    relations: { type: string; subtype: string; from: string; to: string; isPrimary?: boolean }[]
    branches?: { id: string; name: string; parentId: string | null; founderId: string | null; note: string }[]
    zibei?: { branchId: string | null; poem: string }[]
  }
  if (data.formatVersion !== FORMAT_VERSION) throw new Error('JSON 格式版本不支持')
  const idMap = new Map<string, string>()
  const branchMap = new Map<string, string>()
  for (const b of data.branches ?? []) {
    const nb = db.createBranch(b.name, null, null, b.note ?? '')
    branchMap.set(b.id, nb.id)
  }
  for (const b of data.branches ?? []) {
    if (b.parentId && branchMap.has(b.parentId)) {
      db.updateBranch(branchMap.get(b.id)!, b.name, branchMap.get(b.parentId)!, null, b.note ?? '')
    }
  }
  const rawMembers = data.members as unknown as {
    id: string; name: string; gender: '男' | '女' | '其他'; generation: number; branchId: string | null
    birthDate?: string; birthLunar?: boolean; deathDate?: string; deathLunar?: boolean; alive?: boolean
    birthOrder?: number; courtesyName?: string; title?: string; occupation?: string; residence?: string
    burial?: string; biography?: string; remark?: string
  }[]
  for (const m of rawMembers) {
    const created = db.createMember({
      name: m.name, gender: m.gender, generation: m.generation,
      branchId: m.branchId ? (branchMap.get(m.branchId) ?? null) : null,
      birthDate: m.birthDate, birthLunar: m.birthLunar, deathDate: m.deathDate, deathLunar: m.deathLunar,
      alive: m.alive, birthOrder: m.birthOrder, courtesyName: m.courtesyName, title: m.title,
      occupation: m.occupation, residence: m.residence, burial: m.burial, biography: m.biography, remark: m.remark,
    })
    idMap.set(m.id, created.id)
  }
  const parentGroups = new Map<string, { otherId: string; subtype: string; isPrimary?: boolean }[]>()
  const spousePairs: { a: string; b: string; subtype: string }[] = []
  for (const r of data.relations) {
    const from = idMap.get(r.from), to = idMap.get(r.to)
    if (!from || !to) continue
    if (r.type === 'parent_child') {
      if (!parentGroups.has(to)) parentGroups.set(to, [])
      parentGroups.get(to)!.push({ otherId: from, subtype: r.subtype, isPrimary: r.isPrimary })
    } else if (r.type === 'spouse') {
      spousePairs.push({ a: from, b: to, subtype: r.subtype })
    }
  }
  for (const [childId, parents] of parentGroups) {
    const detail = db.getMember(childId)!
    db.updateMember(childId, { ...detail, parents: parents as never, spouses: detail.spouses.map((s) => ({ otherId: s.otherId, subtype: s.subtype as never })) })
  }
  for (const s of spousePairs) {
    const detail = db.getMember(s.a)!
    if (detail.spouses.some((x) => x.otherId === s.b)) continue
    db.updateMember(s.a, {
      ...detail,
      parents: detail.parents.map((p) => ({ otherId: p.otherId, subtype: p.subtype as never, isPrimary: p.isPrimary })),
      spouses: [...detail.spouses.map((x) => ({ otherId: x.otherId, subtype: x.subtype as never })), { otherId: s.b, subtype: s.subtype as never }],
    })
  }
  for (const z of data.zibei ?? []) {
    db.setPoem(z.branchId ? (branchMap.get(z.branchId) ?? null) : null, z.poem)
  }
  return rawMembers.length
}