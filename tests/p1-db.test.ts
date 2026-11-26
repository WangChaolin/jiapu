import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GenealogyDb } from '../electron/main/db.ts'

function withDb(fn: (db: GenealogyDb) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiapu-p1-'))
  const db = new GenealogyDb(path.join(dir, 'g.db'))
  try { fn(db) } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }) }
}

test('支系合并保留成员关系并可撤销', () => {
  withDb((db) => {
    const target = db.createBranch('长房', null, null, '')
    const a = db.createBranch('长房次支', target.id, null, '')
    const b = db.createBranch('长房三支', target.id, null, '')
    const founder = db.createMember({ name: '张正仁', gender: '男', branchId: a.id })
    const child = db.createBranch('次支东份', a.id, null, '')
    const m1 = db.createMember({ name: '张天德', gender: '男', branchId: a.id })
    const m2 = db.createMember({ name: '张天佑', gender: '男', branchId: child.id, parents: [{ otherId: founder.id, subtype: '生父' }] })
    const m3 = db.createMember({ name: '张天顺', gender: '男', branchId: b.id })
    db.updateBranch(a.id, a.name, a.parentId, founder.id, a.note)
    const beforeEdges = db.graph().edges.length
    const preview = db.previewBranchOperation({ kind: 'merge', sourceIds: [a.id, b.id], targetId: target.id })
    assert.equal(preview.memberCount, 4)
    assert.equal(preview.childBranchCount, 1)
    const result = db.runBranchOperation({ kind: 'merge', sourceIds: [a.id, b.id], targetId: target.id })
    assert.equal(db.listBranches().some((x) => x.id === a.id || x.id === b.id), false)
    assert.equal(db.listBranches().find((x) => x.id === child.id)?.parentId, target.id)
    assert.deepEqual([m1.id, m2.id, m3.id].map((id) => db.getMember(id)!.branchId), [target.id, target.id, target.id])
    assert.equal(db.graph().edges.length, beforeEdges)
    assert.equal(db.listBranches().find((x) => x.id === target.id)?.founderId, founder.id)
    assert.ok(db.undoOperation(result.operationId))
    assert.equal(db.getMember(m2.id)!.branchId, child.id)
    assert.equal(db.listBranches().find((x) => x.id === a.id)?.founderId, founder.id)
    assert.equal(db.undoOperation(result.operationId), false)
  })
})

test('支系拆分继承字辈并仅移动开基祖子孙', () => {
  withDb((db) => {
    const branch = db.createBranch('长房', null, null, '')
    const founder = db.createMember({ name: '张正仁', gender: '男', branchId: branch.id })
    const child = db.createMember({ name: '张天德', gender: '男', branchId: branch.id, parents: [{ otherId: founder.id, subtype: '生父' }] })
    const other = db.createMember({ name: '张正忠', gender: '男', branchId: branch.id })
    db.setPoem(branch.id, '国正天心顺')
    const result = db.runBranchOperation({ kind: 'split', branchId: branch.id, founderId: founder.id, name: '长房正仁支' })!
    assert.ok(result.branchId)
    assert.equal(db.getMember(founder.id)!.branchId, result.branchId)
    assert.equal(db.getMember(child.id)!.branchId, result.branchId)
    assert.equal(db.getMember(other.id)!.branchId, branch.id)
    assert.equal(db.recommendedChar(3, result.branchId!), '天')
    assert.ok(db.undoOperation(result.operationId))
    assert.equal(db.getMember(child.id)!.branchId, branch.id)
    assert.equal(db.listBranches().some((b) => b.id === result.branchId), false)
  })
})

test('成员批量迁移事务执行且可撤销', () => {
  withDb((db) => {
    const a = db.createBranch('长房', null, null, '')
    const b = db.createBranch('二房', null, null, '')
    const m1 = db.createMember({ name: '甲', gender: '男', branchId: a.id })
    const m2 = db.createMember({ name: '乙', gender: '女', branchId: a.id })
    const result = db.runBranchOperation({ kind: 'migrate', memberIds: [m1.id, m2.id], targetBranchId: b.id })
    assert.equal(db.getMember(m1.id)!.branchId, b.id)
    assert.equal(db.getMember(m2.id)!.branchId, b.id)
    assert.ok(db.undoOperation(result.operationId))
    assert.equal(db.getMember(m1.id)!.branchId, a.id)
    assert.equal(db.getMember(m2.id)!.branchId, a.id)
  })
})

test('查重候选、成员合并去重关系与撤销', () => {
  withDb((db) => {
    const father = db.createMember({ name: '张天佑', gender: '男' })
    const mother = db.createMember({ name: '周桂英', gender: '女' })
    const a = db.createMember({ name: '张心兰', gender: '女', birthDate: '1930-05-12', biography: '生平一', remark: '备注一', parents: [{ otherId: father.id, subtype: '生父' }, { otherId: mother.id, subtype: '生母' }] })
    const b = db.createMember({ name: '张心兰', gender: '女', birthDate: '1930-05-12', biography: '生平二', remark: '备注二', parents: [{ otherId: father.id, subtype: '生父' }, { otherId: mother.id, subtype: '生母' }] })
    const groups = db.findDuplicateMembers()
    assert.equal(groups.length, 1)
    assert.equal(groups[0].members.length, 2)
    const result = db.mergeMembers({ targetId: a.id, sourceIds: [b.id], fieldSources: { birthDate: b.id }, mergeTextFields: true })
    assert.equal(db.getMember(b.id), null)
    const merged = db.getMember(a.id)!
    assert.equal(merged.birthDate, '1930-05-12')
    assert.equal(merged.parents.length, 2)
    assert.match(merged.biography, /生平一/)
    assert.match(merged.biography, /生平二/)
    assert.ok(db.undoOperation(result.operationId))
    assert.ok(db.getMember(b.id))
    assert.equal(db.getMember(a.id)!.parents.length, 2)
    assert.equal(db.getMember(b.id)!.parents.length, 2)
  })
})

test('查重不将同辈仅一字之差的姓名视为重复', () => {
  withDb((db) => {
    const father = db.createMember({ name: '张天佑', gender: '男' })
    const mother = db.createMember({ name: '周桂英', gender: '女' })
    const parents = [{ otherId: father.id, subtype: '生父' as const }, { otherId: mother.id, subtype: '生母' as const }]
    const a = db.createMember({ name: '张心兰', gender: '女', generation: 2, birthDate: '1930-05-12', parents })
    db.createMember({ name: '张心明', gender: '男', generation: 2, birthDate: '1930-05-12', parents })
    assert.equal(db.findDuplicateMembers().length, 0)
    const duplicate = db.createMember({ name: '张心兰', gender: '女', generation: 2, birthDate: '1930-05-12', parents })
    const groups = db.findDuplicateMembers()
    assert.equal(groups.length, 1)
    assert.deepEqual(groups[0].members.map((m) => m.id).sort(), [a.id, duplicate.id].sort())
  })
})

test('禁止支系合并到自己的后代', () => {
  withDb((db) => {
    const root = db.createBranch('长房', null, null, '')
    const child = db.createBranch('长房长支', root.id, null, '')
    assert.throws(() => db.runBranchOperation({ kind: 'merge', sourceIds: [root.id, child.id], targetId: child.id }), /下级支系/)
    assert.equal(db.listBranches().length, 2)
  })
})
