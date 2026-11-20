import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DataStore } from './store.ts'
import {
  createBackup, listBackups, verifyBackup, extractBackup, pruneAutoBackups, exportJson, importJson,
} from './backup.ts'
import { seedDemo } from './seed.ts'
import { buildPdf, type PdfPayload } from './pdf.ts'
import type { AppSettings, MemberFilter, MemberInput } from '../shared/types'

export function registerPhotoProtocol(store: DataStore): void {
  protocol.handle('jpimg', (request) => {
    const url = new URL(request.url)
    const genealogyId = url.hostname
    const rel = decodeURIComponent(url.pathname.replace(/^\//, ''))
    const full = store.resolvePhoto(genealogyId, rel)
    if (!full) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(full).toString())
  })
}

function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

export function registerIpc(store: DataStore, getWin: () => BrowserWindow | null): void {
  const version = app.getVersion()

  const autoBackupIfNeeded = (note: string): void => {
    const s = store.getSettings()
    if (!s.autoBackup) return
    const meta = store.currentMeta()
    if (!meta) return
    const existing = listBackups(store.backupRoot()).filter((b) => b.genealogyId === meta.id && b.kind === 'auto')
    const today = existing.find((b) => todayKey() === `${new Date(b.createdAt).getFullYear()}-${new Date(b.createdAt).getMonth() + 1}-${new Date(b.createdAt).getDate()}` && b.note === note)
    if (today) return
    try {
      createBackup(store.current(), meta, store.genealogyDir(meta.id), store.backupRoot(), 'auto', note, version)
      pruneAutoBackups(store.backupRoot(), meta.id, s.autoBackupKeep)
    } catch { /* auto backup must never block opening */ }
  }

  // ---------- app & settings ----------
  ipcMain.handle('app:info', () => ({
    version, dataDir: store.getSettings().dataDir, configPath: path.dirname(app.getPath('userData')),
    platform: process.platform,
  }))
  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:update', (_e, patch: Partial<Omit<AppSettings, 'dataDir'>>) => store.updateSettings(patch))
  ipcMain.handle('settings:checkDataDir', (_e, dir: string) => store.checkDataDir(dir))
  ipcMain.handle('settings:setDataDir', (_e, dir: string) => store.setDataDir(dir))
  ipcMain.handle('settings:chooseDir', async () => {
    const win = getWin()
    const r = await dialog.showOpenDialog(win!, {
      title: '选择数据存储目录', properties: ['openDirectory', 'createDirectory'],
      defaultPath: store.getSettings().dataDir,
    })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('settings:revealDataDir', () => shell.openPath(store.getSettings().dataDir))

  // ---------- genealogy ----------
  ipcMain.handle('genealogy:list', () => store.listGenealogies())
  ipcMain.handle('genealogy:create', (_e, input) => store.createGenealogy(input))
  ipcMain.handle('genealogy:seedDemo', () => {
    const meta = store.createGenealogy({
      name: '张氏家谱', hall: '百忍堂', surname: '张', origin: '山东清河',
      compiler: '张氏修谱委员会', note: '示例数据，可自由编辑或删除',
    })
    store.openGenealogy(meta.id)
    seedDemo(store.current())
    return store.currentMeta()
  })
  ipcMain.handle('genealogy:open', (_e, id: string) => {
    const meta = store.openGenealogy(id)
    autoBackupIfNeeded('打开时自动备份')
    return meta
  })
  ipcMain.handle('genealogy:close', () => { store.closeGenealogy(); return true })
  ipcMain.handle('genealogy:current', () => store.currentMeta())
  ipcMain.handle('genealogy:updateMeta', (_e, id: string, patch) => { store.updateGenealogyMeta(id, patch); return store.currentMeta() })
  ipcMain.handle('genealogy:delete', (_e, id: string) => {
    const r = store.deleteGenealogy(id)
    return { ...r, trashName: store.lastTrash() }
  })
  ipcMain.handle('genealogy:undoDelete', () => store.undoDelete(store.lastTrash() ?? ''))
  ipcMain.handle('genealogy:duplicate', (_e, id: string, newName: string) => store.duplicateGenealogy(id, newName))
  ipcMain.handle('genealogy:stats', () => store.current().stats())

  // ---------- members ----------
  ipcMain.handle('member:list', (_e, filter: MemberFilter) => store.current().listMembers(filter))
  ipcMain.handle('member:get', (_e, id: string) => store.current().getMember(id))
  ipcMain.handle('member:getMany', (_e, ids: string[]) => store.current().getMembersDetails(ids))
  ipcMain.handle('member:create', (_e, input: MemberInput) => {
    const m = store.current().createMember(input)
    return store.current().getMember(m.id)
  })
  ipcMain.handle('member:update', (_e, id: string, input: MemberInput) => store.current().updateMember(id, input))
  ipcMain.handle('member:delete', (_e, id: string) => store.current().deleteMember(id))
  ipcMain.handle('member:restore', (_e, id: string) => store.current().restoreMember(id))
  ipcMain.handle('member:generations', () => store.current().generations())
  ipcMain.handle('member:recommendedChar', (_e, generation: number, branchId: string | null) =>
    store.current().recommendedChar(generation, branchId))
  ipcMain.handle('member:choosePhoto', async () => {
    const r = await dialog.showOpenDialog(getWin()!, {
      title: '选择照片', properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] }],
    })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('member:savePhoto', (_e, sourcePath: string) => {
    const id = store.currentId()
    if (!id) throw new Error('尚未打开家谱')
    return store.savePhoto(id, sourcePath)
  })

  // ---------- graph ----------
  ipcMain.handle('graph:data', () => store.current().graph())

  // ---------- zibei ----------
  ipcMain.handle('zibei:list', () => store.current().listZibei())
  ipcMain.handle('zibei:setPoem', (_e, branchId: string | null, poem: string, startGen: number) => {
    store.current().setPoem(branchId, poem, startGen)
    return store.current().listZibei()
  })

  // ---------- branches ----------
  ipcMain.handle('branch:list', () => store.current().listBranches())
  ipcMain.handle('branch:create', (_e, name: string, parentId: string | null, founderId: string | null, note: string) =>
    store.current().createBranch(name, parentId, founderId, note))
  ipcMain.handle('branch:update', (_e, id: string, name: string, parentId: string | null, founderId: string | null, note: string) => {
    store.current().updateBranch(id, name, parentId, founderId, note)
    return store.current().listBranches()
  })
  ipcMain.handle('branch:delete', (_e, id: string) => {
    store.current().deleteBranch(id)
    return store.current().listBranches()
  })

  // ---------- backup ----------
  ipcMain.handle('backup:list', () => listBackups(store.backupRoot()))
  ipcMain.handle('backup:create', (_e, note: string) => {
    const meta = store.currentMeta()
    if (!meta) throw new Error('尚未打开家谱')
    const entry = createBackup(store.current(), meta, store.genealogyDir(meta.id), store.backupRoot(), 'manual', note, version)
    return entry
  })
  ipcMain.handle('backup:verify', (_e, file: string) => verifyBackup(file))
  ipcMain.handle('backup:delete', (_e, file: string) => {
    const root = path.resolve(store.backupRoot())
    const full = path.resolve(file)
    if (!full.startsWith(root + path.sep)) throw new Error('非法路径')
    fs.unlinkSync(full)
    return listBackups(store.backupRoot())
  })
  ipcMain.handle('backup:chooseZip', async () => {
    const r = await dialog.showOpenDialog(getWin()!, {
      title: '选择备份文件', properties: ['openFile'],
      filters: [{ name: '家谱备份', extensions: ['zip'] }],
    })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('backup:restore', (_e, file: string, asNewName: string | null) => {
    const v = verifyBackup(file)
    if (!v.ok || !v.manifest) return { ok: false, message: v.message, genealogyId: '', genealogyName: '' }
    const m = v.manifest
    const s = store.getSettings()
    const wasOpen = store.currentId() === m.genealogyId
    if (wasOpen) {
      const cur = store.currentMeta()!
      createBackup(store.current(), cur, store.genealogyDir(cur.id), store.backupRoot(), 'auto', '恢复前自动备份', version)
      pruneAutoBackups(store.backupRoot(), cur.id, s.autoBackupKeep)
      store.closeGenealogy()
    }
    let targetId = m.genealogyId
    let targetName = m.genealogyName
    if (asNewName) {
      const created = store.createGenealogy({ name: asNewName, hall: m.hall, surname: m.surname })
      targetId = created.id
      targetName = created.name
    } else if (!store.listGenealogies().some((g) => g.id === m.genealogyId)) {
      const created = store.createGenealogy({ name: m.genealogyName, hall: m.hall, surname: m.surname })
      targetId = created.id
      targetName = created.name
    }
    extractBackup(file, store.genealogyDir(targetId))
    store.updateGenealogyMeta(targetId, { name: targetName, hall: m.hall, surname: m.surname })
    if (wasOpen || asNewName) store.openGenealogy(targetId)
    return { ok: true, genealogyId: targetId, genealogyName: targetName }
  })
  ipcMain.handle('backup:exportJson', async () => {
    const meta = store.currentMeta()
    if (!meta) throw new Error('尚未打开家谱')
    const r = await dialog.showSaveDialog(getWin()!, {
      title: '导出 JSON', defaultPath: `${meta.name}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (r.canceled || !r.filePath) return null
    fs.writeFileSync(r.filePath, exportJson(store.current(), meta), 'utf-8')
    return r.filePath
  })
  ipcMain.handle('backup:chooseJson', async () => {
    const r = await dialog.showOpenDialog(getWin()!, {
      title: '选择 JSON 文件', properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('backup:importJson', (_e, file: string, newName: string) => {
    const json = fs.readFileSync(file, 'utf-8')
    const created = store.createGenealogy({ name: newName })
    store.openGenealogy(created.id)
    try {
      const count = importJson(store.current(), json)
      return { ok: true, count, meta: store.currentMeta() }
    } catch (e) {
      store.closeGenealogy()
      store.deleteGenealogy(created.id)
      return { ok: false, message: (e as Error).message }
    }
  })

  // ---------- PDF ----------
  ipcMain.handle('pdf:save', async (_e, payload: PdfPayload, defaultName: string) => {
    const autoOut = process.env['JIAPU_PDF_OUT']
    let filePath: string
    if (autoOut) {
      filePath = autoOut
    } else {
      const r = await dialog.showSaveDialog(getWin()!, {
        title: '导出 PDF', defaultPath: `${defaultName}.pdf`,
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      })
      if (r.canceled || !r.filePath) return null
      filePath = r.filePath
    }
    const bytes = await buildPdf(payload)
    fs.writeFileSync(filePath, bytes)
    return filePath
  })

  // ---------- window ----------
  ipcMain.handle('window:setTitle', (_e, title: string) => { getWin()?.setTitle(title) })
}