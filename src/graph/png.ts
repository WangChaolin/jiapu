import type { GenealogyMeta, GraphData, GraphPngOptions, Member } from '../../electron/shared/types'
import { computeLayout, NODE_H, NODE_W } from './layout.ts'

export const MAX_GRAPH_DIMENSION = 32767
export const MAX_GRAPH_PIXELS = 64 * 1024 * 1024

export interface GraphPngSvgResult {
  svg: string
  width: number
  height: number
}

const BACKGROUNDS: Record<GraphPngOptions['background'], string | null> = {
  white: '#ffffff',
  rice: '#fbf7ec',
  transparent: null,
}

function escapeXml(value: unknown): string {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '\uFFFD')
    .replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char]!))
}

function fmt(value: number): string {
  return Number(value.toFixed(3)).toString()
}

function years(member: Member): string {
  const birth = /^(\d{4})/.exec(member.birthDate)?.[1] ?? ''
  const death = /^(\d{4})/.exec(member.deathDate)?.[1] ?? ''
  if (!birth && !death) return ''
  if (birth && death) return `${birth}–${death}`
  if (birth) return member.alive ? `${birth}–` : `${birth}–？`
  return `？–${death}`
}

function timestamp(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

function outputSize(width: number, height: number, scale: GraphPngOptions['scale']): { width: number; height: number } {
  if (scale !== 1 && scale !== 2 && scale !== 4) throw new Error('图谱导出倍率仅支持 1、2、4 倍')
  const outWidth = Math.max(1, Math.round(width * scale))
  const outHeight = Math.max(1, Math.round(height * scale))
  if (
    !Number.isFinite(outWidth) || !Number.isFinite(outHeight)
    || outWidth > MAX_GRAPH_DIMENSION || outHeight > MAX_GRAPH_DIMENSION
    || outWidth * outHeight > MAX_GRAPH_PIXELS
  ) {
    throw new Error(
      `图谱导出尺寸过大：${outWidth} × ${outHeight} 像素；单边上限 ${MAX_GRAPH_DIMENSION}，总像素上限 ${MAX_GRAPH_PIXELS}。请缩小范围或倍率。`,
    )
  }
  return { width: outWidth, height: outHeight }
}

interface LegendItem {
  label: string
  draw: (x: number, y: number) => string
}

function legendSvg(x: number, bottom: number, availableWidth: number): string {
  const items: LegendItem[] = [
    { label: '血缘世系', draw: (lx, ly) => `<path d="M ${lx} ${ly} H ${lx + 22}" fill="none" stroke="#6f6353" stroke-width="1.4"/>` },
    { label: '过继 / 兼祧', draw: (lx, ly) => `<path d="M ${lx} ${ly} H ${lx + 22}" fill="none" stroke="#9c7a35" stroke-width="1.4" stroke-dasharray="5 4"/>` },
    { label: '配偶', draw: (lx, ly) => `<path d="M ${lx + 8} ${ly - 4} V ${ly + 4} M ${lx + 12} ${ly - 4} V ${ly + 4}" fill="none" stroke="#8a7a5f" stroke-width="1.2"/>` },
    { label: '女性成员', draw: (lx, ly) => `<rect x="${lx + 5}" y="${ly - 5}" width="12" height="10" fill="#fbf7ec" stroke="#3d5468" stroke-width="1.2"/>` },
  ]
  const itemWidth = (item: LegendItem): number => 30 + [...item.label].length * 11 + 14
  const rows: LegendItem[][] = []
  let row: LegendItem[] = []
  let used = 0
  for (const item of items) {
    const width = itemWidth(item)
    if (row.length && used + width > availableWidth) { rows.push(row); row = []; used = 0 }
    row.push(item)
    used += width
  }
  if (row.length) rows.push(row)

  const lines: string[] = []
  rows.forEach((entries, rowIndex) => {
    const y = bottom - (rows.length - 1 - rowIndex) * 19
    let lx = x
    for (const item of entries) {
      lines.push(item.draw(lx, y))
      lines.push(`<text x="${lx + 30}" y="${y + 4}" font-size="11" fill="#6f6353">${escapeXml(item.label)}</text>`)
      lx += itemWidth(item)
    }
  })
  return lines.join('')
}

export function buildGraphPngSvg(
  data: GraphData,
  meta: GenealogyMeta,
  opts: GraphPngOptions,
): GraphPngSvgResult {
  const visible = new Set(opts.visibleIds)
  const layout = computeLayout(data, new Set(), visible, opts.orientation)
  const { nodes, edges } = layout
  let view: { x: number; y: number; width: number; height: number }
  if (opts.scope === 'viewport') {
    view = {
      x: Number(opts.viewBox.x),
      y: Number(opts.viewBox.y),
      width: Number(opts.viewBox.width),
      height: Number(opts.viewBox.height),
    }
  } else {
    view = { x: 0, y: 0, width: layout.width, height: layout.height }
  }
  if (![view.x, view.y, view.width, view.height].every(Number.isFinite) || view.width <= 0 || view.height <= 0) {
    throw new Error('图谱视口尺寸无效：x、y 必须为有限数，width、height 必须为有限正数')
  }
  const size = outputSize(view.width, view.height, opts.scale)
  const background = BACKGROUNDS[opts.background]
  if (opts.background !== 'transparent' && !background) throw new Error('不支持的图谱背景类型')

  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="${fmt(view.x)} ${fmt(view.y)} ${fmt(view.width)} ${fmt(view.height)}" preserveAspectRatio="xMidYMin meet" shape-rendering="geometricPrecision">`)
  parts.push('<title>家谱图谱</title>')
  parts.push('<desc>当前可见家谱成员及关系</desc>')
  if (background) {
    parts.push(`<rect data-background="${opts.background}" x="${fmt(view.x)}" y="${fmt(view.y)}" width="${fmt(view.width)}" height="${fmt(view.height)}" fill="${background}"/>`)
  }

  parts.push('<g font-family="Microsoft YaHei, SimSun, Songti SC, serif" stroke-linecap="round" stroke-linejoin="round">')
  for (const edge of edges) {
    const stroke = edge.kind === 'dashed' ? '#9c7a35' : edge.kind === 'spouse' || edge.kind === 'spouseCross' ? '#8a7a5f' : '#6f6353'
    const dash = edge.kind === 'dashed' || edge.kind === 'spouseCross' ? ' stroke-dasharray="5 4"' : ''
    parts.push(`<path data-edge-id="${escapeXml(edge.id)}" data-edge-kind="${edge.kind}" d="${edge.path}" fill="none" stroke="${stroke}" stroke-width="1.3"${dash}/>`)
  }
  for (const node of nodes) {
    const female = node.member.gender === '女'
    const stroke = female ? '#3d5468' : '#8a7a5f'
    const fill = node.role === 'spouse' ? '#efe7d2' : '#fffdf7'
    const cx = node.x + node.w / 2
    const sub = [years(node.member), female ? '女' : ''].filter(Boolean).join(' · ')
    parts.push(`<g data-node-id="${escapeXml(node.id)}">`)
    parts.push(`<title>${escapeXml(node.member.name)}</title>`)
    parts.push(`<rect x="${fmt(node.x)}" y="${fmt(node.y)}" width="${node.w}" height="${node.h}" rx="4" fill="${fill}" stroke="${stroke}" stroke-width="1.2"/>`)
    parts.push(`<text x="${fmt(cx)}" y="${fmt(node.y + 17)}" text-anchor="middle" font-size="13" font-weight="500" fill="#2b2620">${escapeXml(node.member.name)}</text>`)
    if (sub) parts.push(`<text x="${fmt(cx)}" y="${fmt(node.y + NODE_H - 10)}" text-anchor="middle" font-size="9" fill="#6f6353">${escapeXml(sub)}</text>`)
    if (female) parts.push(`<text x="${fmt(node.x + 5)}" y="${fmt(node.y + 12)}" font-size="9" fill="#3d5468">女</text>`)
    if (node.collapsed) {
      parts.push(`<rect x="${fmt(node.x + NODE_W - 29)}" y="${fmt(node.y + 4)}" width="25" height="13" rx="3" fill="#8a7a5f"/>`)
      parts.push(`<text x="${fmt(node.x + NODE_W - 16.5)}" y="${fmt(node.y + 13.5)}" text-anchor="middle" font-size="9" fill="#ffffff">+${node.hiddenCount}</text>`)
    }
    parts.push('</g>')
  }
  parts.push('</g>')

  const left = view.x + 12
  const right = view.x + view.width - 12
  const top = view.y + 12
  const bottom = view.y + view.height - 12
  const plate = background ?? '#ffffff'
  if (opts.title) {
    const title = `${meta.name || '家谱'}${meta.hall ? ` · ${meta.hall}` : ''}`
    parts.push(`<g><rect x="${fmt(left - 5)}" y="${fmt(top - 13)}" width="${fmt(Math.max(0, Math.min(view.width - 14, Math.max(150, [...title].length * 18 + 20))))}" height="36" rx="4" fill="${plate}" fill-opacity="0.9"/>`)
    parts.push(`<text x="${fmt(left + 3)}" y="${fmt(top + 5)}" font-family="Microsoft YaHei, SimSun, Songti SC, serif" font-size="18" font-weight="600" fill="#2b2620">${escapeXml(title)}</text>`)
    if (meta.hall) parts.push(`<text x="${fmt(left + 3)}" y="${fmt(top + 21)}" font-family="Microsoft YaHei, SimSun, Songti SC, serif" font-size="10" fill="#8f2f1f">${escapeXml(meta.hall)}</text>`)
    parts.push('</g>')
  }
  if (opts.timestamp) {
    const label = `导出时间：${timestamp()}`
    parts.push(`<text x="${fmt(right)}" y="${fmt(bottom)}" text-anchor="end" font-family="Microsoft YaHei, SimSun, Songti SC, serif" font-size="10" fill="#6f6353" stroke="${plate}" stroke-width="4" paint-order="stroke">${escapeXml(label)}</text>`)
  }
  if (opts.legend) {
    const reserved = opts.timestamp ? 180 : 0
    parts.push(`<g font-family="Microsoft YaHei, SimSun, Songti SC, serif">${legendSvg(left, bottom - (opts.timestamp ? 8 : 0), Math.max(120, view.width - 24 - reserved))}</g>`)
  }
  parts.push('</svg>')
  return { svg: parts.join(''), width: size.width, height: size.height }
}
