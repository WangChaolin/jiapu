import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GenealogyDb } from '../electron/main/db.ts'

function tmpDb(): { db: GenealogyDb; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiapu-test-'))
  return { db: new GenealogyDb(path.join(dir, 'g.db')), dir }
}

test('成员创建与世代自动推导', () => {
  const { db, dir } = tmpDb()
  const g1 = db.createMember({ name: '张国栋', gender: '男' })
  assert.equal(g1.generation, 1)
  const g2 = db.createMember({ name: '张正仁', gender: '男', parents: [{ otherId: g1.id, subtype: '生父' }] })
  assert.equal(g2.generation, 2)
  const g3 = db.createMember({ name: '张天德', gender: '男', parents: [{ otherId: g2.id, subtype: '生父' }] })
  assert.equal(g3.generation, 3)
  const detail = db.getMember(g3.id)!
  assert.equal(detail.parents.length, 1)
  assert.equal(detail.parents[0].otherName, '张正仁')
  assert.equal(detail.parents[0].subtype, '生父')
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('循环关系检测', () => {
  const { db, dir } = tmpDb()
  const a = db.createMember({ name: '甲', gender: '男' })
  const b = db.createMember({ name: '乙', gender: '男', parents: [{ otherId: a.id, subtype: '生父' }] })
  assert.throws(() => db.updateMember(a.id, { name: '甲', gender: '男', parents: [{ otherId: b.id, subtype: '生父' }] }), /循环/)
  assert.throws(() => db.createMember({ name: '丙', gender: '男', parents: [{ otherId: b.id, subtype: '生父' }] }).id && db.updateMember(b.id, { name: '乙', gender: '男', parents: [{ otherId: b.id, subtype: '生父' }] }), /本人/)
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('兼祧与多父母、特殊关系子类型', () => {
  const { db, dir } = tmpDb()
  const f1 = db.createMember({ name: '张天德', gender: '男' })
  const f2 = db.createMember({ name: '张天佑', gender: '男' })
  const m1 = db.createMember({ name: '陈玉梅', gender: '女' })
  const child = db.createMember({
    name: '张心明', gender: '男',
    parents: [
      { otherId: f1.id, subtype: '生父' },
      { otherId: m1.id, subtype: '生母' },
      { otherId: f2.id, subtype: '兼祧父', isPrimary: false },
    ],
  })
  assert.equal(child.generation, 2)
  const d = db.getMember(child.id)!
  assert.equal(d.parents.length, 3)
  const jt = d.parents.find((p) => p.subtype === '兼祧父')!
  assert.equal(jt.isPrimary, false)
  assert.equal(jt.otherName, '张天佑')
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('配偶关系对称且可多段', () => {
  const { db, dir } = tmpDb()
  const h = db.createMember({ name: '张正仁', gender: '男' })
  const w1 = db.createMember({ name: '李秀兰', gender: '女' })
  const w2 = db.createMember({ name: '赵春娥', gender: '女' })
  db.updateMember(h.id, { name: '张正仁', gender: '男', spouses: [{ otherId: w1.id, subtype: '原配' }, { otherId: w2.id, subtype: '继配' }] })
  assert.equal(db.getMember(h.id)!.spouses.length, 2)
  assert.equal(db.getMember(w1.id)!.spouses[0].otherName, '张正仁')
  assert.equal(db.getMember(w2.id)!.spouses[0].subtype, '继配')
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('软删除与撤销恢复', () => {
  const { db, dir } = tmpDb()
  const p = db.createMember({ name: '父', gender: '男' })
  const c = db.createMember({ name: '子', gender: '男', parents: [{ otherId: p.id, subtype: '生父' }] })
  db.deleteMember(p.id)
  assert.equal(db.countMembers(), 1)
  assert.equal(db.getMember(p.id), null)
  assert.equal(db.getMember(c.id)!.parents.length, 0)
  assert.ok(db.restoreMember(p.id))
  assert.equal(db.countMembers(), 2)
  assert.equal(db.getMember(c.id)!.parents[0].otherName, '父')
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('字辈设置、推荐与支系继承', () => {
  const { db, dir } = tmpDb()
  db.setPoem(null, '国正天心顺，官清民自安')
  assert.equal(db.recommendedChar(1, null), '国')
  assert.equal(db.recommendedChar(5, null), '顺')
  const b = db.createBranch('二房', null, null, '')
  const b2 = db.createBranch('二房长支', b.id, null, '')
  db.setPoem(b.id, '国正天应允，家和万事兴')
  assert.equal(db.recommendedChar(4, b2.id), '应')
  assert.equal(db.recommendedChar(6, b2.id), '家')
  assert.equal(db.recommendedChar(4, null), '心')
  const poems = db.listZibei()
  assert.equal(poems.length, 2)
  assert.equal(poems[0].entries.length, 10)
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('支系树过滤与删除重分配', () => {
  const { db, dir } = tmpDb()
  const root = db.createBranch('长房', null, null, '')
  const child = db.createBranch('长房长支', root.id, null, '')
  const m1 = db.createMember({ name: '甲', gender: '男', branchId: root.id })
  const m2 = db.createMember({ name: '乙', gender: '男', branchId: child.id })
  assert.equal(db.listMembers({ branchId: root.id }).total, 2)
  assert.equal(db.listMembers({ branchId: child.id }).total, 1)
  db.deleteBranch(root.id)
  assert.equal(db.listBranches().length, 0)
  assert.equal(db.getMember(m1.id)!.branchId, null)
  assert.equal(db.getMember(m2.id)!.branchId, null)
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('筛选、统计与图谱数据', () => {
  const { db, dir } = tmpDb()
  const p = db.createMember({ name: '张国栋', gender: '男', birthDate: '1850-03-12' })
  db.createMember({ name: '张心兰', gender: '女', birthDate: '1928-06-01', parents: [{ otherId: p.id, subtype: '生父' }] })
  db.createMember({ name: '王淑贞', gender: '女', birthDate: '1852-01-01', alive: false })
  const s = db.stats()
  assert.equal(s.memberCount, 3)
  assert.equal(s.maleCount, 1)
  assert.equal(s.femaleCount, 2)
  assert.equal(s.aliveCount, 2)
  assert.equal(s.generations, 2)
  assert.equal(s.earliestYear, 1850)
  assert.equal(db.listMembers({ keyword: '心兰' }).total, 1)
  assert.equal(db.listMembers({ gender: '女' }).total, 2)
  assert.equal(db.listMembers({ aliveOnly: true }).total, 2)
  const g = db.graph()
  assert.equal(g.members.length, 3)
  assert.equal(g.edges.length, 1)
  assert.equal(g.edges[0].type, 'parent_child')
  assert.deepEqual(db.generations(), [1, 2])
  assert.ok(db.changeCount() > 0)
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('更新成员替换关系集', () => {
  const { db, dir } = tmpDb()
  const f = db.createMember({ name: '父', gender: '男' })
  const m = db.createMember({ name: '母', gender: '女' })
  const c = db.createMember({ name: '子', gender: '男', parents: [{ otherId: f.id, subtype: '生父' }] })
  db.updateMember(c.id, { name: '子', gender: '男', parents: [{ otherId: f.id, subtype: '生父' }, { otherId: m.id, subtype: '养母' }] })
  const d = db.getMember(c.id)!
  assert.equal(d.parents.length, 2)
  assert.equal(d.parents[1].subtype, '养母')
  db.updateMember(c.id, { name: '子', gender: '男', parents: [{ otherId: m.id, subtype: '生母' }] })
  assert.equal(db.getMember(c.id)!.parents.length, 1)
  assert.equal(db.getMember(c.id)!.parents[0].otherName, '母')
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('完整性校验与 VACUUM INTO 快照', () => {
  const { db, dir } = tmpDb()
  db.createMember({ name: '测试', gender: '男' })
  assert.ok(db.integrityCheck())
  const snap = path.join(dir, 'snap.db')
  db.vacuumInto(snap)
  const db2 = new GenealogyDb(snap)
  assert.equal(db2.countMembers(), 1)
  assert.ok(db2.integrityCheck())
  db2.close()
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('批量详情与单条详情一致且保序', () => {
  const { db, dir } = tmpDb()
  const f = db.createMember({ name: '张天德', gender: '男' })
  const u = db.createMember({ name: '张天佑', gender: '男' })
  const m = db.createMember({ name: '陈玉梅', gender: '女' })
  db.updateMember(f.id, { name: '张天德', gender: '男', spouses: [{ otherId: m.id, subtype: '原配' }] })
  const c = db.createMember({
    name: '张心明', gender: '男',
    parents: [{ otherId: f.id, subtype: '生父' }, { otherId: m.id, subtype: '生母' }, { otherId: u.id, subtype: '兼祧父', isPrimary: false }],
  })
  const ids = [c.id, m.id, f.id, u.id]
  const batch = db.getMembersDetails(ids)
  assert.deepEqual(batch.map((d) => d.id), ids)
  for (const id of ids) assert.deepEqual(batch.find((d) => d.id === id), db.getMember(id))
  assert.equal(batch[0].parents.length, 3)
  assert.equal(batch[0].parents.find((p) => p.subtype === '兼祧父')!.isPrimary, false)
  assert.equal(batch[2].children.length, 1)
  assert.equal(batch[2].children[0].otherName, '张心明')
  assert.equal(batch[2].children[0].otherGender, '男')
  assert.equal(batch[2].spouses[0].otherName, '陈玉梅')
  assert.deepEqual(db.getMembersDetails([]), [])
  db.deleteMember(u.id)
  const after = db.getMembersDetails([c.id, u.id])
  assert.deepEqual(after.map((d) => d.id), [c.id])
  assert.equal(after[0].parents.length, 2)
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})