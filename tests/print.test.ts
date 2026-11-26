import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import type { Branch, GenealogyMeta, GraphData, Member, ZibeiPoem } from '../electron/shared/types.ts'
import type { PrintOptions, RosterField } from '../src/print/build.ts'

// Node's native TypeScript runner needs explicit extensions; the app bundler does not.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context) }
    catch (error) {
      if (/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
      throw error
    }
  },
})

const {
  buildPrintHtml, scopeIds, sortRosterMembers, normalizeRosterFields, rosterValues,
  planRosterPages, planBiographyPages, wrapPrintText, p1Metrics,
} = await import('../src/print/build.ts')

function member(id: string, name: string, patch: Partial<Member> = {}): Member {
  return {
    id, name, gender: '男', generation: 1, branchId: null,
    birthDate: '', birthLunar: false, deathDate: '', deathLunar: false, alive: true,
    birthOrder: 1, courtesyName: '', title: '', occupation: '', residence: '', burial: '',
    biography: '', remark: '', photoPath: '', createdAt: 1, updatedAt: 1,
    ...patch,
  }
}

const branches: Branch[] = [
  { id: 'root', name: '长房', parentId: null, founderId: 'a', founderName: '甲', note: '', memberCount: 2, createdAt: 1 },
  { id: 'child', name: '长房二支', parentId: 'root', founderId: 'b', founderName: '乙', note: '', memberCount: 1, createdAt: 1 },
  { id: 'other', name: '二房', parentId: null, founderId: 'c', founderName: '丙', note: '', memberCount: 1, createdAt: 1 },
]
const meta: GenealogyMeta = {
  id: 'g', name: '测试谱', hall: '堂', surname: '甲', origin: '', compiler: '', note: '',
  createdAt: 1, updatedAt: 1, memberCount: 4, lastOpenedAt: 1,
}
const members = [
  member('a', '甲', { generation: 1, branchId: 'root', birthOrder: 2, birthDate: '1900-01-01' }),
  member('b', '乙', { generation: 2, branchId: 'child', birthOrder: 1, gender: '女', residence: '杭州' }),
  member('c', '丙', { generation: 3, branchId: 'other', birthOrder: 1 }),
  member('d', '丁', { generation: 2, branchId: null, birthOrder: 3 }),
]
const data: GraphData = {
  members,
  edges: [
    { id: 'p1', type: 'parent_child', subtype: '生父', from: 'a', to: 'b', isPrimary: true },
    { id: 'p2', type: 'parent_child', subtype: '生父', from: 'b', to: 'c', isPrimary: true },
    { id: 's1', type: 'spouse', subtype: '原配', from: 'a', to: 'd', isPrimary: false },
  ],
}
const zibei: ZibeiPoem[] = [{
  branchId: 'child', branchName: '长房二支', poem: '德', entries: [
    { id: 'z1', branchId: 'child', generation: 2, char: '德', note: '' },
  ],
}]

function options(patch: Partial<PrintOptions> = {}): PrintOptions {
  return {
    layout: 'roster', scope: { kind: 'all' }, paper: 'A4', landscape: false,
    font: '宋体', fontSize: '小四', cover: false, toc: false, zibeiPage: false,
    rosterFields: ['name', 'gender', 'generation', 'branch', 'years'], rosterSort: 'generation',
    ...patch,
  }
}

test('PDF 范围支持整谱、支系子树、世代与勾选成员', () => {
  assert.equal(scopeIds(data, branches, { kind: 'all' }), undefined)
  assert.deepEqual([...scopeIds(data, branches, { kind: 'branch', branchId: 'root' })!].sort(), ['a', 'b'])
  assert.deepEqual([...scopeIds(data, branches, { kind: 'gen', from: 2, to: 2 })!].sort(), ['b', 'd'])
  assert.deepEqual([...scopeIds(data, branches, { kind: 'members', memberIds: ['d', 'b', 'missing', 'b'] })!].sort(), ['b', 'd'])
})

test('名录排序支持世代、行第、姓名、支系且结果稳定', () => {
  assert.deepEqual(sortRosterMembers(members, branches, 'generation').map((m) => m.id), ['a', 'b', 'd', 'c'])
  assert.deepEqual(sortRosterMembers(members, branches, 'birthOrder').map((m) => m.id), ['b', 'c', 'a', 'd'])
  const byName = sortRosterMembers(members, branches, 'name')
  for (let i = 1; i < byName.length; i++) assert.ok(byName[i - 1].name.localeCompare(byName[i].name, 'zh') <= 0)
  assert.deepEqual(sortRosterMembers(members, branches, 'branch').map((m) => m.id), ['a', 'b', 'c', 'd'])
  assert.deepEqual(sortRosterMembers(members, branches, 'generation'), sortRosterMembers(members, branches, 'generation'))
})

test('名录字段按固定顺序归一化，并读取字辈与亲属值', () => {
  assert.deepEqual(normalizeRosterFields(['years', 'name', 'invalid' as RosterField]), ['name', 'years'])
  assert.deepEqual(normalizeRosterFields([]), ['name'])
  const value = rosterValues(members[1], data, branches, zibei)
  assert.equal(value.zibei, '德')
  assert.match(value.parents, /甲/)
  assert.equal(value.residence, '杭州')
  assert.equal(value.burial, '')
})

test('名录分页一行一人，行不跨页且 HTML 每页重复表头', () => {
  const many = Array.from({ length: 90 }, (_, i) => member(`m${i}`, `成员${i}`, {
    generation: i % 6 + 1, birthOrder: i + 1, branchId: i % 2 ? 'root' : null,
  }))
  const graph: GraphData = { members: many, edges: [] }
  const opts = options({ fontSize: '小五', rosterFields: ['name', 'generation', 'branch'] })
  const plan = planRosterPages(graph, branches, [], many, opts)
  assert.ok(plan.pages.length > 1)
  const ids = plan.pages.flatMap((p) => p.rows.map((r) => r.id))
  assert.equal(ids.length, many.length)
  assert.equal(new Set(ids).size, many.length)
  const cap = Math.max(1, Math.floor((p1Metrics(opts).bodyH - plan.headerH) / plan.rowH))
  assert.ok(plan.pages.every((p) => p.rows.length <= cap))
  const html = buildPrintHtml(graph, meta, branches, [], opts, false).html
  assert.equal((html.match(/<table class="roster">/g) ?? []).length, plan.pages.length)
  assert.equal((html.match(/<thead>/g) ?? []).length, plan.pages.length)
  assert.equal((html.match(/<tr data-member-id=/g) ?? []).length, many.length)
})

test('长传记分页不丢失文本，标题与信息同页，章节标题不悬空', () => {
  const text = `${'生平内容，'.repeat(700)}\n第二段${'备注内容。'.repeat(120)}`
  const person = member('long', '张三', { biography: text, remark: '备&<注>', photoPath: 'photos/portrait.jpg' })
  const graph: GraphData = { members: [person, member('next', '李四')], edges: [] }
  const opts = options({ layout: 'biography', fontSize: '小五' })
  const pages = planBiographyPages(graph, branches, graph.members, opts)
  const first = pages.find((p) => p.memberId === 'long')!
  assert.equal(first.continuation, false)
  assert.ok(first.profile.length > 0)
  assert.equal(first.photo, true)
  assert.ok(pages.filter((p) => p.memberId === 'long').length > 1)
  for (const page of pages) {
    if (page.body.length) assert.equal(page.body[page.body.length - 1].section, false)
  }
  const bodyText = pages.filter((p) => p.memberId === 'long')
    .flatMap((p) => p.body.filter((l) => !l.section).map((l) => l.text)).join('')
  assert.equal(bodyText, wrapPrintText(text, p1Metrics(opts).bodyChars).join('') + '备&<注>')
  assert.equal(pages.find((p) => p.memberId === 'next')!.continuation, false)
})

test('HTML 安全转义，名录空值显示破折号，勾选范围生效', () => {
  const person = member('x', '<script>alert(1)</script>', { biography: '<img src=x onerror=alert(1)>' })
  const graph: GraphData = { members: [person], edges: [] }
  const opts = options({ scope: { kind: 'members', memberIds: ['x'] }, rosterFields: ['name', 'residence'] })
  const result = buildPrintHtml(graph, meta, branches, [], opts, true)
  assert.ok(!result.html.includes('<script>alert(1)</script>'))
  assert.ok(!result.html.includes('<img src=x onerror=alert(1)>'))
  assert.ok(result.html.includes('&lt;script&gt;'))
  assert.ok(result.html.includes('<td title="—">—</td>'))
  assert.match(result.summary, /勾選成員 1 人/)
})

test('新增排版不破坏原三种排版构建', () => {
  for (const layout of ['baota', 'oushi', 'sushi'] as const) {
    const result = buildPrintHtml(data, meta, branches, zibei, options({ layout }), false)
    assert.ok(result.html.startsWith('<!doctype html>'))
    assert.ok(result.volumes.length > 0)
  }
})
