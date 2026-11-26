import fs from 'node:fs'
import path from 'node:path'
import { PDFDocument, rgb, degrees, pushGraphicsState, popGraphicsState, setStrokingRgbColor, setLineWidth, setDashPattern, moveTo, lineTo, appendBezierCurve, stroke, rectangle, clip, endPath, type PDFOperator, type PDFPage, type PDFFont, type PDFImage, type RGB } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import type { Branch, GenealogyMeta, GraphData, Member, ZibeiPoem } from '../shared/types'
import type { PrintOptions, BiographyPagePlan, RosterPlan } from '../../src/print/build'
import { p1Metrics, planBiographyPages, planRosterPages, rosterColumnWidths, scopeIds, scopeMembers, ROSTER_FIELD_DEFS } from '../../src/print/build'
import { buildTree, computeLayout, NODE_H, LEVEL_H } from '../../src/graph/layout'
import { yearOf } from '../shared/lunar'

export interface PdfPayload {
  data: GraphData
  meta: GenealogyMeta
  branches: Branch[]
  zibei: ZibeiPoem[]
  opts: PrintOptions
  /** Current genealogy directory; supplied by the renderer for local portrait photos. */
  photoDir?: string
}

const MM = 72 / 25.4
const PT_MM = 0.3528
const MARGIN = 14 * MM
const PAPER_MM: Record<PrintOptions['paper'], [number, number]> = {
  A4: [210, 297], A3: [297, 420], B5: [176, 250], Letter: [216, 279],
}
const FONT_PT: Record<PrintOptions['fontSize'], number> = { 小四: 12, 五号: 10.5, 小五: 9 }
const FONT_FILES: Record<PrintOptions['font'], string[]> = {
  宋体: ['simsun.ttc', 'STSONG.TTF', 'simfang.ttf'],
  楷体: ['simkai.ttf', 'STKAITI.TTF', 'simsun.ttc'],
  黑体: ['simhei.ttf', 'STXIHEI.TTF', 'simsun.ttc'],
}
const INK = rgb(0.169, 0.149, 0.125)
const LINE = rgb(0.541, 0.478, 0.373)
const PAPER = rgb(0.984, 0.969, 0.925)
const ACCENT = rgb(0.561, 0.184, 0.122)
const BLUE = rgb(0.239, 0.329, 0.408)
const GOLD = rgb(0.612, 0.478, 0.208)
const MUTED = rgb(0.435, 0.388, 0.325)
const HEAD_FILL = rgb(0.937, 0.906, 0.824)

const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十']
const gen = (g: number): string => (g >= 1 && g <= CN.length ? `${CN[g - 1]}世` : `第${g}世`)

function years(m: Member): string {
  const b = yearOf(m.birthDate), d = yearOf(m.deathDate)
  if (!b && !d) return ''
  if (b && d) return `${b}–${d}`
  if (b) return m.alive ? `${b}–` : `${b}–？`
  return `？–${d}`
}

function extractTtf(buf: Buffer): Buffer {
  if (buf.toString('latin1', 0, 4) !== 'ttcf') return buf
  const off = buf.readUInt32BE(12)
  const numTables = buf.readUInt16BE(off + 4)
  const recs: { tag: string; sum: number; len: number; src: number }[] = []
  for (let i = 0; i < numTables; i++) {
    const p = off + 12 + i * 16
    recs.push({ tag: buf.toString('latin1', p, p + 4), sum: buf.readUInt32BE(p + 4), len: buf.readUInt32BE(p + 12), src: buf.readUInt32BE(p + 8) })
  }
  let cursor = 12 + numTables * 16
  const parts: Buffer[] = [buf.subarray(off, off + 12)]
  const dir = Buffer.alloc(numTables * 16)
  recs.forEach((r, i) => {
    dir.write(r.tag, i * 16, 4, 'latin1')
    dir.writeUInt32BE(r.sum, i * 16 + 4)
    dir.writeUInt32BE(cursor, i * 16 + 8)
    dir.writeUInt32BE(r.len, i * 16 + 12)
    const data = buf.subarray(r.src, r.src + r.len)
    const pad = Buffer.alloc((4 - (r.len % 4)) % 4)
    parts.push(data, pad)
    cursor += data.length + pad.length
  })
  parts.splice(1, 0, dir)
  return Buffer.concat(parts)
}

const fontCache = new Map<string, Buffer>()
function loadFontBytes(family: PrintOptions['font']): Buffer {
  const hit = fontCache.get(family)
  if (hit) return hit
  const dir = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Fonts')
  for (const name of FONT_FILES[family]) {
    const p = path.join(dir, name)
    if (!fs.existsSync(p)) continue
    const bytes = extractTtf(fs.readFileSync(p))
    fontCache.set(family, bytes)
    return bytes
  }
  throw new Error(`未找到系统字体「${family}」，无法导出 PDF`)
}

function wrap(s: string, maxW: number, size: number, font: PDFFont): string[] {
  if (!s) return []
  const tokens = s.match(/[\x00-\x7f]+|./g) ?? []
  const lines: string[] = []
  let cur = ''
  for (const t of tokens) {
    if (cur && font.widthOfTextAtSize(cur + t, size) > maxW) { lines.push(cur); cur = t }
    else cur += t
  }
  if (cur) lines.push(cur)
  return lines
}

class Painter {
  page!: PDFPage
  constructor(private doc: PDFDocument, private font: PDFFont, readonly pw: number, readonly ph: number) {}
  newPage(): void {
    this.page = this.doc.addPage([this.pw, this.ph])
    this.page.drawRectangle({ x: 0, y: 0, width: this.pw, height: this.ph, color: PAPER })
  }
  w(s: string, size: number): number { return this.font.widthOfTextAtSize(s, size) }
  pageCount(): number { return this.doc.getPageCount() }
  base(s: string, x: number, baselineTop: number, size: number, color: RGB): void {
    if (!s) return
    this.page.drawText(s, { x, y: this.ph - baselineTop, size, font: this.font, color })
  }
  text(s: string, x: number, top: number, size: number, color: RGB): void { this.base(s, x, top + size * 0.86, size, color) }
  center(s: string, cx: number, top: number, size: number, color: RGB): void { this.text(s, cx - this.w(s, size) / 2, top, size, color) }
  spaced(s: string, cx: number, top: number, size: number, ls: number, color: RGB): void {
    const chars = [...s]
    const total = chars.reduce((a, c) => a + this.w(c, size), 0) + ls * Math.max(0, chars.length - 1)
    let x = cx - total / 2
    for (const c of chars) { this.text(c, x, top, size, color); x += this.w(c, size) + ls }
  }
  vtext(s: string, cx: number, top: number, size: number, ls: number, color: RGB): number {
    let y = top
    for (const c of [...s]) { this.center(c, cx, y, size, color); y += size + ls }
    return y - top
  }
  rot(s: string, x: number, top: number, size: number, color: RGB): void {
    if (!s) return
    this.page.drawText(s, { x, y: this.ph - top, size, font: this.font, color, rotate: degrees(-90) })
  }
  hline(x1: number, x2: number, top: number, color: RGB, width = 0.7, dash?: number[]): void {
    this.page.drawLine({ start: { x: x1, y: this.ph - top }, end: { x: x2, y: this.ph - top }, thickness: width, color, dashArray: dash })
  }
  vline(x: number, top1: number, top2: number, color: RGB, width = 0.7): void {
    this.page.drawLine({ start: { x, y: this.ph - top1 }, end: { x, y: this.ph - top2 }, thickness: width, color })
  }
  rect(x: number, top: number, w: number, h: number, o: { stroke?: RGB; fill?: RGB; width?: number; dash?: number[]; rotate?: number }): void {
    this.page.drawRectangle({
      x, y: this.ph - top - h, width: w, height: h,
      borderColor: o.stroke, color: o.fill, borderWidth: o.width ?? 0.7,
      borderDashArray: o.dash, rotate: o.rotate === undefined ? undefined : degrees(o.rotate),
    })
  }
  image(img: PDFImage, x: number, top: number, maxW: number, maxH: number): void {
    const scale = Math.min(maxW / img.width, maxH / img.height)
    const w = img.width * scale, h = img.height * scale
    this.page.drawImage(img, { x: x + (maxW - w) / 2, y: this.ph - top - (maxH + h) / 2, width: w, height: h })
  }
  svgPath(d: string, tx: number, ty: number, s: number, color: RGB, width: number, dash?: number[]): void {
    const tok = d.match(/[MVHC]|-?\d*\.?\d+/g) ?? []
    const ops: PDFOperator[] = [pushGraphicsState(), setStrokingRgbColor(color.red, color.green, color.blue), setLineWidth(width)]
    if (dash) ops.push(setDashPattern(dash, 0))
    let i = 0, cx = 0, cy = 0
    const X = (v: number): number => tx + v * s
    const Y = (v: number): number => this.ph - (ty + v * s)
    const num = (): number => Number(tok[i++])
    while (i < tok.length) {
      const cmd = tok[i++]
      if (cmd === 'M') { cx = num(); cy = num(); ops.push(moveTo(X(cx), Y(cy))) }
      else if (cmd === 'V') { cy = num(); ops.push(lineTo(X(cx), Y(cy))) }
      else if (cmd === 'H') { cx = num(); ops.push(lineTo(X(cx), Y(cy))) }
      else if (cmd === 'C') {
        const x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num()
        ops.push(appendBezierCurve(X(x1), Y(y1), X(x2), Y(y2), X(x), Y(y)))
        cx = x; cy = y
      }
    }
    ops.push(stroke(), popGraphicsState())
    this.page.pushOperators(...ops)
  }
}

function head(p: Painter, meta: GenealogyMeta, subtitle: string, pt: number): number {
  const top = MARGIN
  p.center(`${meta.name}${meta.hall ? ' · ' + meta.hall : ''} · ${subtitle}`, p.pw / 2, top, pt - 2, MUTED)
  const lineTop = top + (pt - 2) * PT_MM * MM + 3 * MM
  p.hline(MARGIN, p.pw - MARGIN, lineTop, LINE)
  return lineTop + 5 * MM
}
function volTitle(p: Painter, t: string, pt: number, top: number): number {
  p.center(t, p.pw / 2, top, pt + 3, INK)
  return top + (pt + 3) * PT_MM * MM + 5 * MM
}
function note(p: Painter, t: string, pt: number, top: number): void { p.center(t, p.pw / 2, top, pt - 2, MUTED) }

function cover(p: Painter, meta: GenealogyMeta, pt: number): void {
  p.newPage()
  const cx = p.pw / 2
  const metas = [
    meta.surname ? `姓氏 · ${meta.surname}` : '',
    meta.origin ? `籍貫 · ${meta.origin}` : '',
    meta.compiler ? `編纂 · ${meta.compiler}` : '',
  ].filter(Boolean)
  const sealH = 22 * MM
  const total = sealH + 12 * MM + (pt + 16) * PT_MM * MM + 6 * MM
    + (meta.hall ? (pt + 5) * PT_MM * MM + 14 * MM : 0)
    + metas.length * ((pt + 1) * PT_MM * MM + 2 * MM) + 16 * MM + (pt + 1) * PT_MM * MM
  let top = (p.ph - total) / 2
  p.rect(cx - sealH / 2, top, sealH, sealH, { fill: ACCENT, rotate: -3 })
  p.vtext('家譜', cx, top + 3 * MM, pt + 6, 0.8 * MM, PAPER)
  top += sealH + 12 * MM
  p.spaced(meta.name, cx, top, pt + 16, 2.1 * MM, INK)
  top += (pt + 16) * PT_MM * MM + 6 * MM
  if (meta.hall) { p.spaced(meta.hall, cx, top, pt + 5, 1.3 * MM, ACCENT); top += (pt + 5) * PT_MM * MM + 14 * MM }
  for (const m of metas) { p.center(m, cx, top, pt + 1, MUTED); top += (pt + 1) * PT_MM * MM + 2 * MM }
  top += 16 * MM
  const d = new Date()
  p.spaced(`公元 ${d.getFullYear()} 年 ${d.getMonth() + 1} 月 重修`, cx, top, pt + 1, 0.8 * MM, INK)
}

function toc(p: Painter, meta: GenealogyMeta, items: { t: string; no: number }[], total: number, vols: number, pt: number): void {
  p.newPage()
  let top = head(p, meta, '目錄', pt)
  top = volTitle(p, '目 錄', pt, top)
  for (const it of items) {
    p.text(it.t, MARGIN, top, pt + 1, INK)
    const no = String(it.no)
    p.text(no, p.pw - MARGIN - p.w(no, pt + 1), top, pt + 1, INK)
    p.hline(MARGIN + p.w(it.t, pt + 1) + 3 * MM, p.pw - MARGIN - p.w(no, pt + 1) - 3 * MM, top + (pt + 1) * PT_MM * MM * 0.7, LINE, 0.6, [0.6, 1.8])
    top += 7 * MM
  }
  note(p, `全譜共 ${total} 人 · ${vols} 卷`, pt, top + 4 * MM)
}

function zibeiDraw(p: Painter, meta: GenealogyMeta, zibei: ZibeiPoem[], pt: number): void {
  p.newPage()
  let top = head(p, meta, '字輩對照', pt)
  top = volTitle(p, '字輩對照頁', pt, top)
  const cellW = 13 * MM
  const cellH = (pt + 5) * PT_MM * MM + (pt - 2) * PT_MM * MM + 4 * MM
  const blocks = zibei.filter((z) => z.entries.length)
  if (!blocks.length) note(p, '尚未設置字輩', pt, top)
  for (const z of blocks) {
    p.text(z.branchName, MARGIN, top, pt + 1, ACCENT)
    top += (pt + 1) * PT_MM * MM + 2 * MM
    let x = MARGIN
    let rowTop = top
    for (const e of z.entries) {
      if (x + cellW > p.pw - MARGIN) { x = MARGIN; rowTop += cellH + 2 * MM }
      p.rect(x, rowTop, cellW, cellH, { stroke: LINE })
      p.center(e.char, x + cellW / 2, rowTop + 1.5 * MM, pt + 5, ACCENT)
      p.center(gen(e.generation), x + cellW / 2, rowTop + 1.5 * MM + (pt + 5) * PT_MM * MM + 1 * MM, pt - 2, MUTED)
      x += cellW + 2 * MM
    }
    top = rowTop + cellH + 7 * MM
  }
  note(p, '字輩詩逐字對應世代 · 母系外姓不校驗', pt, p.ph - MARGIN - 4 * MM)
}

interface OushiCell { id: string; col: number; row: number; span: number }
interface OushiPage { start: number; end: number; cont: boolean; row0: number; row1: number }
interface OushiPlan { cells: OushiCell[]; rowH: number[]; pages: OushiPage[]; start: number; end: number }

function oushiPlan(data: GraphData, scope: Set<string> | undefined, pt: number, cw: number, avail: number, font: PDFFont): OushiPlan[] {
  const tree = buildTree(data, scope)
  const members = tree.members
  const plans: OushiPlan[] = []
  if (!members.length) return plans
  const minGen = Math.min(...members.map((m) => m.generation))
  const maxGen = Math.max(...members.map((m) => m.generation))
  const colW = cw / 5
  const spouseName = (id: string): string => (tree.spousesOf.get(id) ?? []).map((s) => tree.byId.get(s)).filter(Boolean).map((s) => `配${s!.name}`).join(' ')
  for (let start = minGen; start <= maxGen; start += 5) {
    const end = Math.min(start + 4, maxGen)
    const inWin = new Set(members.filter((m) => m.generation >= start && m.generation <= end).map((m) => m.id))
    const kids = (id: string): string[] => (tree.childrenOf.get(id) ?? []).filter((k) => inWin.has(k))
    const leafCount = (id: string): number => { const k = kids(id); return k.length ? k.reduce((s, c) => s + leafCount(c), 0) : 1 }
    const winRoots = members.filter((m) => inWin.has(m.id) && (!tree.primaryParent.has(m.id) || !inWin.has(tree.primaryParent.get(m.id)!))).map((m) => m.id)
    const cells: OushiCell[] = []
    let cursor = 0
    const walk = (id: string, col: number): void => {
      const lc = leafCount(id)
      cells.push({ id, col, row: cursor, span: lc })
      const k = kids(id)
      if (k.length) for (const c of k) walk(c, col + 1)
      else cursor++
    }
    winRoots.forEach((r) => walk(r, tree.byId.get(r)!.generation - start))
    const subOf = (m: Member): string => {
      const jt = (tree.secondaryParents.get(m.id) ?? []).map((s) => s.subtype).join('/')
      return [years(m), jt, spouseName(m.id)].filter(Boolean).join(' · ')
    }
    const contentH = (m: Member): number => {
      const lines = wrap(subOf(m), colW - 2 * MM, pt - 2, font)
      return (pt + 1) * PT_MM * MM + (lines.length ? lines.length * (pt - 2) * PT_MM * MM * 1.4 + 1 * MM : 0) + 3.2 * MM
    }
    const rowH = new Array<number>(cursor).fill(8 * MM)
    for (const c of cells) if (c.span === 1) rowH[c.row] = Math.max(rowH[c.row], contentH(tree.byId.get(c.id)!))
    for (const c of cells) if (c.span > 1) {
      const need = contentH(tree.byId.get(c.id)!)
      let sum = 0
      for (let r = c.row; r < c.row + c.span; r++) sum += rowH[r]
      if (need > sum) rowH[c.row + c.span - 1] += need - sum
    }
    const pages: OushiPage[] = []
    let r0 = 0
    while (r0 < cursor) {
      let h = 0, r1 = r0
      while (r1 < cursor && h + rowH[r1] <= avail) { h += rowH[r1]; r1++ }
      if (r1 === r0) r1 = r0 + 1
      pages.push({ start, end, cont: pages.length > 0, row0: r0, row1: r1 })
      r0 = r1
    }
    plans.push({ cells, rowH, pages, start, end })
  }
  return plans
}

function oushiDraw(p: Painter, data: GraphData, meta: GenealogyMeta, scope: Set<string> | undefined, plans: OushiPlan[], pt: number, cw: number, font: PDFFont): void {
  const tree = buildTree(data, scope)
  const colW = cw / 5
  const spouseName = (id: string): string => (tree.spousesOf.get(id) ?? []).map((s) => tree.byId.get(s)).filter(Boolean).map((s) => `配${s!.name}`).join(' ')
  for (const plan of plans) {
    for (const pg of plan.pages) {
      p.newPage()
      let top = head(p, meta, '歐式世系表', pt)
      top = volTitle(p, `${gen(plan.start)} 至 ${gen(plan.end)}${pg.cont ? ' · 續' : ''}`, pt, top)
      const headH = 8 * MM
      for (let i = 0; i < 5; i++) {
        if (plan.start + i > plan.end) continue
        p.rect(MARGIN + i * colW, top, colW, headH, { stroke: LINE, fill: HEAD_FILL })
        p.center(gen(plan.start + i), MARGIN + i * colW + colW / 2, top + 2 * MM, pt, INK)
      }
      const tableTop = top + headH
      const rowY: number[] = [0]
      for (let r = 0; r < plan.rowH.length; r++) rowY.push(rowY[r] + plan.rowH[r])
      for (const c of plan.cells) {
        if (c.row >= pg.row1 || c.row + c.span <= pg.row0) continue
        const r0 = Math.max(c.row, pg.row0), r1 = Math.min(c.row + c.span, pg.row1)
        const y = tableTop + rowY[r0]
        const h = rowY[r1] - rowY[r0]
        const m = tree.byId.get(c.id)!
        const female = m.gender === '女'
        p.rect(MARGIN + c.col * colW, y, colW, h, { stroke: LINE })
        const jt = (tree.secondaryParents.get(c.id) ?? []).map((s) => s.subtype).join('/')
        const sub = [years(m), jt, spouseName(c.id)].filter(Boolean).join(' · ')
        const lines = wrap(sub, colW - 2 * MM, pt - 2, font)
        const contentH = (pt + 1) * PT_MM * MM + (lines.length ? lines.length * (pt - 2) * PT_MM * MM * 1.4 + 1 * MM : 0)
        let ty = y + Math.max(1.6 * MM, (h - contentH) / 2)
        if (c.row >= pg.row0 && c.row < pg.row1) {
          const nm = m.name + (female ? '（女）' : '')
          p.center(nm, MARGIN + c.col * colW + colW / 2, ty, pt + 1, female ? BLUE : INK)
          ty += (pt + 1) * PT_MM * MM + 1 * MM
          for (const ln of lines) { p.center(ln, MARGIN + c.col * colW + colW / 2, ty, pt - 2, MUTED); ty += (pt - 2) * PT_MM * MM * 1.4 }
        }
      }
      note(p, `歐式五世一表 · 次表接${gen(plan.end + 1)} · 女性同等入表`, pt, p.ph - MARGIN - 4 * MM)
    }
  }
}

interface BaotaPage { g0: number; g1: number; minY: number; maxY: number; segX: number; segW: number; s: number; segIdx: number; segCount: number }
function baotaPages(data: GraphData, scope: Set<string> | undefined, gensPerPage: number, cw: number, ch: number, pt: number): { pages: BaotaPage[]; layout: ReturnType<typeof computeLayout> } {
  const layout = computeLayout(data, new Set(), scope)
  const members = layout.nodes.map((n) => n.member)
  const pages: BaotaPage[] = []
  if (!members.length) return { pages, layout }
  const minGen = Math.min(...members.map((m) => m.generation))
  const maxGen = Math.max(...members.map((m) => m.generation))
  const headH = (pt - 2) * PT_MM * MM + 8 * MM + (pt + 3) * PT_MM * MM + 5 * MM
  const availH = ch - headH - 10 * MM
  for (let g0 = minGen; g0 <= maxGen; g0 += gensPerPage) {
    const g1 = Math.min(g0 + gensPerPage - 1, maxGen)
    const minY = (g0 - minGen) * LEVEL_H + 30 - LEVEL_H * 0.4
    const maxY = (g1 - minGen) * LEVEL_H + 30 + NODE_H + LEVEL_H * 0.4
    const bandH = (maxY - minY) * 0.75
    const bn = layout.nodes.filter((n) => n.y >= minY - 1 && n.y <= maxY)
    const minX = bn.length ? Math.min(...bn.map((n) => n.x)) : 0
    const maxX = bn.length ? Math.max(...bn.map((n) => n.x + n.w)) : layout.width
    const bandWidth = Math.max(1, maxX - minX)
    let s = Math.min(1, availH / bandH, Math.max(cw / bandWidth, 0.72))
    let segW = cw / s
    let segCount = Math.max(1, Math.ceil(bandWidth / segW))
    if (segCount > 1 && bandWidth - (segCount - 1) * segW < 0.25 * segW) {
      segCount--
      segW = bandWidth / segCount
      s = cw / segW
    }
    const segBase = segCount === 1 ? minX - (segW - bandWidth) / 2 : minX
    const bounds = [segBase]
    for (let k = 1; k < segCount; k++) {
      let b = segBase + k * segW
      const straddle = bn.filter((n) => n.x < b && n.x + n.w > b)
      if (straddle.length) b = Math.min(...straddle.map((n) => n.x)) - 8
      bounds.push(b)
    }
    bounds.push(segBase + bandWidth + (segCount === 1 ? (segW - bandWidth) / 2 : 0))
    const maxSegW = Math.max(...bounds.slice(1).map((b, i) => b - bounds[i]))
    const pageS = cw / maxSegW
    for (let k = 0; k < segCount; k++) {
      pages.push({ g0, g1, minY, maxY, segX: bounds[k], segW: bounds[k + 1] - bounds[k], s: pageS, segIdx: k, segCount })
    }
  }
  return { pages, layout }
}

function baotaDraw(p: Painter, meta: GenealogyMeta, layout: ReturnType<typeof computeLayout>, pages: BaotaPage[], pt: number, cw: number, ch: number): void {
  for (const pg of pages) {
    p.newPage()
    let top = head(p, meta, '寶塔式弔線圖', pt)
    const segLabel = pg.segCount > 1 ? ` · 接${CN[pg.segIdx] ?? pg.segIdx + 1}頁` : ''
    top = volTitle(p, `${gen(pg.g0)} 至 ${gen(pg.g1)}${segLabel}`, pt, top)
    const s = pg.s
    const tx = MARGIN + (cw - pg.segW * s) / 2 - pg.segX * s
    const bandH = (pg.maxY - pg.minY) * s
    const headH = (pt - 2) * PT_MM * MM + 8 * MM + (pt + 3) * PT_MM * MM + 5 * MM
    top += Math.max(0, (ch - headH - 10 * MM - bandH) / 2)
    const bandNodes = layout.nodes.filter((n) => n.y >= pg.minY - 1 && n.y <= pg.maxY)
    const bandIds = new Set(bandNodes.map((n) => n.id))
    const bandEdges = layout.edges.filter((e) => {
      const a = layout.nodeMap.get(e.from), b = layout.nodeMap.get(e.to)
      return (a && bandIds.has(a.id)) || (b && bandIds.has(b.id))
    })
    p.page.pushOperators(
      pushGraphicsState(),
      rectangle(MARGIN, p.ph - top - bandH, cw, bandH),
      clip(), endPath(),
    )
    for (const e of bandEdges) {
      const color = e.kind === 'dashed' ? GOLD : e.kind === 'spouse' || e.kind === 'spouseCross' ? LINE : MUTED
      p.svgPath(e.path, tx, top - pg.minY * s, s, color, Math.max(0.4, 0.9 * s), e.kind === 'dashed' ? [5 * s, 4 * s] : undefined)
    }
    const nameSize = Math.max(7, 9.75 * s)
    const subSize = Math.max(5.5, 6.75 * s)
    for (const n of bandNodes) {
      const center = n.x + n.w / 2
      if (center < pg.segX || center >= pg.segX + pg.segW) continue
      const female = n.member.gender === '女'
      const x = tx + n.x * s, y = top + (n.y - pg.minY) * s
      p.rect(x, y, n.w * s, n.h * s, { stroke: female ? BLUE : LINE, fill: n.role === 'spouse' ? HEAD_FILL : PAPER, width: Math.max(0.4, 0.75 * s) })
      const yr = years(n.member)
      p.base(n.member.name, x + (n.w * s) / 2 - p.w(n.member.name, nameSize) / 2, y + 17 * s, nameSize, INK)
      const sub = yr + (female ? ' · 女' : '')
      p.base(sub, x + (n.w * s) / 2 - p.w(sub, subSize) / 2, y + 32 * s, subSize, MUTED)
    }
    p.page.pushOperators(popGraphicsState())
    note(p, '自上而下 · 長幼有序 · 虛線為過繼 / 兼祧 · 藍框為女性', pt, p.ph - MARGIN - 4 * MM)
  }
}

interface SushiCol { g: number; cont: boolean; items: Member[] }
interface SushiLine { cx: number; entries: { m: Member; y: number; nameH: number; yr: string; yrH: number }[] }
interface SushiPlanCol { g: number; cont: boolean; items: Member[]; width: number; lines: SushiLine[]; genH: number }
interface SushiPage { cols: SushiPlanCol[]; g0: number; g1: number }

function sushiPages(data: GraphData, scope: Set<string> | undefined, pt: number, pw: number, ph: number, colsPerPage: number, namesPerCol: number, font: PDFFont): SushiPage[] {
  const tree = buildTree(data, scope)
  const members = tree.members
  const pages: SushiPage[] = []
  if (!members.length) return pages
  const minGen = Math.min(...members.map((m) => m.generation))
  const maxGen = Math.max(...members.map((m) => m.generation))
  const cols: SushiCol[] = []
  for (let g = minGen; g <= maxGen; g++) {
    const gm = members.filter((m) => m.generation === g).sort((a, b) => a.birthOrder - b.birthOrder || a.name.localeCompare(b.name, 'zh'))
    for (let i = 0; i < gm.length; i += namesPerCol) cols.push({ g, cont: i > 0, items: gm.slice(i, i + namesPerCol) })
    if (!gm.length) cols.push({ g, cont: false, items: [] })
  }
  const ch = ph - 2 * MARGIN
  const flowH = ch - 16 * MM
  const nameSize = pt + 2, subSize = pt - 3
  const nameLs = 2.25, genLs = 1.5
  const lineW = Math.max(nameSize * PT_MM * MM, subSize * PT_MM * MM) + 2 * MM
  const planCol = (c: SushiCol): SushiPlanCol => {
    const label = gen(c.g) + (c.cont ? '·續' : '')
    const genH = [...label].length * ((pt - 1) + genLs) * PT_MM * MM
    const lines: SushiLine[] = []
    let line: SushiLine = { cx: 0, entries: [] }
    let y = genH + 4 * MM
    for (const m of c.items) {
      const nameH = [...m.name].length * (nameSize + nameLs) * PT_MM * MM
      const yr = years(m)
      const yrH = yr ? font.widthOfTextAtSize(yr, subSize) * PT_MM * MM : 0
      const entryH = nameH + (yrH ? yrH + 1 * MM : 0) + 4 * MM
      if (y + entryH > flowH && line.entries.length) { lines.push(line); line = { cx: 0, entries: [] }; y = 0 }
      line.entries.push({ m, y, nameH, yr, yrH })
      y += entryH
    }
    lines.push(line)
    lines.forEach((l, i) => { l.cx = -(i * lineW) })
    return { ...c, width: 5 * MM + lines.length * lineW, lines, genH }
  }
  const planned = cols.map(planCol)
  for (let i = 0; i < planned.length; i += colsPerPage) {
    const chunk = planned.slice(i, i + colsPerPage)
    pages.push({ cols: chunk, g0: chunk[0].g, g1: chunk[chunk.length - 1].g })
  }
  return pages
}

function sushiDraw(p: Painter, meta: GenealogyMeta, pages: SushiPage[], pt: number, pw: number, ph: number): void {
  const ch = ph - 2 * MARGIN
  const flowH = ch - 16 * MM
  const nameSize = pt + 2, subSize = pt - 3
  const nameLs = 2.25, genLs = 1.5
  const lineW = Math.max(nameSize * PT_MM * MM, subSize * PT_MM * MM) + 2 * MM
  for (const pg of pages) {
    p.newPage()
    let top = head(p, meta, '蘇式垂珠體', pt)
    top = volTitle(p, `${gen(pg.g0)} 至 ${gen(pg.g1)}`, pt, top)
    const flowTop = top
    const totalW = pg.cols.reduce((s, c) => s + c.width, 0)
    let xRight = pw - MARGIN - Math.max(0, (pw - 2 * MARGIN - totalW) / 2)
    for (const c of pg.cols) {
      const colLeft = xRight - c.width
      p.vline(colLeft, flowTop, flowTop + flowH, LINE)
      const firstCx = colLeft + c.width - 2.5 * MM - lineW / 2
      const label = gen(c.g) + (c.cont ? '·續' : '')
      p.vtext(label, firstCx, flowTop + 1 * MM, pt - 1, genLs, ACCENT)
      p.hline(colLeft + 1 * MM, xRight - 1 * MM, flowTop + c.genH + 1.5 * MM, LINE)
      for (const line of c.lines) {
        const cx = firstCx + line.cx
        for (const e of line.entries) {
          const female = e.m.gender === '女'
          p.vtext(e.m.name, cx, flowTop + e.y, nameSize, nameLs, female ? BLUE : INK)
          if (e.yr) p.rot(e.yr, cx - subSize * PT_MM * MM * 0.35, flowTop + e.y + e.nameH + 0.5 * MM, subSize, MUTED)
        }
      }
      xRight = colLeft
    }
    note(p, '蘇式豎排 · 自右向左讀 · 世代為列，人名為珠 · 藍字為女性', pt, p.ph - MARGIN - 4 * MM)
  }
}

function p1Head(p: Painter, meta: GenealogyMeta, title: string, subtitle: string, pt: number): number {
  const top = MARGIN
  const running = `${meta.name}${meta.hall ? ' · ' + meta.hall : ''} · ${subtitle}`.replace(/\s+/g, ' ')
  p.center(running, p.pw / 2, top, pt - 2, MUTED)
  const lineTop = top + (pt - 2) * PT_MM * MM * 1.5 + 3 * MM
  p.hline(MARGIN, p.pw - MARGIN, lineTop, LINE)
  p.center(title.replace(/\s+/g, ' '), p.pw / 2, lineTop + 7 * MM, pt + 3, INK)
  // Keep the same content origin as the explicit HTML page plan.
  const runningH = (pt - 2) * PT_MM * MM * 1.5 + 3 * MM + 0.25 * MM
  return top + runningH + 7 * MM + (pt + 3) * PT_MM * MM * 1.5 + 5 * MM
}

function p1Folio(p: Painter, no: number, pt: number): void {
  p.center(String(no), p.pw / 2, p.ph - MARGIN - 4 * MM, pt - 2, MUTED)
}

function truncatePdf(s: string, maxW: number, size: number, font: PDFFont): string {
  const text = s.replace(/\s+/g, ' ').trim()
  if (font.widthOfTextAtSize(text, size) <= maxW) return text
  const chars = Array.from(text)
  while (chars.length && font.widthOfTextAtSize(chars.join('') + '…', size) > maxW) chars.pop()
  return chars.join('') + '…'
}

async function trustedPortraitDir(payload: PdfPayload): Promise<string | undefined> {
  let electron: typeof import('electron') | null = null
  try { electron = await import('electron') } catch { return payload.photoDir }
  // Plain Node tests do not have Electron's app object; production derives the
  // current genealogy directory from persisted settings instead of trusting IPC.
  if (!electron.app?.getPath) return payload.photoDir
  try {
    const userData = electron.app.getPath('userData')
    let dataDir = path.join(userData, 'genealogies')
    try {
      const config = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')) as { dataDir?: string }
      if (config.dataDir) dataDir = path.resolve(config.dataDir)
    } catch { /* DataStore uses the same default for a missing/invalid config. */ }
    const id = payload.meta.id
    if (!id || id !== path.basename(id) || /[\\/]/.test(id)) return undefined
    const expected = path.resolve(dataDir, id)
    return expected
  } catch { return undefined }
}

function portraitFile(photoDir: string | undefined, relPath: string): string | null {
  if (!photoDir || !relPath) return null
  try {
    const root = path.resolve(photoDir)
    const photos = path.resolve(root, 'photos')
    const full = path.resolve(root, relPath)
    if (!full.startsWith(photos + path.sep)) return null
    const stat = fs.statSync(full)
    if (!stat.isFile() || stat.size > 40 * 1024 * 1024) return null
    return full
  } catch { return null }
}

async function embedPortrait(doc: PDFDocument, file: string): Promise<PDFImage | null> {
  try {
    const bytes = fs.readFileSync(file)
    const ext = path.extname(file).toLowerCase()
    if (ext === '.jpg' || ext === '.jpeg') return await doc.embedJpg(bytes)
    if (ext === '.png') return await doc.embedPng(bytes)
    // Electron's decoder covers the other formats accepted by photo upload.
    const { nativeImage } = await import('electron')
    const image = nativeImage.createFromBuffer(bytes)
    if (image.isEmpty()) return null
    return await doc.embedPng(image.toPNG())
  } catch { return null }
}

async function loadPortraits(doc: PDFDocument, payload: PdfPayload, members: Member[]): Promise<Map<string, PDFImage>> {
  const out = new Map<string, PDFImage>()
  const photoDir = await trustedPortraitDir(payload)
  if (!photoDir) return out
  for (const m of members) {
    if (!m.photoPath || out.has(m.id)) continue
    const file = portraitFile(photoDir, m.photoPath)
    if (!file) continue
    const image = await embedPortrait(doc, file)
    if (image) out.set(m.id, image)
  }
  return out
}

async function biographyDraw(p: Painter, payload: PdfPayload, pages: BiographyPagePlan[], pt: number, cw: number, portraits: Map<string, PDFImage>): Promise<void> {
  const metrics = p1Metrics(payload.opts)
  const lineH = metrics.lineH * MM
  const photoW = metrics.photoW * MM, photoH = metrics.photoH * MM
  for (const pg of pages) {
    p.newPage()
    const title = `${pg.memberName}传${pg.continuation ? '（续）' : ''}`
    let top = p1Head(p, payload.meta, title, '人物传记', pt)
    const layoutTop = top
    if (pg.photo) {
      const x = MARGIN + cw - photoW
      p.rect(x, top, photoW, photoH, { stroke: LINE })
      const image = portraits.get(pg.memberId)
      if (image) p.image(image, x, top, photoW, photoH)
    }
    for (const line of pg.profile) {
      p.text(line, MARGIN, top, pt, INK)
      top += lineH
    }
    top = layoutTop + Math.max(pg.profile.length * lineH, pg.photo ? photoH : 0) + (pg.profile.length || pg.photo ? 2 * MM : 0)
    for (const line of pg.body) {
      if (line.section) p.text(line.text, MARGIN, top, pt, ACCENT)
      else if (line.text) p.text(line.text, MARGIN + 2 * pt * PT_MM * MM, top, pt, INK)
      top += lineH
    }
    p1Folio(p, p.pageCount(), pt)
  }
  if (!pages.length) {
    p.newPage()
    const top = p1Head(p, payload.meta, '人物传记', '人物传记', pt)
    note(p, '所選範圍內暫無成員', pt, top)
    p1Folio(p, p.pageCount(), pt)
  }
}

function rosterDraw(p: Painter, payload: PdfPayload, plan: RosterPlan, pt: number, cw: number, font: PDFFont, folioOffset: number, total: number): void {
  const metrics = p1Metrics(payload.opts)
  const widths = rosterColumnWidths(plan.fields, cw / MM).map((w) => w * MM)
  const labels = new Map(ROSTER_FIELD_DEFS.map((f) => [f.key, f.label]))
  if (!plan.pages.length) {
    p.newPage()
    const top = p1Head(p, payload.meta, '成员名录', '成员名录', pt)
    note(p, '所選範圍內暫無成員', pt, top)
    p1Folio(p, folioOffset + 1, pt)
    return
  }
  plan.pages.forEach((pg, pageIndex) => {
    p.newPage()
    const title = `成员名录${plan.pages.length > 1 ? ` · 第${pageIndex + 1}页` : ''}`
    let top = p1Head(p, payload.meta, title, '成员名录', pt)
    const headH = plan.headerH * MM
    let x = MARGIN
    plan.fields.forEach((field, i) => {
      p.rect(x, top, widths[i], headH, { stroke: LINE, fill: HEAD_FILL })
      p.center(labels.get(field)!, x + widths[i] / 2, top + 2 * MM, pt, INK)
      x += widths[i]
    })
    top += headH
    const rowH = plan.rowH * MM
    for (const row of pg.rows) {
      let cx = MARGIN
      plan.fields.forEach((field, i) => {
        p.rect(cx, top, widths[i], rowH, { stroke: LINE })
        const value = truncatePdf(row.values[field] || '—', widths[i] - 2.4 * MM, pt - 1, font)
        p.text(value, cx + 1.2 * MM, top + (rowH - (pt - 1) * PT_MM * MM) / 2, pt - 1, INK)
        cx += widths[i]
      })
      top += rowH
    }
    note(p, `一行一人 · 共 ${total} 人 · 空值以「—」標示`, pt, p.ph - MARGIN - 8 * MM)
    p1Folio(p, folioOffset + pageIndex + 1, pt)
  })
}

function layoutLabel(layout: PrintOptions['layout']): string {
  if (layout === 'baota') return '寶塔式弔線圖'
  if (layout === 'oushi') return '歐式橫表·五世一表'
  if (layout === 'biography') return '人物傳記式'
  if (layout === 'roster') return '名錄簡表式'
  return '蘇式垂珠體·豎排'
}

export async function buildPdf(payload: PdfPayload): Promise<Uint8Array> {
  const { data, meta, branches, zibei, opts } = payload
  const [w, h] = PAPER_MM[opts.paper]
  const pw = (opts.landscape ? h : w) * MM
  const ph = (opts.landscape ? w : h) * MM
  const cw = pw - 2 * MARGIN, ch = ph - 2 * MARGIN
  const pt = FONT_PT[opts.fontSize]
  const scope = scopeIds(data, branches, opts.scope)
  const filtered = scopeMembers(data, branches, opts.scope)
  const folioOffset = (opts.cover ? 1 : 0) + (opts.toc ? 1 : 0) + (opts.zibeiPage ? 1 : 0)

  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const font = await doc.embedFont(loadFontBytes(opts.font), { subset: true })
  const p = new Painter(doc, font, pw, ph)

  const gensPerPage = opts.landscape ? 3 : opts.paper === 'A3' ? 5 : 4
  const perNameMm = 3 * (pt + 2) * PT_MM + 9 * (pt - 3) * PT_MM * 0.6 + 4
  const colsPerPage = Math.max(4, Math.floor((pw / MM - 28) / 22))
  const namesPerCol = Math.max(3, Math.floor((ph / MM - 56) / perNameMm))

  let mainPages = 0
  let volumes: { label: string; first: number }[] = []
  let drawMain: () => void | Promise<void> = () => {}
  if (opts.layout === 'biography') {
    const pages = planBiographyPages(data, branches, filtered, opts)
    mainPages = Math.max(1, pages.length)
    volumes = pages.length ? [{ label: '人物傳記', first: 0 }] : []
    drawMain = async () => {
      const portraits = await loadPortraits(doc, payload, filtered)
      await biographyDraw(p, payload, pages, pt, cw, portraits)
    }
  } else if (opts.layout === 'roster') {
    const plan = planRosterPages(data, branches, zibei, filtered, opts)
    mainPages = Math.max(1, plan.pages.length)
    volumes = plan.pages.length ? [{ label: '成員名錄', first: 0 }] : []
    drawMain = () => rosterDraw(p, payload, plan, pt, cw, font, folioOffset, filtered.length)
  } else if (opts.layout === 'oushi') {
    const headH = (pt - 2) * PT_MM * MM + 8 * MM + (pt + 3) * PT_MM * MM + 5 * MM + 8 * MM
    const plans = oushiPlan(data, scope, pt, cw, ch - headH - 10 * MM, font)
    mainPages = plans.reduce((s, x) => s + x.pages.length, 0)
    let acc = 0
    volumes = plans.map((x) => { const v = { label: `${gen(x.start)}至${gen(x.end)}`, first: acc }; acc += x.pages.length; return v })
    drawMain = () => oushiDraw(p, data, meta, scope, plans, pt, cw, font)
  } else if (opts.layout === 'baota') {
    const { pages, layout } = baotaPages(data, scope, gensPerPage, cw, ch, pt)
    mainPages = pages.length
    volumes = []
    pages.forEach((x, i) => {
      if (x.segIdx === 0) volumes.push({ label: `${gen(x.g0)}至${gen(x.g1)}`, first: i })
    })
    drawMain = () => baotaDraw(p, meta, layout, pages, pt, cw, ch)
  } else if (opts.layout === 'sushi') {
    const pages = sushiPages(data, scope, pt, pw, ph, colsPerPage, namesPerCol, font)
    mainPages = pages.length
    let acc = 0
    volumes = pages.map((x) => { const v = { label: `${gen(x.g0)}至${gen(x.g1)}`, first: acc }; acc += 1; return v })
    drawMain = () => sushiDraw(p, meta, pages, pt, pw, ph)
  }

  const base = (opts.cover ? 1 : 0) + (opts.toc ? 1 : 0)
  const mainStart = base + (opts.zibeiPage ? 1 : 0) + 1
  if (opts.cover) cover(p, meta, pt)
  if (opts.toc) {
    const items: { t: string; no: number }[] = []
    const layoutName = layoutLabel(opts.layout)
    if (opts.zibeiPage) items.push({ t: '字輩對照頁', no: base + 1 })
    volumes.forEach((v, i) => items.push({ t: `${layoutName} · 卷${CN[i] ?? i + 1}（${v.label}）`, no: mainStart + v.first }))
    toc(p, meta, items, filtered.length, volumes.length, pt)
  }
  if (opts.zibeiPage) zibeiDraw(p, meta, zibei, pt)
  await drawMain()
  if (!mainPages) { p.newPage(); note(p, '所選範圍內暫無成員', pt, ph / 2) }
  return doc.save()
}