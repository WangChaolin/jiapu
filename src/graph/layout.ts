import type { GraphData, Member } from '@shared/types'

export const NODE_W = 94
export const NODE_H = 42
export const LEVEL_H = 96
const SIB_GAP = 16
const COUPLE_GAP = 8
const TREE_GAP = 32
const PAD = 30

export interface LayoutNode {
  id: string
  member: Member
  x: number
  y: number
  w: number
  h: number
  role: 'anchor' | 'spouse'
  collapsed: boolean
  hiddenCount: number
  childCount: number
}

export interface LayoutEdge {
  id: string
  kind: 'line' | 'dashed' | 'spouse' | 'spouseCross'
  path: string
  from: string
  to: string
}

export interface Layout {
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  width: number
  height: number
  nodeMap: Map<string, LayoutNode>
}

const SUBTYPE_ORDER = ['生父', '生母', '养父', '养母', '继父', '继母', '嗣父（过继）', '嗣母（过继）', '兼祧父', '兼祧母']

export function descendantSet(data: GraphData, rootId: string): Set<string> {
  const childrenOf = new Map<string, string[]>()
  for (const e of data.edges) {
    if (e.type !== 'parent_child') continue
    if (!childrenOf.has(e.from)) childrenOf.set(e.from, [])
    childrenOf.get(e.from)!.push(e.to)
  }
  const seen = new Set<string>([rootId])
  const queue = [rootId]
  while (queue.length) {
    const cur = queue.pop()!
    for (const c of childrenOf.get(cur) ?? []) if (!seen.has(c)) { seen.add(c); queue.push(c) }
  }
  return withSpouses(data, seen)
}

export function ancestorSet(data: GraphData, rootId: string): Set<string> {
  const parentsOf = new Map<string, string[]>()
  for (const e of data.edges) {
    if (e.type !== 'parent_child') continue
    if (!parentsOf.has(e.to)) parentsOf.set(e.to, [])
    parentsOf.get(e.to)!.push(e.from)
  }
  const seen = new Set<string>([rootId])
  const queue = [rootId]
  while (queue.length) {
    const cur = queue.pop()!
    for (const p of parentsOf.get(cur) ?? []) if (!seen.has(p)) { seen.add(p); queue.push(p) }
  }
  return withSpouses(data, seen)
}

function withSpouses(data: GraphData, base: Set<string>): Set<string> {
  const out = new Set(base)
  for (const e of data.edges) {
    if (e.type !== 'spouse') continue
    if (base.has(e.from)) out.add(e.to)
    if (base.has(e.to)) out.add(e.from)
  }
  return out
}

export interface Tree {
  members: Member[]
  byId: Map<string, Member>
  primaryParent: Map<string, string>
  secondaryParents: Map<string, { from: string; subtype: string; id: string }[]>
  childrenOf: Map<string, string[]>
  spousePairs: { id: string; a: string; b: string; subtype: string }[]
  spousesOf: Map<string, string[]>
  roots: string[]
}

export function buildTree(data: GraphData, scope?: Set<string>): Tree {
  const members = data.members.filter((m) => !scope || scope.has(m.id))
  const ids = new Set(members.map((m) => m.id))
  const byId = new Map(members.map((m) => [m.id, m]))
  const parentEdges = new Map<string, { from: string; subtype: string; isPrimary: boolean; id: string }[]>()
  const spousesOf = new Map<string, string[]>()
  const spousePairs: Tree['spousePairs'] = []
  const seenPair = new Set<string>()
  for (const e of data.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue
    if (e.type === 'parent_child') {
      if (!parentEdges.has(e.to)) parentEdges.set(e.to, [])
      parentEdges.get(e.to)!.push({ from: e.from, subtype: e.subtype, isPrimary: e.isPrimary, id: e.id })
    } else {
      if (!spousesOf.has(e.from)) spousesOf.set(e.from, [])
      if (!spousesOf.has(e.to)) spousesOf.set(e.to, [])
      spousesOf.get(e.from)!.push(e.to)
      spousesOf.get(e.to)!.push(e.from)
      if (!seenPair.has(e.id)) { seenPair.add(e.id); spousePairs.push({ id: e.id, a: e.from, b: e.to, subtype: e.subtype }) }
    }
  }
  const primaryParent = new Map<string, string>()
  const secondaryParents = new Map<string, { from: string; subtype: string; id: string }[]>()
  for (const [child, ps] of parentEdges) {
    const sorted = [...ps].sort((a, b) => {
      const ap = a.isPrimary ? 0 : 1, bp = b.isPrimary ? 0 : 1
      if (ap !== bp) return ap - bp
      return SUBTYPE_ORDER.indexOf(a.subtype) - SUBTYPE_ORDER.indexOf(b.subtype)
    })
    primaryParent.set(child, sorted[0].from)
    secondaryParents.set(child, sorted.slice(1).map((p) => ({ from: p.from, subtype: p.subtype, id: p.id })))
  }
  const childrenOf = new Map<string, string[]>()
  for (const [child, parent] of primaryParent) {
    if (!childrenOf.has(parent)) childrenOf.set(parent, [])
    childrenOf.get(parent)!.push(child)
  }
  const sortSibs = (a: string, b: string): number => {
    const ma = byId.get(a)!, mb = byId.get(b)!
    if (ma.generation !== mb.generation) return ma.generation - mb.generation
    if (ma.birthOrder !== mb.birthOrder) return ma.birthOrder - mb.birthOrder
    return ma.name.localeCompare(mb.name, 'zh')
  }
  for (const list of childrenOf.values()) list.sort(sortSibs)
  const roots = members.filter((m) => !primaryParent.has(m.id)).map((m) => m.id).sort(sortSibs)
  return { members, byId, primaryParent, secondaryParents, childrenOf, spousePairs, spousesOf, roots }
}

export function computeLayout(data: GraphData, collapsed: Set<string>, scope?: Set<string>): Layout {
  const { members, byId, primaryParent, secondaryParents, childrenOf, spousePairs, spousesOf, roots: allRoots } = buildTree(data, scope)
  const hasChildren = (id: string): boolean => (childrenOf.get(id)?.length ?? 0) > 0
  const sortSibs = (a: string, b: string): number => {
    const ma = byId.get(a)!, mb = byId.get(b)!
    if (ma.generation !== mb.generation) return ma.generation - mb.generation
    if (ma.birthOrder !== mb.birthOrder) return ma.birthOrder - mb.birthOrder
    return ma.name.localeCompare(mb.name, 'zh')
  }

  const attached = new Map<string, string[]>()
  const isAttached = new Set<string>()
  for (const m of members) {
    if (isAttached.has(m.id)) continue
    for (const other of spousesOf.get(m.id) ?? []) {
      if (isAttached.has(other) || other === m.id) continue
      const mBlood = primaryParent.has(m.id) || hasChildren(m.id)
      const oBlood = primaryParent.has(other) || hasChildren(other)
      let anchor: string | null = null, spouse: string | null = null
      if (mBlood && !oBlood) { anchor = m.id; spouse = other }
      else if (oBlood && !mBlood) { anchor = other; spouse = m.id }
      else if (!mBlood && !oBlood) {
        const om = byId.get(other)!
        if (m.gender === '男' && om.gender !== '男') { anchor = m.id; spouse = other }
        else if (om.gender === '男' && m.gender !== '男') { anchor = other; spouse = m.id }
        else { anchor = m.id; spouse = other }
      }
      if (anchor && spouse && !isAttached.has(spouse) && !isAttached.has(anchor)) {
        if (!attached.has(anchor)) attached.set(anchor, [])
        attached.get(anchor)!.push(spouse)
        isAttached.add(spouse)
      }
    }
  }

  const roots = allRoots.filter((id) => !isAttached.has(id))

  const minGen = members.length ? Math.min(...members.map((m) => m.generation)) : 1
  const subtreeW = new Map<string, number>()
  const blockW = (id: string): number => {
    const n = 1 + (attached.get(id)?.length ?? 0)
    return n * NODE_W + (n - 1) * COUPLE_GAP
  }
  const measure = (id: string): number => {
    const kids = childrenOf.get(id) ?? []
    const bw = blockW(id)
    if (collapsed.has(id) || kids.length === 0) { subtreeW.set(id, bw); return bw }
    const total = kids.reduce((s, k) => s + measure(k), 0) + TREE_GAP * (kids.length - 1)
    const w = Math.max(bw, total)
    subtreeW.set(id, w)
    return w
  }
  roots.forEach(measure)

  const nodes: LayoutNode[] = []
  const nodeMap = new Map<string, LayoutNode>()
  const hiddenCount = (id: string): number => {
    let n = 0
    const stack = [...(childrenOf.get(id) ?? [])]
    while (stack.length) { const c = stack.pop()!; n++; stack.push(...(childrenOf.get(c) ?? [])) }
    return n
  }
  const place = (id: string, left: number): number => {
    const m = byId.get(id)!
    const kids = childrenOf.get(id) ?? []
    const bw = blockW(id)
    const sw = subtreeW.get(id)!
    let center: number
    const isCollapsed = collapsed.has(id)
    if (!isCollapsed && kids.length) {
      const total = kids.reduce((s, k) => s + subtreeW.get(k)!, 0) + TREE_GAP * (kids.length - 1)
      let cl = left + (sw - total) / 2
      const centers: number[] = []
      for (const k of kids) { centers.push(place(k, cl)); cl += subtreeW.get(k)! + TREE_GAP }
      center = (centers[0] + centers[centers.length - 1]) / 2
    } else {
      center = left + sw / 2
    }
    const blockLeft = center - bw / 2
    const y = (m.generation - minGen) * LEVEL_H + PAD
    const anchor: LayoutNode = {
      id, member: m, x: blockLeft, y, w: NODE_W, h: NODE_H, role: 'anchor',
      collapsed: isCollapsed && kids.length > 0, hiddenCount: isCollapsed ? hiddenCount(id) : 0,
      childCount: kids.length,
    }
    nodes.push(anchor); nodeMap.set(id, anchor)
    let sx = blockLeft + NODE_W + COUPLE_GAP
    for (const sp of attached.get(id) ?? []) {
      const sm = byId.get(sp)!
      const sn: LayoutNode = { id: sp, member: sm, x: sx, y, w: NODE_W, h: NODE_H, role: 'spouse', collapsed: false, hiddenCount: 0, childCount: childrenOf.get(sp)?.length ?? 0 }
      nodes.push(sn); nodeMap.set(sp, sn)
      sx += NODE_W + COUPLE_GAP
    }
    return center
  }
  let cursor = PAD
  for (const r of roots) { place(r, cursor); cursor += subtreeW.get(r)! + TREE_GAP }

  const minX = nodes.length ? Math.min(...nodes.map((n) => n.x)) : 0
  const shift = PAD - minX
  for (const n of nodes) n.x += shift
  const width = nodes.length ? Math.max(...nodes.map((n) => n.x + n.w)) + PAD : 200
  const height = nodes.length ? Math.max(...nodes.map((n) => n.y + n.h)) + PAD : 200

  const edges: LayoutEdge[] = []
  const coupleCenter = (id: string): number => {
    const n = nodeMap.get(id)!
    return n.x + blockW(id) / 2
  }
  for (const [child, parent] of primaryParent) {
    const cn = nodeMap.get(child), pn = nodeMap.get(parent)
    if (!cn || !pn) continue
    if (cn.collapsed) continue
    const px = coupleCenter(parent), py = pn.y + NODE_H
    const cx = cn.x + NODE_W / 2, cy = cn.y
    const midY = (py + cy) / 2
    edges.push({ id: `pe-${parent}-${child}`, kind: 'line', from: parent, to: child, path: `M ${px} ${py} V ${midY} H ${cx} V ${cy}` })
  }
  for (const [child, secs] of secondaryParents) {
    const cn = nodeMap.get(child)
    if (!cn || cn.collapsed) continue
    for (const s of secs) {
      const pn = nodeMap.get(s.from)
      if (!pn) continue
      const px = pn.x + NODE_W / 2, py = pn.y + NODE_H
      const cx = cn.x + NODE_W / 2, cy = cn.y
      edges.push({ id: `se-${s.id}`, kind: 'dashed', from: s.from, to: child, path: `M ${px} ${py} C ${px} ${py + 34}, ${cx} ${cy - 34}, ${cx} ${cy}` })
    }
  }
  const drawnSpouse = new Set<string>()
  for (const e of data.edges) {
    if (e.type !== 'spouse' || drawnSpouse.has(e.id)) continue
    drawnSpouse.add(e.id)
    const a = nodeMap.get(e.from), b = nodeMap.get(e.to)
    if (!a || !b) continue
    const left = a.x <= b.x ? a : b, right = a.x <= b.x ? b : a
    const sameRow = Math.abs(a.y - b.y) < 2
    const adjacent = sameRow && Math.abs(right.x - (left.x + left.w)) <= COUPLE_GAP + 1
    if (adjacent) {
      const y = left.y + NODE_H / 2
      const x1 = left.x + left.w, x2 = right.x
      edges.push({ id: `sp-${e.id}`, kind: 'spouse', from: e.from, to: e.to, path: `M ${x1} ${y - 2} H ${x2} M ${x1} ${y + 2} H ${x2}` })
    } else {
      const x1 = left.x + left.w / 2, y1 = left.y + NODE_H
      const x2 = right.x + right.w / 2, y2 = right.y + NODE_H
      const dip = Math.max(y1, y2) + 16
      edges.push({ id: `sp-${e.id}`, kind: 'spouseCross', from: e.from, to: e.to, path: `M ${x1} ${y1} V ${dip} H ${x2} V ${y2}` })
    }
  }

  return { nodes, edges, width, height, nodeMap }
}