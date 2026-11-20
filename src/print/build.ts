import type { Branch, GenealogyMeta, GraphData, Member, ZibeiPoem } from '@shared/types'
import { buildTree, computeLayout, NODE_H, NODE_W, LEVEL_H } from '../graph/layout'
import { yearOf } from '@shared/lunar'

export type LayoutKind = 'baota' | 'oushi' | 'sushi'
export type Scope = { kind: 'all' } | { kind: 'branch'; branchId: string } | { kind: 'gen'; from: number; to: number }

export interface PrintOptions {
  layout: LayoutKind
  scope: Scope
  paper: 'A4' | 'A3' | 'B5' | 'Letter'
  landscape: boolean
  font: '宋体' | '楷体' | '黑体'
  fontSize: '小四' | '五号' | '小五'
  cover: boolean
  toc: boolean
  zibeiPage: boolean
}

const FONT_FAMILY: Record<PrintOptions['font'], string> = {
  宋体: '"SimSun","STSong","Songti SC",serif',
  楷体: '"KaiTi","STKaiti","Kaiti SC",serif',
  黑体: '"SimHei","STHeiti","Heiti SC",sans-serif',
}
const FONT_PT: Record<PrintOptions['fontSize'], number> = { 小四: 12, 五号: 10.5, 小五: 9 }
const PAPER_MM: Record<PrintOptions['paper'], [number, number]> = {
  A4: [210, 297], A3: [297, 420], B5: [176, 250], Letter: [216, 279],
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

function years(m: Member): string {
  const b = yearOf(m.birthDate), d = yearOf(m.deathDate)
  if (!b && !d) return ''
  if (b && d) return `${b}–${d}`
  if (b) return m.alive ? `${b}–` : `${b}–？`
  return `？–${d}`
}

function branchSubtree(branches: Branch[], rootId: string): Set<string> {
  const children = new Map<string, string[]>()
  for (const b of branches) if (b.parentId) {
    if (!children.has(b.parentId)) children.set(b.parentId, [])
    children.get(b.parentId)!.push(b.id)
  }
  const out = new Set<string>()
  const stack = [rootId]
  while (stack.length) { const c = stack.pop()!; out.add(c); stack.push(...(children.get(c) ?? [])) }
  return out
}

export function scopeIds(data: GraphData, branches: Branch[], scope: Scope): Set<string> | undefined {
  if (scope.kind === 'all') return undefined
  if (scope.kind === 'branch') {
    const bs = branchSubtree(branches, scope.branchId)
    return new Set(data.members.filter((m) => m.branchId && bs.has(m.branchId)).map((m) => m.id))
  }
  return new Set(data.members.filter((m) => m.generation >= scope.from && m.generation <= scope.to).map((m) => m.id))
}

const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十']
const gen = (g: number): string => g >= 1 && g <= CN.length ? `${CN[g - 1]}世` : `第${g}世`

function baseCss(opts: PrintOptions, forPreview: boolean): string {
  const [w, h] = PAPER_MM[opts.paper]
  const pw = opts.landscape ? h : w, ph = opts.landscape ? w : h
  const margin = 14
  const cw = pw - margin * 2, ch = ph - margin * 2
  const pt = FONT_PT[opts.fontSize]
  return `
  :root { --ink:#2b2620; --line:#8a7a5f; --paper:#fbf7ec; --accent:#8f2f1f; --blue:#3d5468; --gold:#9c7a35; --muted:#6f6353; }
  * { box-sizing:border-box; }
  html,body { margin:0; padding:0; }
  body { font-family:${FONT_FAMILY[opts.font]}; font-size:${pt}pt; color:var(--ink); background:${forPreview ? '#e7e0cf' : '#fff'}; line-height:1.5; }
  @page { size:${pw}mm ${ph}mm; margin:${margin}mm; }
  .page { background:var(--paper); padding:${forPreview ? '10mm' : '0'}; ${forPreview ? `width:${cw}mm; min-height:${ch}mm; margin:8mm auto; box-shadow:0 2px 12px rgba(0,0,0,.25); border:1px solid #d8cdb4;` : ''} position:relative; }
  ${forPreview ? '' : '.page { page-break-after:always; } .page:last-child { page-break-after:auto; }'}
  .running { text-align:center; color:var(--muted); font-size:${pt - 2}pt; letter-spacing:2px; border-bottom:1px solid var(--line); padding-bottom:3mm; margin-bottom:5mm; }
  .vol-title { text-align:center; font-size:${pt + 3}pt; letter-spacing:3px; margin:2mm 0 5mm; font-weight:500; }
  .cover { display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; ${forPreview ? `min-height:${ch}mm;` : `height:${ch}mm;`} }
  .cover-seal { width:22mm; height:22mm; background:var(--accent); color:#fbf7ec; font-size:${pt + 6}pt; display:flex; align-items:center; justify-content:center; writing-mode:vertical-rl; letter-spacing:3px; border-radius:2mm; transform:rotate(-3deg); margin-bottom:12mm; }
  .cover-title { font-size:${pt + 16}pt; letter-spacing:8px; font-weight:500; margin:0 0 6mm; }
  .cover-hall { font-size:${pt + 5}pt; letter-spacing:5px; color:var(--accent); margin-bottom:14mm; }
  .cover-meta { font-size:${pt + 1}pt; color:var(--muted); margin:2mm 0; letter-spacing:2px; }
  .cover-date { margin-top:16mm; font-size:${pt + 1}pt; letter-spacing:3px; }
  .toc-list { list-style:none; padding:0; margin:6mm 0; }
  .toc-list li { display:flex; justify-content:space-between; border-bottom:1px dotted var(--line); padding:2.5mm 0; font-size:${pt + 1}pt; }
  .zibei-block { margin-bottom:7mm; }
  .zibei-scope { font-size:${pt + 1}pt; color:var(--accent); margin-bottom:2mm; letter-spacing:2px; }
  .zibei-row { display:flex; flex-wrap:wrap; gap:2mm; }
  .zibei-cell { border:1px solid var(--line); border-radius:1mm; text-align:center; padding:1.5mm 0; width:13mm; }
  .zibei-char { font-size:${pt + 5}pt; color:var(--accent); font-weight:500; }
  .zibei-gen { font-size:${pt - 2}pt; color:var(--muted); }
  table.oushi { width:100%; border-collapse:collapse; table-layout:fixed; }
  .oushi th,.oushi td { border:1px solid var(--line); padding:1.6mm 1mm; text-align:center; vertical-align:middle; overflow:hidden; }
  .oushi th { background:#efe7d2; font-weight:500; font-size:${pt}pt; letter-spacing:2px; }
  .oushi .nm { font-size:${pt + 1}pt; font-weight:500; white-space:nowrap; }
  .oushi .sub { font-size:${pt - 2}pt; color:var(--muted); font-family:"Microsoft YaHei",sans-serif; overflow-wrap:anywhere; }
  .oushi .female { color:var(--blue); }
  .oushi .empty { border:none; }
  .baota-svg { width:100%; height:auto; display:block; }
  .sushi-flow { writing-mode:vertical-rl; display:flex; flex-direction:column; flex-wrap:nowrap; gap:0; height:${ch - 16}mm; width:max-content; max-width:100%; margin:0 auto; }
  .sushi-col { border-left:1px solid var(--line); padding:0 2.5mm; display:flex; flex-wrap:wrap; align-content:flex-start; gap:4mm 2mm; height:100%; }
  .sushi-col:first-child { border-right:1px solid var(--line); }
  .sushi-gen { font-size:${pt - 1}pt; color:var(--accent); border-bottom:1px solid var(--line); padding-bottom:2mm; flex:none; white-space:nowrap; letter-spacing:2px; }
  .sushi-name { font-size:${pt + 2}pt; letter-spacing:3px; flex:none; white-space:nowrap; }
  .sushi-sub { font-size:${pt - 3}pt; color:var(--muted); letter-spacing:1px; flex:none; white-space:nowrap; }
  .sushi-female { color:var(--blue); }
  .note { text-align:center; color:var(--muted); font-size:${pt - 2}pt; margin-top:4mm; letter-spacing:1px; }
  `
}

function coverHtml(meta: GenealogyMeta): string {
  const d = new Date()
  return `<section class="page cover">
    <div class="cover-seal">家譜</div>
    <h1 class="cover-title">${esc(meta.name)}</h1>
    ${meta.hall ? `<div class="cover-hall">${esc(meta.hall)}</div>` : ''}
    ${meta.surname ? `<div class="cover-meta">姓氏 · ${esc(meta.surname)}</div>` : ''}
    ${meta.origin ? `<div class="cover-meta">籍貫 · ${esc(meta.origin)}</div>` : ''}
    ${meta.compiler ? `<div class="cover-meta">編纂 · ${esc(meta.compiler)}</div>` : ''}
    <div class="cover-date">公元 ${d.getFullYear()} 年 ${d.getMonth() + 1} 月 重修</div>
  </section>`
}

function zibeiHtml(zibei: ZibeiPoem[], meta: GenealogyMeta): string {
  const blocks = zibei.filter((z) => z.entries.length).map((z) => `
    <div class="zibei-block">
      <div class="zibei-scope">${esc(z.branchName)}</div>
      <div class="zibei-row">${z.entries.map((e) => `<div class="zibei-cell"><div class="zibei-char">${esc(e.char)}</div><div class="zibei-gen">${gen(e.generation)}</div></div>`).join('')}</div>
    </div>`).join('')
  return `<section class="page"><div class="running">${esc(meta.name)} · 字輩對照</div>
    <div class="vol-title">字輩對照頁</div>${blocks || '<p class="note">尚未設置字輩</p>'}
    <p class="note">字輩詩逐字對應世代 · 母系外姓不校驗</p></section>`
}

function baotaHtml(data: GraphData, meta: GenealogyMeta, scope: Set<string> | undefined, opts: PrintOptions, gensPerPage: number, forPreview: boolean): { html: string; volumes: string[] } {
  const layout = computeLayout(data, new Set(), scope)
  const members = layout.nodes.map((n) => n.member)
  const minGen = members.length ? Math.min(...members.map((m) => m.generation)) : 1
  const maxGen = members.length ? Math.max(...members.map((m) => m.generation)) : 1
  const [w, h] = PAPER_MM[opts.paper]
  const pw = opts.landscape ? h : w, ph = opts.landscape ? w : h
  const pt = FONT_PT[opts.fontSize]
  const cwPt = (pw - 28) * 2.83465
  const headH = (pt - 2) * 0.3528 + 8 + (pt + 3) * 0.3528 + 5
  const availH = (ph - 28 - headH - 10) * 2.83465
  const volumes: string[] = []
  let html = ''
  for (let g0 = minGen; g0 <= maxGen; g0 += gensPerPage) {
    const g1 = Math.min(g0 + gensPerPage - 1, maxGen)
    volumes.push(`${gen(g0)}至${gen(g1)}`)
    const minY = (g0 - minGen) * LEVEL_H + 30 - LEVEL_H * 0.4
    const maxY = (g1 - minGen) * LEVEL_H + 30 + NODE_H + LEVEL_H * 0.4
    const bandH = (maxY - minY) * 0.75
    const bandNodes = layout.nodes.filter((n) => n.y >= minY - 1 && n.y <= maxY)
    const minX = bandNodes.length ? Math.min(...bandNodes.map((n) => n.x)) : 0
    const maxX = bandNodes.length ? Math.max(...bandNodes.map((n) => n.x + n.w)) : layout.width
    const bandWidth = Math.max(1, maxX - minX)
    let s = Math.min(1, availH / bandH, Math.max(cwPt / bandWidth, 0.72))
    let segW = cwPt / s
    let segCount = Math.max(1, Math.ceil(bandWidth / segW))
    if (segCount > 1 && bandWidth - (segCount - 1) * segW < 0.25 * segW) {
      segCount--
      segW = bandWidth / segCount
      s = cwPt / segW
    }
    const segBase = segCount === 1 ? minX - (segW - bandWidth) / 2 : minX
    const bounds = [segBase]
    for (let k = 1; k < segCount; k++) {
      let b = segBase + k * segW
      const straddle = bandNodes.filter((n) => n.x < b && n.x + n.w > b)
      if (straddle.length) b = Math.min(...straddle.map((n) => n.x)) - 8
      bounds.push(b)
    }
    bounds.push(segBase + bandWidth + (segCount === 1 ? (segW - bandWidth) / 2 : 0))
    const maxSegW = Math.max(...bounds.slice(1).map((b, i) => b - bounds[i]))
    const padMm = forPreview ? 20 : 0
    const sHtml = ((pw - 28 - padMm) * 96 / 25.4) / maxSegW
    const offsetMm = Math.max(0, (ph - 28 - padMm - headH - 10 - bandH * sHtml * 0.3528) / 2)
    const bandIds = new Set(bandNodes.map((n) => n.id))
    const bandEdges = layout.edges.filter((e) => {
      const a = layout.nodeMap.get(e.from), b = layout.nodeMap.get(e.to)
      return (a && bandIds.has(a.id)) || (b && bandIds.has(b.id))
    })
    const edgeSvg = bandEdges.map((e) => {
      const cls = e.kind === 'dashed' ? 'stroke="#9c7a35" stroke-dasharray="5 4"' : e.kind === 'spouse' || e.kind === 'spouseCross' ? 'stroke="#8a7a5f"' : 'stroke="#6f6353"'
      return `<path d="${e.path}" fill="none" ${cls} stroke-width="1.2"/>`
    }).join('')
    for (let k = 0; k < segCount; k++) {
      const segX = bounds[k]
      const segWi = bounds[k + 1] - bounds[k]
      const nodeSvg = bandNodes.filter((n) => n.x + n.w / 2 >= segX && n.x + n.w / 2 < segX + segWi).map((n) => {
        const female = n.member.gender === '女'
        const stroke = female ? '#3d5468' : '#8a7a5f'
        const fill = n.role === 'spouse' ? '#efe7d2' : '#fbf7ec'
        const yr = years(n.member)
        return `<g><rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" fill="${fill}" stroke="${stroke}" stroke-width="1"/>
          <text x="${n.x + n.w / 2}" y="${n.y + 17}" text-anchor="middle" font-size="13" font-weight="500" fill="#2b2620">${esc(n.member.name)}</text>
          <text x="${n.x + n.w / 2}" y="${n.y + 32}" text-anchor="middle" font-size="9" fill="#6f6353">${esc(yr)}${female ? ' · 女' : ''}</text></g>`
      }).join('')
      const segLabel = segCount > 1 ? ` · 接${CN[k] ?? k + 1}頁` : ''
      html += `<section class="page"><div class="running">${esc(meta.name)}${meta.hall ? ' · ' + esc(meta.hall) : ''} · 寶塔式弔線圖</div>
        <div class="vol-title">${gen(g0)} 至 ${gen(g1)}${segLabel}</div>
        <svg class="baota-svg" style="margin:${offsetMm.toFixed(1)}mm auto 0;width:${(segWi * sHtml).toFixed(1)}px" viewBox="${segX} ${minY} ${segWi} ${maxY - minY}" preserveAspectRatio="xMidYMin meet">${edgeSvg}${nodeSvg}</svg>
        <p class="note">自上而下 · 長幼有序 · 虛線為過繼 / 兼祧 · 藍框為女性</p></section>`
    }
  }
  return { html, volumes }
}

function oushiHtml(data: GraphData, meta: GenealogyMeta, scope: Set<string> | undefined, branches: Branch[]): { html: string; volumes: string[] } {
  const tree = buildTree(data, scope)
  const members = tree.members
  const minGen = members.length ? Math.min(...members.map((m) => m.generation)) : 1
  const maxGen = members.length ? Math.max(...members.map((m) => m.generation)) : 1
  const volumes: string[] = []
  let html = ''
  const spouseName = (id: string): string => {
    const sp = (tree.spousesOf.get(id) ?? []).map((s) => tree.byId.get(s)).filter(Boolean) as Member[]
    return sp.map((s) => `配${esc(s.name)}`).join(' ')
  }
  for (let start = minGen; start <= maxGen; start += 5) {
    const end = Math.min(start + 4, maxGen)
    volumes.push(`${gen(start)}至${gen(end)}`)
    const inWin = new Set(members.filter((m) => m.generation >= start && m.generation <= end).map((m) => m.id))
    const kids = (id: string): string[] => (tree.childrenOf.get(id) ?? []).filter((k) => inWin.has(k))
    const leafCount = (id: string): number => {
      const k = kids(id)
      return k.length ? k.reduce((s, c) => s + leafCount(c), 0) : 1
    }
    const winRoots = members.filter((m) => inWin.has(m.id) && (!tree.primaryParent.has(m.id) || !inWin.has(tree.primaryParent.get(m.id)!))).map((m) => m.id)
    const grid: (string | null)[][] = []
    const covered: boolean[][] = []
    let cursor = 0
    const cell = (id: string, rowspan: number): string => {
      const m = tree.byId.get(id)!
      const female = m.gender === '女'
      const sp = spouseName(id)
      const jt = (tree.secondaryParents.get(id) ?? []).map((p) => p.subtype).join('/')
      const sub = [years(m), jt ? `${jt}` : '', sp].filter(Boolean).join(' · ')
      return `<td rowspan="${rowspan}"><div class="nm${female ? ' female' : ''}">${esc(m.name)}${female ? '（女）' : ''}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</td>`
    }
    const walk = (id: string, col: number): void => {
      const lc = leafCount(id)
      const r0 = cursor
      grid[r0] = grid[r0] || []
      grid[r0][col] = cell(id, lc)
      covered[r0] = covered[r0] || []
      for (let r = r0; r < r0 + lc; r++) { covered[r] = covered[r] || []; covered[r][col] = true }
      const k = kids(id)
      if (k.length) { for (const c of k) walk(c, col + 1) }
      else cursor++
    }
    winRoots.forEach((r) => walk(r, tree.byId.get(r)!.generation - start))
    let rows = ''
    for (let r = 0; r < cursor; r++) {
      let tds = ''
      for (let c = 0; c < 5; c++) {
        if (grid[r]?.[c]) tds += grid[r][c]
        else if (covered[r]?.[c]) continue
        else tds += '<td class="empty"></td>'
      }
      rows += `<tr>${tds}</tr>`
    }
    const head = `<tr>${[0, 1, 2, 3, 4].map((i) => start + i <= end ? `<th>${gen(start + i)}</th>` : '<th class="empty"></th>').join('')}</tr>`
    html += `<section class="page"><div class="running">${esc(meta.name)}${meta.hall ? ' · ' + esc(meta.hall) : ''} · 歐式世系表</div>
      <div class="vol-title">${gen(start)} 至 ${gen(end)}</div>
      <table class="oushi"><thead>${head}</thead><tbody>${rows}</tbody></table>
      <p class="note">歐式五世一表 · 次表接${gen(end + 1)} · 女性同等入表</p></section>`
  }
  return { html, volumes }
}

function sushiHtml(data: GraphData, meta: GenealogyMeta, scope: Set<string> | undefined, opts: PrintOptions, colsPerPage: number, namesPerCol: number): { html: string; volumes: string[] } {
  const tree = buildTree(data, scope)
  const members = tree.members
  const minGen = members.length ? Math.min(...members.map((m) => m.generation)) : 1
  const maxGen = members.length ? Math.max(...members.map((m) => m.generation)) : 1
  interface Col { g: number; cont: boolean; items: Member[] }
  const cols: Col[] = []
  for (let g = minGen; g <= maxGen; g++) {
    const gm = members.filter((m) => m.generation === g).sort((a, b) => a.birthOrder - b.birthOrder || a.name.localeCompare(b.name, 'zh'))
    for (let i = 0; i < gm.length; i += namesPerCol) {
      cols.push({ g, cont: i > 0, items: gm.slice(i, i + namesPerCol) })
    }
    if (!gm.length) cols.push({ g, cont: false, items: [] })
  }
  const volumes: string[] = []
  let html = ''
  for (let i = 0; i < cols.length; i += colsPerPage) {
    const pageCols = cols.slice(i, i + colsPerPage)
    const g0 = pageCols[0].g, g1 = pageCols[pageCols.length - 1].g
    volumes.push(`${gen(g0)}至${gen(g1)}`)
    const colHtml = pageCols.map((c) => {
      const names = c.items.map((m) => {
        const female = m.gender === '女'
        const yr = years(m)
        return `<span class="sushi-name${female ? ' sushi-female' : ''}">${esc(m.name)}</span>${yr ? `<span class="sushi-sub">${esc(yr)}</span>` : ''}`
      }).join('')
      return `<div class="sushi-col"><span class="sushi-gen">${gen(c.g)}${c.cont ? '·續' : ''}</span>${names}</div>`
    }).join('')
    html += `<section class="page"><div class="running">${esc(meta.name)}${meta.hall ? ' · ' + esc(meta.hall) : ''} · 蘇式垂珠體</div>
      <div class="vol-title">${gen(g0)} 至 ${gen(g1)}</div>
      <div class="sushi-flow">${colHtml}</div>
      <p class="note">蘇式豎排 · 自右向左讀 · 世代為列，人名為珠 · 藍字為女性</p></section>`
  }
  return { html, volumes }
}

export interface PrintResult { html: string; summary: string; volumes: string[] }

export function buildPrintHtml(
  data: GraphData, meta: GenealogyMeta, branches: Branch[], zibei: ZibeiPoem[],
  opts: PrintOptions, forPreview: boolean,
): PrintResult {
  const scope = scopeIds(data, branches, opts.scope)
  const filtered = scope ? data.members.filter((m) => scope.has(m.id)) : data.members
  const [w, h] = PAPER_MM[opts.paper]
  const pw = opts.landscape ? h : w, ph = opts.landscape ? w : h
  const gensPerPage = opts.landscape ? 3 : (opts.paper === 'A3' ? 5 : 4)
  const pt = FONT_PT[opts.fontSize]
  const mmPerPt = 0.3528
  const perNameMm = 3 * (pt + 2) * mmPerPt + 9 * (pt - 3) * mmPerPt * 0.6 + 4
  const colsPerPage = Math.max(4, Math.floor((pw - 28) / 22))
  const namesPerCol = Math.max(3, Math.floor((ph - 56) / perNameMm))

  let main: { html: string; volumes: string[] }
  let layoutName: string
  if (opts.layout === 'baota') { main = baotaHtml(data, meta, scope, opts, gensPerPage, forPreview); layoutName = '寶塔式弔線圖' }
  else if (opts.layout === 'oushi') { main = oushiHtml(data, meta, scope, branches); layoutName = '歐式橫表·五世一表' }
  else { main = sushiHtml(data, meta, scope, opts, colsPerPage, namesPerCol); layoutName = '蘇式垂珠體·豎排' }

  const sections: string[] = []
  if (opts.cover) sections.push(coverHtml(meta))
  if (opts.toc) {
    const base = (opts.cover ? 1 : 0) + (opts.toc ? 1 : 0)
    const mainStart = base + (opts.zibeiPage ? 1 : 0) + 1
    const items: { t: string; no: number }[] = []
    if (opts.zibeiPage) items.push({ t: '字輩對照頁', no: base + 1 })
    main.volumes.forEach((v, i) => items.push({ t: `${layoutName} · 卷${CN[i] ?? i + 1}（${v}）`, no: mainStart + i }))
    sections.push(`<section class="page"><div class="running">${esc(meta.name)} · 目錄</div>
      <div class="vol-title">目 錄</div>
      <ul class="toc-list">${items.map((it) => `<li><span>${esc(it.t)}</span><span>${it.no}</span></li>`).join('')}</ul>
      <p class="note">全譜共 ${filtered.length} 人 · ${main.volumes.length} 卷</p></section>`)
  }
  if (opts.zibeiPage) sections.push(zibeiHtml(zibei, meta))
  sections.push(main.html)

  const sc = opts.scope
  const scopeDesc = sc.kind === 'all' ? '整譜'
    : sc.kind === 'branch' ? (branches.find((b) => b.id === sc.branchId)?.name ?? '支系')
      : `${gen(sc.from)}至${gen(sc.to)}`
  const summary = `${layoutName} · ${scopeDesc} ${filtered.length} 人 · ${opts.paper} ${opts.landscape ? '橫向' : '縱向'} · ${main.volumes.length} 卷`
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(meta.name)}</title><style>${baseCss(opts, forPreview)}</style></head><body>${sections.join('')}</body></html>`
  return { html, summary, volumes: main.volumes }
}