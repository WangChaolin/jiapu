import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DataStore } from '../electron/main/store.ts'
import { createBackup, listBackups, verifyBackup, extractBackup, pruneAutoBackups, exportJson, importJson } from '../electron/main/backup.ts'
import { GenealogyDb } from '../electron/main/db.ts'

function tmpStore(): { store: DataStore; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jiapu-store-'))
  const store = new DataStore(path.join(root, 'config.json'), path.join(root, 'data'))
  return { store, root }
}

test('多谱创建、单开切换与计数', () => {
  const { store, root } = tmpStore()
  const a = store.createGenealogy({ name: '张氏家谱', hall: '百忍堂', surname: '张' })
  const b = store.createGenealogy({ name: '李氏家谱', surname: '李' })
  store.openGenealogy(a.id)
  store.current().createMember({ name: '张国栋', gender: '男' })
  assert.equal(store.currentId(), a.id)
  store.openGenealogy(b.id)
  assert.equal(store.currentId(), b.id)
  assert.equal(store.current().countMembers(), 0)
  const list = store.listGenealogies()
  assert.equal(list.length, 2)
  assert.equal(list.find((g) => g.id === a.id)!.memberCount, 1)
  store.dispose()
  fs.rmSync(root, { recursive: true, force: true })
})

test('数据目录自定义与迁移', () => {
  const { store, root } = tmpStore()
  const a = store.createGenealogy({ name: '张氏家谱' })
  store.openGenealogy(a.id)
  store.current().createMember({ name: '甲', gender: '男' })
  store.closeGenealogy()
  const newDir = path.join(root, 'custom-data')
  const bad = store.setDataDir(path.join(root, 'data'))
  assert.equal(bad.ok, true)
  const r = store.setDataDir(newDir)
  assert.equal(r.ok, true)
  assert.ok(r.migrated >= 1)
  assert.equal(store.getSettings().dataDir, newDir)
  assert.ok(fs.existsSync(path.join(newDir, 'registry.json')))
  assert.ok(fs.existsSync(path.join(newDir, a.id, 'genealogy.db')))
  assert.ok(fs.existsSync(path.join(root, 'data', a.id, 'genealogy.db')), '原目录保留')
  store.openGenealogy(a.id)
  assert.equal(store.current().countMembers(), 1)
  const again = store.setDataDir(path.join(root, 'data'))
  assert.equal(again.ok, true, '已有数据的目录可直接切换使用')
  assert.equal(again.migrated, 0)
  assert.equal(store.getSettings().dataDir, path.join(root, 'data'))
  store.openGenealogy(a.id)
  assert.equal(store.current().countMembers(), 1)
  store.dispose()
  fs.rmSync(root, { recursive: true, force: true })
})

test('删除家谱进回收站并可撤销', () => {
  const { store, root } = tmpStore()
  const a = store.createGenealogy({ name: '张氏家谱' })
  store.openGenealogy(a.id)
  store.current().createMember({ name: '甲', gender: '男' })
  const r = store.deleteGenealogy(a.id)
  assert.equal(r.name, '张氏家谱')
  assert.equal(store.listGenealogies().length, 0)
  assert.equal(store.currentId(), null)
  const restored = store.undoDelete(store.lastTrash()!)
  assert.equal(restored!.id, a.id)
  store.openGenealogy(a.id)
  assert.equal(store.current().countMembers(), 1)
  store.dispose()
  fs.rmSync(root, { recursive: true, force: true })
})

test('复制家谱独立', () => {
  const { store, root } = tmpStore()
  const a = store.createGenealogy({ name: '张氏家谱' })
  store.openGenealogy(a.id)
  store.current().createMember({ name: '甲', gender: '男' })
  const b = store.duplicateGenealogy(a.id, '张氏家谱（副本）')
  store.openGenealogy(b.id)
  assert.equal(store.current().countMembers(), 1)
  store.current().createMember({ name: '乙', gender: '女' })
  store.openGenealogy(a.id)
  assert.equal(store.current().countMembers(), 1)
  store.dispose()
  fs.rmSync(root, { recursive: true, force: true })
})

test('备份创建、校验、恢复与自动清理', () => {
  const { store, root } = tmpStore()
  const meta = store.createGenealogy({ name: '张氏家谱', hall: '百忍堂' })
  store.openGenealogy(meta.id)
  const db = store.current()
  const p = db.createMember({ name: '张国栋', gender: '男', birthDate: '1850-01-01' })
  db.createMember({ name: '张正仁', gender: '男', parents: [{ otherId: p.id, subtype: '生父' }] })
  db.setPoem(null, '国正天心顺')
  const cur = store.currentMeta()!
  const entry = createBackup(db, cur, store.genealogyDir(meta.id), store.backupRoot(), 'manual', '测试备份', '1.0.0')
  assert.ok(fs.existsSync(entry.file))
  assert.equal(entry.memberCount, 2)
  const v = verifyBackup(entry.file)
  assert.equal(v.ok, true)
  assert.equal(v.manifest!.genealogyName, '张氏家谱')

  db.createMember({ name: '张天德', gender: '男' })
  assert.equal(db.countMembers(), 3)
  store.closeGenealogy()
  extractBackup(entry.file, store.genealogyDir(meta.id))
  store.openGenealogy(meta.id)
  assert.equal(store.current().countMembers(), 2)
  assert.equal(store.current().listZibei()[0].poem, '国正天心顺')

  for (let i = 0; i < 5; i++) {
    createBackup(store.current(), store.currentMeta()!, store.genealogyDir(meta.id), store.backupRoot(), 'auto', `自动${i}`, '1.0.0')
  }
  const removed = pruneAutoBackups(store.backupRoot(), meta.id, 3)
  assert.equal(removed, 2)
  const autos = listBackups(store.backupRoot()).filter((b) => b.kind === 'auto')
  assert.equal(autos.length, 3)
  assert.equal(listBackups(store.backupRoot()).filter((b) => b.kind === 'manual').length, 1)
  store.dispose()
  fs.rmSync(root, { recursive: true, force: true })
})

test('损坏备份被拒绝', () => {
  const { root } = tmpStore()
  const bad = path.join(root, 'bad.zip')
  fs.writeFileSync(bad, 'not a zip')
  const v = verifyBackup(bad)
  assert.equal(v.ok, false)
  fs.rmSync(root, { recursive: true, force: true })
})

test('JSON 导出导入往返', () => {
  const { store, root } = tmpStore()
  const meta = store.createGenealogy({ name: '张氏家谱' })
  store.openGenealogy(meta.id)
  const db = store.current()
  const b = db.createBranch('长房', null, null, '备注')
  const p = db.createMember({ name: '张国栋', gender: '男', branchId: b.id, birthDate: '1850-01-01', biography: '始祖' })
  const w = db.createMember({ name: '王淑贞', gender: '女' })
  db.updateMember(p.id, { name: '张国栋', gender: '男', branchId: b.id, birthDate: '1850-01-01', biography: '始祖', spouses: [{ otherId: w.id, subtype: '原配' }] })
  db.createMember({ name: '张正仁', gender: '男', parents: [{ otherId: p.id, subtype: '生父' }, { otherId: w.id, subtype: '生母' }] })
  db.setPoem(null, '国正天心顺')
  const json = exportJson(db, store.currentMeta()!)
  store.closeGenealogy()

  const meta2 = store.createGenealogy({ name: '导入副本' })
  store.openGenealogy(meta2.id)
  const count = importJson(store.current(), json)
  assert.equal(count, 3)
  const db2 = store.current()
  assert.equal(db2.countMembers(), 3)
  assert.equal(db2.listBranches().length, 1)
  assert.equal(db2.listZibei()[0].poem, '国正天心顺')
  const list = db2.listMembers({ keyword: '张国栋' }).rows
  assert.equal(list.length, 1)
  const detail = db2.getMember(list[0].id)!
  assert.equal(detail.spouses.length, 1)
  assert.equal(detail.spouses[0].otherName, '王淑贞')
  assert.equal(detail.children.length, 1)
  assert.equal(detail.biography, '始祖')
  store.dispose()
  fs.rmSync(root, { recursive: true, force: true })
})

test('农历日期存取', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiapu-lunar-'))
  const db = new GenealogyDb(path.join(dir, 'g.db'))
  const m = db.createMember({ name: '测试', gender: '男', birthDate: '1950-01-05', birthLunar: true })
  const d = db.getMember(m.id)!
  assert.equal(d.birthLunar, true)
  assert.equal(d.birthDate, '1950-01-05')
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})