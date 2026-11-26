import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GenealogyMeta, GraphData, GraphOrientation, GraphPngOptions, Member } from '../electron/shared/types.ts'
import { computeLayout, NODE_H, NODE_W, type Layout } from '../src/graph/layout.ts'
import { buildGraphPngSvg, MAX_GRAPH_DIMENSION, MAX_GRAPH_PIXELS } from '../src/graph/png.ts'

function member(id: string, name: string, generation: number, birthOrder = 1, gender: Member['gender'] = '男'): Member {
  return {
    id, name, gender, generation, branchId: null,
    birthDate: '', birthLunar: false, deathDate: '', deathLunar: false, alive: true,
    birthOrder, courtesyName: '', title: '', occupation: '', residence: '', burial: '',
    biography: '', remark: '', photoPath: '', createdAt: 0, updatedAt: 0,
  }
}

function graphFixture(): GraphData {
  return {
    members: [
      member('a', '甲', 1), member('s', '甲配', 1, 1, '女'),
      member('x', '特殊父', 1), member('b', '乙', 2, 1),
      member('t', '乙配', 2, 1, '女'), member('c', '丙', 2, 2),
      member('d', '丁', 3), member('e', '丁配', 3, 1, '女'),
    ],
    edges: [
      { id: 'as', type: 'spouse', subtype: '原配', from: 'a', to: 's', isPrimary: false },
      { id: 'ab', type: 'parent_child', subtype: '生父', from: 'a', to: 'b', isPrimary: true },
      { id: 'xb', type: 'parent_child', subtype: '继父', from: 'x', to: 'b', isPrimary: false },
      { id: 'ac', type: 'parent_child', subtype: '生父', from: 'a', to: 'c', isPrimary: true },
      { id: 'bt', type: 'spouse', subtype: '原配', from: 'b', to: 't', isPrimary: false },
      { id: 'bd', type: 'parent_child', subtype: '生父', from: 'b', to: 'd', isPrimary: true },
      { id: 'de', type: 'spouse', subtype: '原配', from: 'd', to: 'e', isPrimary: false },
    ],
  }
}

function meta(name = '测试谱'): GenealogyMeta {
  return {
    id: 'g', name, hall: '', surname: '', origin: '', compiler: '', note: '',
    createdAt: 0, updatedAt: 0, memberCount: 0, lastOpenedAt: 0,
  }
}

function pngOptions(patch: Partial<GraphPngOptions> = {}): GraphPngOptions {
  return {
    orientation: 'vertical', scope: 'visible', scale: 1, background: 'transparent',
    legend: false, title: false, timestamp: false,
    visibleIds: ['a', 's', 'x', 'b', 't', 'c', 'd', 'e'],
    viewBox: { x: 10, y: 20, width: 320, height: 180 },
    ...patch,
  }
}

function assertNoOverlap(layout: Layout): void {
  for (let i = 0; i < layout.nodes.length; i++) {
    for (let j = i + 1; j < layout.nodes.length; j++) {
      const a = layout.nodes[i], b = layout.nodes[j]
      const overlap = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
      assert.equal(overlap, false, `${a.id} 与 ${b.id} 重叠`)
    }
  }
}

test('纵向布局保持世代、兄弟与配偶的轴向，并生成亲子和特殊关系边', () => {
  const data = graphFixture()
  const layout = computeLayout(data, new Set())
  assert.deepEqual(layout, computeLayout(data, new Set(), undefined, 'vertical'))
  const a = layout.nodeMap.get('a')!, b = layout.nodeMap.get('b')!, c = layout.nodeMap.get('c')!
  const s = layout.nodeMap.get('s')!, t = layout.nodeMap.get('t')!, d = layout.nodeMap.get('d')!
  assert.ok(a.y < b.y && b.y < d.y)
  assert.equal(b.y, c.y)
  assert.notEqual(b.x, c.x)
  assert.equal(a.y, s.y)
  assert.equal(s.x - (a.x + NODE_W), 8)
  assert.equal(b.y, t.y)
  assert.equal(t.x - (b.x + NODE_W), 8)
  assert.ok(layout.edges.some((edge) => edge.id === 'pe-a-b' && edge.kind === 'line' && edge.path.includes(' V ')))
  assert.ok(layout.edges.some((edge) => edge.id === 'se-xb' && edge.kind === 'dashed'))
  assert.ok(layout.edges.some((edge) => edge.id === 'sp-as' && edge.kind === 'spouse' && edge.path.includes(' H ')))
  assertNoOverlap(layout)
})

test('横向布局世代沿 X、兄弟沿 Y，配偶竖直相邻且连线方向正确', () => {
  const layout = computeLayout(graphFixture(), new Set(), undefined, 'horizontal')
  const a = layout.nodeMap.get('a')!, b = layout.nodeMap.get('b')!, c = layout.nodeMap.get('c')!
  const s = layout.nodeMap.get('s')!, t = layout.nodeMap.get('t')!, d = layout.nodeMap.get('d')!
  assert.ok(a.x < b.x && b.x < d.x)
  assert.equal(b.x, c.x)
  assert.notEqual(b.y, c.y)
  assert.equal(a.x, s.x)
  assert.equal(s.y - (a.y + NODE_H), 8)
  assert.equal(b.x, t.x)
  assert.equal(t.y - (b.y + NODE_H), 8)
  assert.ok(layout.edges.some((edge) => edge.id === 'pe-a-b' && edge.kind === 'line' && edge.path.includes(' H ') && edge.path.includes(' V ')))
  assert.ok(layout.edges.some((edge) => edge.id === 'se-xb' && edge.kind === 'dashed' && edge.path.includes(' C ')))
  assert.ok(layout.edges.some((edge) => edge.id === 'sp-as' && edge.kind === 'spouse' && edge.path.includes(' V ')))
  assertNoOverlap(layout)
})

test('横纵布局折叠均隐藏后代及配偶，并准确报告隐藏节点数', () => {
  for (const orientation of ['vertical', 'horizontal'] as GraphOrientation[]) {
    const layout = computeLayout(graphFixture(), new Set(['b']), undefined, orientation)
    const b = layout.nodeMap.get('b')!
    assert.equal(b.collapsed, true)
    assert.equal(b.hiddenCount, 2)
    assert.equal(layout.nodeMap.has('d'), false)
    assert.equal(layout.nodeMap.has('e'), false)
    assert.equal(layout.nodeMap.has('c'), true)
    assert.equal(layout.edges.some((edge) => edge.id === 'pe-b-d'), false)
    assert.equal(layout.edges.some((edge) => edge.id === 'sp-de'), false)
    assertNoOverlap(layout)

    const leaf = computeLayout(graphFixture(), new Set(['d']), undefined, orientation).nodeMap.get('d')!
    assert.equal(leaf.collapsed, false)
    assert.equal(leaf.hiddenCount, 0)
  }
})

test('非相邻配偶在横纵布局中都生成绕行连线', () => {
  const data: GraphData = {
    members: [member('p', '父', 1), member('r', '另支配偶', 1), member('rp', '另支父', 0), member('pc', '子', 2), member('rc', '另支子', 2)],
    edges: [
      { id: 'pr', type: 'spouse', subtype: '原配', from: 'p', to: 'r', isPrimary: false },
      { id: 'ppc', type: 'parent_child', subtype: '生父', from: 'p', to: 'pc', isPrimary: true },
      { id: 'rprc', type: 'parent_child', subtype: '生父', from: 'r', to: 'rc', isPrimary: true },
      { id: 'rpr', type: 'parent_child', subtype: '生父', from: 'rp', to: 'r', isPrimary: true },
    ],
  }
  for (const orientation of ['vertical', 'horizontal'] as GraphOrientation[]) {
    const layout = computeLayout(data, new Set(), undefined, orientation)
    const edge = layout.edges.find((item) => item.id === 'sp-pr')
    assert.equal(edge?.kind, 'spouseCross')
    assert.equal(edge?.from, 'p')
    assert.equal(edge?.to, 'r')
    assertNoOverlap(layout)
  }
})

test('PNG SVG 按 visibleIds 裁剪节点和边，并区分 viewport 与 visible 边界及倍率', () => {
  const data = graphFixture()
  const ids = ['a', 's', 'b', 't']
  const viewport = buildGraphPngSvg(data, meta(), pngOptions({ scope: 'viewport', scale: 2, visibleIds: ids }))
  assert.equal(viewport.width, 640)
  assert.equal(viewport.height, 360)
  assert.match(viewport.svg, /viewBox="10 20 320 180"/)
  assert.match(viewport.svg, /data-node-id="a"/)
  assert.match(viewport.svg, /data-node-id="t"/)
  assert.doesNotMatch(viewport.svg, /data-node-id="[xcde]"/)
  assert.match(viewport.svg, /pe-a-b/)
  assert.doesNotMatch(viewport.svg, /pe-a-c|se-xb|pe-b-d/)

  const scoped = computeLayout(data, new Set(), new Set(ids))
  const visible = buildGraphPngSvg(data, meta(), pngOptions({ visibleIds: ids }))
  assert.equal(visible.width, scoped.width)
  assert.equal(visible.height, scoped.height)
  assert.match(visible.svg, new RegExp(`viewBox="0 0 ${scoped.width} ${scoped.height}"`))
  assert.doesNotMatch(visible.svg, /viewBox="10 20 320 180"/)
})

test('PNG SVG 转义谱名、节点文本和属性，并按选项输出标题、图例、时间与背景', () => {
  const data = graphFixture()
  data.members[0].name = '张<&"\'三'
  const genealogy = meta('赵<&"\'谱')
  genealogy.hall = '堂<&>'
  const all = buildGraphPngSvg(data, genealogy, pngOptions({ title: true, legend: true, timestamp: true, background: 'rice' }))
  assert.match(all.svg, /赵&lt;&amp;&quot;&#39;谱/)
  assert.match(all.svg, /张&lt;&amp;&quot;&#39;三/)
  assert.match(all.svg, /堂&lt;&amp;&gt;/)
  assert.doesNotMatch(all.svg, /赵<&"'谱/)
  assert.match(all.svg, /data-background="rice"[^>]*fill="#fbf7ec"/)
  assert.match(all.svg, /血缘世系/)
  assert.match(all.svg, /导出时间：/)

  const minimal = buildGraphPngSvg(data, genealogy, pngOptions({ background: 'transparent' }))
  assert.doesNotMatch(minimal.svg, /data-background=/)
  assert.doesNotMatch(minimal.svg, /赵/)
  assert.doesNotMatch(minimal.svg, /血缘世系|导出时间：/)

  const white = buildGraphPngSvg(data, genealogy, pngOptions({ background: 'white' }))
  assert.match(white.svg, /data-background="white"[^>]*fill="#ffffff"/)
})

test('PNG SVG 拒绝无效视口、非法倍率与超大输出尺寸', () => {
  const data = graphFixture()
  assert.throws(() => buildGraphPngSvg(data, meta(), pngOptions({ scope: 'viewport', viewBox: { x: 0, y: 0, width: 0, height: 100 } })), /视口尺寸无效/)
  assert.throws(() => buildGraphPngSvg(data, meta(), pngOptions({ scale: 3 as 1 })), /倍率/)
  assert.throws(() => buildGraphPngSvg(data, meta(), pngOptions({ scope: 'viewport', scale: 4, viewBox: { x: 0, y: 0, width: 9000, height: 9000 } })), /尺寸过大/)
  assert.throws(() => buildGraphPngSvg(data, meta(), pngOptions({ scope: 'viewport', viewBox: { x: 0, y: 0, width: 20000, height: 20000 } })), /尺寸过大/)
  assert.ok(MAX_GRAPH_DIMENSION > 0 && MAX_GRAPH_PIXELS > 0)
})
