import type { Branch, GenealogyMeta, GraphData, Member, ZibeiPoem } from '@shared/types'
import { buildTree, computeLayout, NODE_H, NODE_W, LEVEL_H } from '../graph/layout'
import { yearOf } from '../../electron/shared/lunar'

export type LayoutKind = 'baota' | 'oushi' | 'sushi' | 'biography' | 'roster'
export type Scope =
  | { kind: 'all' }
  | { kind: 'branch'; branchId: string }
  | { kind: 'gen'; from: number; to: number }
  | { kind: 'members'; memberIds: string[] }
export type RosterField = 'name' | 'gender' | 'generation' | 'zibei' | 'branch' | 'years' | 'parents' | 'spouses' | 'residence' | 'burial'
export type RosterSort = 'generation' | 'birthOrder' | 'name' | 'branch'

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
  rosterFields: RosterField[]
  rosterSort: RosterSort
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
  if (scope.kind === 'members') {
    const ids = new Set(data.members.map((m) => m.id))
    return new Set(scope.memberIds.filter((id) => ids.has(id)))
  }
  return new Set(data.members.filter((m) => m.generation >= scope.from && m.generation <= scope.to).map((m) => m.id))
}

export const ROSTER_FIELD_DEFS: { key: RosterField; label: string }[] = [
  { key: 'name', label: '姓名' }, { key: 'gender', label: '性别' },
  { key: 'generation', label: '世代' }, { key: 'zibei', label: '字辈' },
  { key: 'branch', label: '支系' }, { key: 'years', label: '生卒' },
  { key: 'parents', label: '父母' }, { key: 'spouses', label: '配偶' },
  { key: 'residence', label: '居地' }, { key: 'burial', label: '葬地' },
]
export const DEFAULT_ROSTER_FIELDS: RosterField[] = ['name', 'gender', 'generation', 'branch', 'years']
const ROSTER_FIELD_KEYS = new Set<string>(ROSTER_FIELD_DEFS.map((f) => f.key))

export function normalizeRosterFields(fields: RosterField[] | undefined): RosterField[] {
  const selected = new Set((fields ?? DEFAULT_ROSTER_FIELDS).filter((f) => ROSTER_FIELD_KEYS.has(f)))
  const normalized = ROSTER_FIELD_DEFS.map((f) => f.key).filter((f) => selected.has(f))
  return normalized.length ? normalized : ['name']
}

export interface P1Metrics {
  pageW: number
  pageH: number
  contentW: number
  contentH: number
  pt: number
  lineH: number
  headerH: number
  bodyH: number
  bodyChars: number
  profileChars: number
  photoW: number
  photoH: number
}

export function p1Metrics(opts: PrintOptions): P1Metrics {
  const [w, h] = PAPER_MM[opts.paper]
  const pageW = opts.landscape ? h : w, pageH = opts.landscape ? w : h
  const contentW = pageW - 28, contentH = pageH - 28
  const pt = FONT_PT[opts.fontSize]
  const lineH = pt * 0.3528 * 1.5
  const runningH = (pt - 2) * 0.3528 * 1.5 + 3 + 0.25
  const headerH = runningH + 5 + 2 + (pt + 3) * 0.3528 * 1.5 + 5
  const bodyH = Math.max(lineH, contentH - headerH - 9)
  const photoW = 34, photoH = 42
  const charW = pt * 0.3528
  return {
    pageW, pageH, contentW, contentH, pt, lineH, headerH, bodyH,
    bodyChars: Math.max(6, Math.floor(contentW / charW) - 2),
    profileChars: Math.max(6, Math.floor((contentW - photoW - 5) / charW)),
    photoW, photoH,
  }
}

export function scopeMembers(data: GraphData, branches: Branch[], scope: Scope): Member[] {
  const ids = scopeIds(data, branches, scope)
  const members = ids ? data.members.filter((m) => ids.has(m.id)) : [...data.members]
  return members.sort((a, b) => a.generation - b.generation || a.birthOrder - b.birthOrder || a.name.localeCompare(b.name, 'zh') || a.id.localeCompare(b.id))
}

export function sortRosterMembers(members: Member[], branches: Branch[], sort: RosterSort): Member[] {
  const branchOrder = new Map(branches.map((b, index) => [b.id, index]))
  const cmp = (a: Member, b: Member): number => a.generation - b.generation || a.birthOrder - b.birthOrder || a.name.localeCompare(b.name, 'zh') || a.id.localeCompare(b.id)
  return [...members].sort((a, b) => {
    let r = 0
    if (sort === 'birthOrder') r = a.birthOrder - b.birthOrder || cmp(a, b)
    else if (sort === 'name') r = a.name.localeCompare(b.name, 'zh') || cmp(a, b)
    else if (sort === 'branch') {
      if (!a.branchId && b.branchId) r = 1
      else if (a.branchId && !b.branchId) r = -1
      else if (a.branchId && b.branchId) {
        const ai = branchOrder.get(a.branchId) ?? Number.MAX_SAFE_INTEGER
        const bi = branchOrder.get(b.branchId) ?? Number.MAX_SAFE_INTEGER
        r = ai - bi
      }
    } else r = cmp(a, b)
    return r || cmp(a, b) || a.id.localeCompare(b.id)
  })
}

export function wrapPrintText(text: string, maxChars: number): string[] {
  const source = String(text ?? '')
  if (!source) return []
  const width = Math.max(1, maxChars)
  const out: string[] = []
  for (const paragraph of source.replace(/\r\n?/g, '\n').split('\n')) {
    if (!paragraph) { out.push(''); continue }
    let line = ''
    for (const ch of Array.from(paragraph)) {
      if (line && Array.from(line).length >= width) { out.push(line); line = ch }
      else line += ch
    }
    if (line) out.push(line)
  }
  return out
}

function relationMaps(data: GraphData): {
  parents: Map<string, string[]>
  spouses: Map<string, string[]>
  children: Map<string, string[]>
} {
  const parents = new Map<string, string[]>(), spouses = new Map<string, string[]>(), children = new Map<string, string[]>()
  const byId = new Map(data.members.map((m) => [m.id, m]))
  const add = (map: Map<string, string[]>, key: string, value: string): void => {
    if (!map.has(key)) map.set(key, [])
    if (!map.get(key)!.includes(value)) map.get(key)!.push(value)
  }
  for (const e of data.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue
    if (e.type === 'parent_child') {
      add(parents, e.to, `${e.subtype ? `${e.subtype}：` : ''}${byId.get(e.from)!.name}`)
      add(children, e.from, byId.get(e.to)!.name)
    } else {
      add(spouses, e.from, `${e.subtype ? `${e.subtype}：` : ''}${byId.get(e.to)!.name}`)
      add(spouses, e.to, `${e.subtype ? `${e.subtype}：` : ''}${byId.get(e.from)!.name}`)
    }
  }
  for (const list of children.values()) list.sort((a, b) => a.localeCompare(b, 'zh'))
  return { parents, spouses, children }
}

export function rosterValues(
  member: Member, data: GraphData, branches: Branch[], zibei: ZibeiPoem[], maps = relationMaps(data),
): Record<RosterField, string> {
  const rel = (id: string): string => (maps.parents.get(id) ?? []).join('、')
  const spouses = (maps.spouses.get(member.id) ?? []).join('、')
  const zi = zibei.find((z) => z.branchId === member.branchId)?.entries.find((e) => e.generation === member.generation)?.char ?? ''
  return {
    name: member.name, gender: member.gender, generation: gen(member.generation), zibei: zi,
    branch: branches.find((b) => b.id === member.branchId)?.name ?? '', years: years(member),
    parents: rel(member.id), spouses, residence: member.residence, burial: member.burial,
  }
}

const ROSTER_WEIGHTS: Record<RosterField, number> = {
  name: 3, gender: 1, generation: 1.4, zibei: 1, branch: 2,
  years: 2.5, parents: 3.5, spouses: 3, residence: 2.5, burial: 2.5,
}

export function rosterColumnWidths(fields: RosterField[], contentW: number): number[] {
  const ordered = normalizeRosterFields(fields)
  const total = ordered.reduce((sum, f) => sum + ROSTER_WEIGHTS[f], 0)
  return ordered.map((f) => contentW * ROSTER_WEIGHTS[f] / total)
}

export interface RosterRow { id: string; values: Record<RosterField, string> }
export interface RosterPagePlan { rows: RosterRow[]; start: number }
export interface RosterPlan { fields: RosterField[]; pages: RosterPagePlan[]; rowH: number; headerH: number }

export function planRosterPages(
  data: GraphData, branches: Branch[], zibei: ZibeiPoem[], members: Member[], opts: PrintOptions,
): RosterPlan {
  const fields = normalizeRosterFields(opts.rosterFields)
  const metrics = p1Metrics(opts)
  const tableHeadH = 8
  const rowH = metrics.lineH + 3.2
  const capacity = Math.max(1, Math.floor((metrics.bodyH - tableHeadH) / rowH))
  const maps = relationMaps(data)
  const rows = sortRosterMembers(members, branches, opts.rosterSort).map((m) => ({ id: m.id, values: rosterValues(m, data, branches, zibei, maps) }))
  const pages: RosterPagePlan[] = []
  for (let i = 0; i < rows.length; i += capacity) pages.push({ rows: rows.slice(i, i + capacity), start: i })
  return { fields, pages, rowH, headerH: tableHeadH }
}

export interface BiographyPagePlan {
  memberId: string
  memberName: string
  continuation: boolean
  profile: string[]
  body: { text: string; section: boolean }[]
  photo: boolean
}

function biographyProfile(member: Member, data: GraphData, branches: Branch[], metrics: P1Metrics, maps: ReturnType<typeof relationMaps>): string[] {
  const rows: [string, string][] = [
    ['性别', member.gender], ['世代', gen(member.generation)], ['字', member.courtesyName || '—'], ['号', member.title || '—'],
    ['生卒', years(member) || '—'], ['父母', (maps.parents.get(member.id) ?? []).join('、') || '—'],
    ['配偶', (maps.spouses.get(member.id) ?? []).join('、') || '—'], ['子女', (maps.children.get(member.id) ?? []).join('、') || '—'],
    ['支系', branches.find((b) => b.id === member.branchId)?.name || '—'], ['居地', member.residence || '—'], ['葬地', member.burial || '—'],
  ]
  return rows.flatMap(([label, value]) => wrapPrintText(`${label}：${value}`, metrics.profileChars))
}

function paginateBiographyBody(items: { text: string; section: boolean }[], capacity: number): { text: string; section: boolean }[][] {
  const pages: { text: string; section: boolean }[][] = []
  let at = 0
  while (at < items.length) {
    const page: { text: string; section: boolean }[] = []
    while (at < items.length && page.length < capacity) {
      const item = items[at]
      if (item.section && page.length + 2 > capacity) break
      page.push(item)
      at++
    }
    if (!page.length) { page.push(items[at]); at++ }
    pages.push(page)
  }
  return pages
}

export function planBiographyPages(data: GraphData, branches: Branch[], members: Member[], opts: PrintOptions): BiographyPagePlan[] {
  const metrics = p1Metrics(opts)
  const maps = relationMaps(data)
  const pages: BiographyPagePlan[] = []
  const fullBodyCap = Math.max(1, Math.floor(metrics.bodyH / metrics.lineH))
  for (const member of sortRosterMembers(members, branches, 'generation')) {
    const profile = biographyProfile(member, data, branches, metrics, maps)
    const photo = !!member.photoPath
    const profileCap = Math.max(1, Math.floor((metrics.bodyH - (photo ? metrics.photoH + 2 : 0)) / metrics.lineH))
    const fullProfileCap = Math.max(1, Math.floor(metrics.bodyH / metrics.lineH))
    const chunks: { lines: string[]; first: boolean; bodyCap: number }[] = []
    for (let at = 0, first = true; at < profile.length; first = false) {
      const cap = first ? profileCap : fullProfileCap
      const lines = profile.slice(at, at + cap)
      at += lines.length
      const usedH = Math.max(lines.length * metrics.lineH, first && photo ? metrics.photoH : 0)
      chunks.push({ lines, first, bodyCap: Math.max(0, Math.floor((metrics.bodyH - usedH - 2) / metrics.lineH)) })
    }
    const bio = wrapPrintText(member.biography.trim() ? member.biography : '—', metrics.bodyChars)
    const notes = wrapPrintText(member.remark.trim() ? member.remark : '—', metrics.bodyChars)
    const items: { text: string; section: boolean }[] = []
    if (bio.length) items.push({ text: '生平', section: true }, ...bio.map((text) => ({ text, section: false })))
    if (notes.length) items.push({ text: '备注', section: true }, ...notes.map((text) => ({ text, section: false })))
    let bodyPages: { text: string; section: boolean }[][] = []
    let bodyAt = 0
    chunks.forEach((chunk, i) => {
      const body: { text: string; section: boolean }[] = []
      const cap = i === chunks.length - 1 ? chunk.bodyCap : 0
      if (cap > 1) {
        const page = paginateBiographyBody(items.slice(bodyAt), cap)[0] ?? []
        body.push(...page)
        bodyAt += page.length
      }
      pages.push({ memberId: member.id, memberName: member.name, continuation: !chunk.first, profile: chunk.lines, body, photo: chunk.first && photo })
    })
    if (bodyAt < items.length) bodyPages = paginateBiographyBody(items.slice(bodyAt), fullBodyCap)
    for (const body of bodyPages) pages.push({ memberId: member.id, memberName: member.name, continuation: true, profile: [], body, photo: false })
  }
  return pages
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
  .page.p1-page { min-height:${ch}mm; ${forPreview ? `width:${cw + 20}mm; min-height:${ch + 20}mm;` : ''} }
  .p1-folio { position:absolute; left:0; right:0; bottom:1mm; text-align:center; color:var(--muted); font-size:${pt - 2}pt; letter-spacing:1px; }
  .bio-layout { width:100%; }
  .bio-layout::after { content:""; display:block; clear:both; }
  .bio-photo { float:right; width:34mm; height:42mm; margin-left:5mm; border:1px solid var(--line); display:flex; align-items:center; justify-content:center; background:#f3eddd; color:var(--muted); font-size:${pt - 2}pt; }
  .bio-photo img { display:block; width:100%; height:100%; object-fit:contain; }
  .bio-profile { min-height:1mm; }
  .bio-profile.with-photo { width:calc(100% - 39mm); }
  .bio-line { height:${pt * 0.3528 * 1.5}mm; line-height:${pt * 0.3528 * 1.5}mm; white-space:pre; }
  .bio-section { color:var(--accent); font-weight:500; letter-spacing:2px; border-bottom:1px solid var(--line); height:${pt * 0.3528 * 1.5}mm; line-height:${pt * 0.3528 * 1.5}mm; margin:0; padding:0; }
  .bio-content.after-profile { margin-top:2mm; }
  .bio-body .bio-line, .bio-text { text-indent:2em; }
  table.roster { width:100%; border-collapse:collapse; table-layout:fixed; }
  .roster thead { display:table-header-group; }
  .roster tr { break-inside:avoid; page-break-inside:avoid; }
  .roster th,.roster td { border:1px solid var(--line); padding:1.6mm 1.2mm; text-align:left; vertical-align:middle; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
  .roster th { background:#efe7d2; font-weight:500; text-align:center; letter-spacing:1px; height:8mm; }
  .roster td { height:${pt * 0.3528 * 1.5 + 3.2}mm; font-size:${pt - 1}pt; }
  .roster td:first-child { color:var(--ink); }
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

function p1Folio(no: number): string {
  return `<div class="p1-folio">${no}</div>`
}

function biographyHtml(data: GraphData, meta: GenealogyMeta, branches: Branch[], members: Member[], opts: PrintOptions, folioOffset: number): { html: string; volumes: string[] } {
  const metrics = p1Metrics(opts)
  const byId = new Map(data.members.map((m) => [m.id, m]))
  const pages = planBiographyPages(data, branches, members, opts)
  const volumes: string[] = pages.length ? ['人物傳記'] : []
  let html = ''
  pages.forEach((pg, i) => {
    const m = byId.get(pg.memberId)!
    const title = `${m.name}传${pg.continuation ? '（续）' : ''}`
    const photo = pg.photo && m.photoPath
      ? `<div class="bio-photo"><img src="jpimg://${esc(meta.id)}/${m.photoPath.split('/').map((s) => encodeURIComponent(s)).join('/')}" alt="${esc(m.name)}照片"></div>`
      : ''
    const profile = pg.profile.length
      ? `<div class="bio-profile${photo ? ' with-photo' : ''}">${pg.profile.map((line) => `<div class="bio-line">${esc(line)}</div>`).join('')}</div>`
      : ''
    const bodyHtml = pg.body.length ? `<div class="bio-content${pg.profile.length || pg.photo ? ' after-profile' : ''}">${pg.body.map((line) => line.section
      ? `<div class="bio-section">${esc(line.text)}</div>`
      : `<div class="bio-line bio-text">${line.text ? esc(line.text) : '&nbsp;'}</div>`).join('')}</div>` : ''
    html += `<section class="page p1-page"><div class="running">${esc(meta.name)}${meta.hall ? ' · ' + esc(meta.hall) : ''} · 人物传记</div>
      <div class="vol-title">${esc(title)}</div><div class="bio-layout">${photo}${profile}</div>${bodyHtml}${p1Folio(folioOffset + i + 1)}</section>`
  })
  if (!pages.length) html = `<section class="page p1-page"><div class="running">${esc(meta.name)} · 人物传记</div><div class="vol-title">人物传记</div><p class="note">所選範圍內暫無成員</p>${p1Folio(folioOffset + 1)}</section>`
  return { html, volumes }
}

function rosterHtml(data: GraphData, meta: GenealogyMeta, branches: Branch[], zibei: ZibeiPoem[], members: Member[], opts: PrintOptions, folioOffset: number): { html: string; volumes: string[] } {
  const metrics = p1Metrics(opts)
  const plan = planRosterPages(data, branches, zibei, members, opts)
  const widths = rosterColumnWidths(plan.fields, metrics.contentW)
  const labels = new Map(ROSTER_FIELD_DEFS.map((f) => [f.key, f.label]))
  const colgroup = `<colgroup>${plan.fields.map((f, i) => `<col style="width:${widths[i].toFixed(3)}mm">`).join('')}</colgroup>`
  const head = `<thead><tr>${plan.fields.map((f) => `<th scope="col">${esc(labels.get(f)!)}</th>`).join('')}</tr></thead>`
  const volumes: string[] = plan.pages.length ? ['成員名錄'] : []
  const pages = plan.pages.map((pg, i) => {
    const rows = pg.rows.map((row) => `<tr data-member-id="${esc(row.id)}">${plan.fields.map((f) => {
      const value = row.values[f] || '—'
      return `<td title="${esc(value)}">${esc(value)}</td>`
    }).join('')}</tr>`).join('')
    return `<section class="page p1-page"><div class="running">${esc(meta.name)}${meta.hall ? ' · ' + esc(meta.hall) : ''} · 成员名录</div>
      <div class="vol-title">成员名录${plan.pages.length > 1 ? ` · 第${i + 1}页` : ''}</div>
      <table class="roster">${colgroup}${head}<tbody>${rows}</tbody></table>
      <p class="note">一行一人 · 共 ${members.length} 人 · 空值以「—」標示</p>${p1Folio(folioOffset + i + 1)}</section>`
  })
  if (!pages.length) pages.push(`<section class="page p1-page"><div class="running">${esc(meta.name)} · 成员名录</div><div class="vol-title">成员名录</div><p class="note">所選範圍內暫無成員</p>${p1Folio(folioOffset + 1)}</section>`)
  return { html: pages.join(''), volumes }
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
  const folioOffset = (opts.cover ? 1 : 0) + (opts.toc ? 1 : 0) + (opts.zibeiPage ? 1 : 0)
  if (opts.layout === 'baota') { main = baotaHtml(data, meta, scope, opts, gensPerPage, forPreview); layoutName = '寶塔式弔線圖' }
  else if (opts.layout === 'oushi') { main = oushiHtml(data, meta, scope, branches); layoutName = '歐式橫表·五世一表' }
  else if (opts.layout === 'biography') { main = biographyHtml(data, meta, branches, filtered, opts, folioOffset); layoutName = '人物傳記式' }
  else if (opts.layout === 'roster') { main = rosterHtml(data, meta, branches, zibei, filtered, opts, folioOffset); layoutName = '名錄簡表式' }
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
      : sc.kind === 'members' ? '勾選成員'
        : `${gen(sc.from)}至${gen(sc.to)}`
  const summary = `${layoutName} · ${scopeDesc} ${filtered.length} 人 · ${opts.paper} ${opts.landscape ? '橫向' : '縱向'} · ${main.volumes.length} 卷`
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(meta.name)}</title><style>${baseCss(opts, forPreview)}</style></head><body>${sections.join('')}</body></html>`
  return { html, summary, volumes: main.volumes }
}