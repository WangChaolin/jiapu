import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { GenealogyDb, GedcomImportCommit, GedcomImportMember, GedcomImportRelation } from './db.ts'
import type {
  GenealogyMeta, GedcomAnalyzeOptions, GedcomCommitResult, GedcomExportOptions,
  GedcomExportPreview, GedcomIssue, GedcomPreview, GedcomPreviewMember,
} from '../shared/types.ts'

const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_PHOTO_BYTES = 20 * 1024 * 1024
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])
const MONTHS: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
}
const SUPPORTED_TAGS = new Set([
  'HEAD', 'TRLR', 'GEDC', 'VERS', 'FORM', 'CHAR', 'LANG', 'SOUR', 'SUBM', 'NOTE', 'CONT', 'CONC',
  'INDI', 'FAM', 'NAME', 'GIVN', 'SURN', 'NPFX', 'NSFX', 'SPFX', 'SEX', 'BIRT', 'DEAT', 'BIRT', 'CHR',
  'BAPM', 'BARM', 'BASM', 'BLES', 'BURI', 'CENS', 'CREM', 'ADOP', 'BAPL', 'CONL', 'ENDL', 'EPLG',
  'FCOM', 'ORDN', 'NATU', 'EMIG', 'IMMI', 'PROB', 'WILL', 'GRAD', 'RETI', 'EVEN', 'OCCU', 'RESI',
  'EDUC', 'NATI', 'DSCR', 'IDNO', 'NMR', 'NCHI', 'PROP', 'RELI', 'SSN', 'TITL', 'NICK', 'BIOG',
  'DATE', 'PLAC', 'ADDR', 'OBJE', 'FILE', 'FORM', 'TITL', 'HUSB', 'WIFE', 'CHIL', 'PEDI', 'MARR',
  'DIV', 'DIVF', 'ANUL', 'ENGA', 'MARB', 'MARC', 'MARL', 'MARS', 'MARR', 'CENS', 'FAMC', 'FAMS',
  'PEDI', 'ADOP', 'FREL', 'MREL', 'STAT', 'TYPE', 'AGE', 'AGNC', 'CAUS', 'QUAY', 'CALN', 'MEDI',
])

interface GNode {
  level: number
  tag: string
  xref?: string
  value: string
  line: number
  children: GNode[]
}

interface ParsedGedcom {
  root: GNode
  records: GNode[]
  issues: GedcomIssue[]
}

interface Individual {
  sourceId: string
  line: number
  name: string
  gender: '男' | '女' | '其他'
  birthDate: string
  deathDate: string
  alive: boolean
  courtesyName: string
  title: string
  occupation: string
  residence: string
  burial: string
  biography: string
  remark: string
  birthPlace: string
  deathPlace: string
  photos: string[]
  unsupported: string[]
}

interface Family {
  sourceId: string
  line: number
  husband?: string
  wife?: string
  children: { sourceId: string; node: GNode }[]
  unsupported: string[]
}

interface PhotoRef {
  sourceId: string
  rawPath: string
  resolvedPath: string
  line: number
}

export interface GedcomAnalysis {
  preview: GedcomPreview
  members: GedcomImportMember[]
  relations: GedcomImportRelation[]
  photos: PhotoRef[]
}

export interface GedcomPhotoIo {
  savePhoto: (sourcePath: string) => string
  deletePhoto: (relPath: string) => void
}

export interface GedcomExportResult {
  content: string
  photos: { sourcePath: string; targetRelative: string }[]
  warnings: string[]
  memberCount: number
  familyCount: number
  photoCount: number
}

function sha256(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function checkFile(filePath: string): void {
  if (path.extname(filePath).toLowerCase() !== '.ged') throw new Error('仅支持 .ged 格式的 GEDCOM 文件')
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) throw new Error('所选路径不是文件')
  if (stat.size > MAX_FILE_BYTES) throw new Error('GEDCOM 文件超过 50MB 限制')
}

function decodeText(buffer: Buffer): { text: string; encoding: string; issues: GedcomIssue[] } {
  const issues: GedcomIssue[] = []
  let text = ''
  let encoding = 'UTF-8'
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    text = buffer.subarray(3).toString('utf8')
  } else if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    text = buffer.subarray(2).toString('utf16le')
    encoding = 'UTF-16LE'
  } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2))
    swapped.swap16()
    text = swapped.toString('utf16le')
    encoding = 'UTF-16BE'
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch {
      try {
        text = new TextDecoder('gb18030', { fatal: true }).decode(buffer)
        encoding = 'GBK / ANSI'
      } catch {
        throw new Error('无法识别文件编码，请将 GEDCOM 另存为 UTF-8 后重试')
      }
    }
  }
  if (text.includes('\uFFFD')) issues.push({ rowNumber: 1, field: 'CHAR', value: '', level: 'warning', message: '检测到乱码替换字符，建议检查源文件编码' })
  return { text: text.replace(/^\uFEFF/, ''), encoding, issues }
}

function parseGedcom(text: string): ParsedGedcom {
  const root: GNode = { level: -1, tag: 'ROOT', value: '', line: 0, children: [] }
  const stack: GNode[] = [root]
  const issues: GedcomIssue[] = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]
    if (!raw.trim()) continue
    const match = raw.match(/^(\d+)\s+(.+)$/)
    if (!match) {
      issues.push({ rowNumber: index + 1, field: 'LINE', value: raw.slice(0, 120), level: 'error', message: '无法解析 GEDCOM 行，已跳过' })
      continue
    }
    const level = Number(match[1])
    const rest = match[2]
    let xref: string | undefined
    let tag = ''
    let value = ''
    const xrefFirst = rest.match(/^(@[^@]+@)\s+([A-Za-z0-9_]+)(?:\s(.*))?$/)
    const tagFirst = rest.match(/^([A-Za-z0-9_]+)(?:\s+(@[^@]+@))?(?:\s(.*))?$/)
    if (xrefFirst) {
      xref = xrefFirst[1]
      tag = xrefFirst[2].toUpperCase()
      value = xrefFirst[3] ?? ''
    } else if (tagFirst) {
      tag = tagFirst[1].toUpperCase()
      xref = tagFirst[2]
      value = tagFirst[3] ?? ''
    } else {
      issues.push({ rowNumber: index + 1, field: 'LINE', value: raw.slice(0, 120), level: 'error', message: '无法解析 GEDCOM 行，已跳过' })
      continue
    }
    if (tag === 'CONT' || tag === 'CONC') {
      const prev = stack[stack.length - 1]
      if (prev && prev !== root) prev.value += tag === 'CONT' ? `\n${value}` : value
      continue
    }
    while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop()
    const parent = stack[stack.length - 1]
    const node: GNode = { level, tag, xref, value, line: index + 1, children: [] }
    parent.children.push(node)
    stack.push(node)
  }
  const records = root.children.filter((n) => n.level === 0)
  if (!records.length) throw new Error('文件中没有可识别的 GEDCOM 记录')
  return { root, records, issues }
}

function child(node: GNode | undefined, tag: string): GNode | undefined {
  return node?.children.find((n) => n.tag === tag.toUpperCase())
}

function children(node: GNode | undefined, tag: string): GNode[] {
  return node?.children.filter((n) => n.tag === tag.toUpperCase()) ?? []
}

function nodeText(node: GNode | undefined): string {
  return node?.value.trim() ?? ''
}

function parseName(node: GNode | undefined): string {
  if (!node) return ''
  const raw = node.value.replace(/\/.*$/, '').trim()
  if (raw) return raw
  return [nodeText(child(node, 'GIVN')), nodeText(child(node, 'SURN'))].filter(Boolean).join('')
}

function parseGender(value: string): '男' | '女' | '其他' {
  const v = value.trim().toUpperCase()
  if (v === 'M' || v === '男') return '男'
  if (v === 'F' || v === '女') return '女'
  return '其他'
}

function pad(value: number): string { return String(value).padStart(2, '0') }

function parseGedcomDate(raw: string): { date: string; warning?: string } {
  let value = raw.trim().toUpperCase()
  if (!value) return { date: '' }
  value = value.replace(/^(ABT|ABOUT|CAL|CALCULATED|EST|ESTIMATED)\s+/, '')
  let qualifier = ''
  if (/^(BEF|BEFORE|AFT|AFTER)\s+/.test(value)) {
    qualifier = value.split(/\s+/)[0]
    value = value.replace(/^(BEF|BEFORE|AFT|AFTER)\s+/, '')
  } else if (/^BET\s+/.test(value)) {
    value = value.replace(/^BET\s+/, '').split(/\s+AND\s+/)[0]
    qualifier = 'BET'
  } else if (/^FROM\s+/.test(value)) {
    value = value.replace(/^FROM\s+/, '').split(/\s+TO\s+/)[0]
    qualifier = 'FROM'
  }
  let match = value.match(/^(\d{1,2})\s+([A-Z]{3,9})\s+(\d{3,4})$/)
  if (match && MONTHS[match[2].slice(0, 3)]) {
    const day = Number(match[1]), month = Number(MONTHS[match[2].slice(0, 3)]), year = Number(match[3])
    const iso = `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`
    const check = new Date(Date.UTC(year, month - 1, day))
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return { date: '', warning: `日期无效：${raw}` }
    return { date: iso, warning: qualifier ? `日期限定符 ${qualifier} 已忽略：${raw}` : undefined }
  }
  match = value.match(/^([A-Z]{3,9})\s+(\d{3,4})$/)
  if (match && MONTHS[match[1].slice(0, 3)]) return { date: `${match[2]}-${MONTHS[match[1].slice(0, 3)]}`, warning: `日期仅精确到月：${raw}` }
  match = value.match(/^(\d{3,4})$/)
  if (match) return { date: match[1], warning: `日期仅精确到年：${raw}` }
  match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (match) {
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
    const check = new Date(Date.UTC(year, month - 1, day))
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return { date: '', warning: `日期无效：${raw}` }
    return { date: `${match[1]}-${pad(month)}-${pad(day)}` }
  }
  return { date: '', warning: `无法解析日期：${raw}` }
}

function eventPlace(event: GNode | undefined): string {
  return nodeText(child(event, 'PLAC')) || nodeText(event)
}

function collectUnsupported(node: GNode): string[] {
  const result: string[] = []
  const walk = (n: GNode): void => {
    for (const c of n.children) {
      if (c.tag.startsWith('_') || !SUPPORTED_TAGS.has(c.tag)) result.push(`${c.tag}${c.value ? ` ${c.value}` : ''}`.trim())
      walk(c)
    }
  }
  walk(node)
  return result
}

function parseIndividual(node: GNode, index: number): Individual {
  const name = parseName(child(node, 'NAME'))
  const gender = parseGender(nodeText(child(node, 'SEX')))
  const birth = child(node, 'BIRT')
  const death = child(node, 'DEAT')
  const birthParsed = parseGedcomDate(nodeText(child(birth, 'DATE')))
  const deathParsed = parseGedcomDate(nodeText(child(death, 'DATE')))
  const notes = children(node, 'NOTE').map(nodeText).filter(Boolean)
  const biography = nodeText(child(node, 'BIOG'))
  if (!biography && notes.some((n) => n.length >= 80)) {
    const long = notes.find((n) => n.length >= 80)!
    notes.splice(notes.indexOf(long), 1)
    return {
      sourceId: node.xref ?? `I${index + 1}`, line: node.line, name, gender,
      birthDate: birthParsed.date, deathDate: deathParsed.date, alive: !death,
      courtesyName: nodeText(child(node, 'NICK')), title: nodeText(child(node, 'TITL')),
      occupation: nodeText(child(node, 'OCCU')), residence: eventPlace(child(node, 'RESI')),
      burial: eventPlace(child(node, 'BURI')), biography: long, remark: notes.join('\n'),
      birthPlace: eventPlace(birth), deathPlace: eventPlace(death),
      photos: children(node, 'OBJE').map((o) => nodeText(child(o, 'FILE')) || nodeText(o)).filter(Boolean),
      unsupported: collectUnsupported(node),
    }
  }
  return {
    sourceId: node.xref ?? `I${index + 1}`, line: node.line, name, gender,
    birthDate: birthParsed.date, deathDate: deathParsed.date, alive: !death,
    courtesyName: nodeText(child(node, 'NICK')), title: nodeText(child(node, 'TITL')),
    occupation: nodeText(child(node, 'OCCU')), residence: eventPlace(child(node, 'RESI')),
    burial: eventPlace(child(node, 'BURI')), biography, remark: notes.join('\n'),
    birthPlace: eventPlace(birth), deathPlace: eventPlace(death),
    photos: children(node, 'OBJE').map((o) => nodeText(child(o, 'FILE')) || nodeText(o)).filter(Boolean),
    unsupported: collectUnsupported(node),
  }
}

function parseFamily(node: GNode, index: number): Family {
  return {
    sourceId: node.xref ?? `F${index + 1}`, line: node.line,
    husband: child(node, 'HUSB')?.xref, wife: child(node, 'WIFE')?.xref,
    children: children(node, 'CHIL').filter((c) => c.xref).map((c) => ({ sourceId: c.xref!, node: c })),
    unsupported: collectUnsupported(node),
  }
}

function addIssue(issues: GedcomIssue[], issue: GedcomIssue): void { issues.push(issue) }

function resolvePhoto(filePath: string, rawPath: string): string | null {
  const cleaned = rawPath.trim().replace(/\\/g, '/')
  if (!cleaned) return null
  const resolved = path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(path.dirname(filePath), cleaned)
  try {
    const stat = fs.statSync(resolved)
    if (!stat.isFile() || stat.size > MAX_PHOTO_BYTES || !PHOTO_EXTS.has(path.extname(resolved).toLowerCase())) return null
    return resolved
  } catch { return null }
}

function validateOptions(options: GedcomAnalyzeOptions): void {
  if (!['skip', 'import', 'ask'].includes(options.duplicateMode)) throw new Error('重复成员处理方式无效')
  if (!['remark', 'residence', 'ignore'].includes(options.placeTarget)) throw new Error('地点映射方式无效')
  if (!['copy', 'path', 'ignore'].includes(options.photoMode)) throw new Error('照片处理方式无效')
  if (!Number.isInteger(options.defaultGeneration) || options.defaultGeneration < 1 || options.defaultGeneration > 9999) throw new Error('默认世代应为 1–9999 之间的正整数')
}

export function analyzeGedcom(db: GenealogyDb, filePath: string, options: GedcomAnalyzeOptions): GedcomAnalysis {
  validateOptions(options)
  checkFile(filePath)
  const fileHash = sha256(filePath)
  const decoded = decodeText(fs.readFileSync(filePath))
  const parsed = parseGedcom(decoded.text)
  const issues: GedcomIssue[] = [...decoded.issues, ...parsed.issues]
  const head = parsed.records.find((r) => r.tag === 'HEAD')
  const trailer = parsed.records.find((r) => r.tag === 'TRLR')
  if (!trailer) addIssue(issues, { rowNumber: 1, field: 'TRLR', value: '', level: 'warning', message: '文件缺少 TRLR 结束记录，已尝试继续解析' })
  const version = nodeText(child(child(head, 'GEDC'), 'VERS')) || '未知'
  if (!/^5(\.5(\.1)?)?$/.test(version)) addIssue(issues, { rowNumber: head?.line ?? 1, field: 'GEDC.VERS', value: version, level: 'warning', message: '当前不是 GEDCOM 5.5 / 5.5.1，将按兼容模式解析' })

  const individualNodes = parsed.records.filter((r) => r.tag === 'INDI')
  const familyNodes = parsed.records.filter((r) => r.tag === 'FAM')
  const individuals = individualNodes.map(parseIndividual)
  const families = familyNodes.map(parseFamily)
  const byId = new Map(individuals.map((i) => [i.sourceId, i]))
  const eventCount = parsed.records.reduce((sum, r) => sum + r.children.filter((c) => ['BIRT', 'DEAT', 'MARR', 'BURI', 'RESI', 'OCCU', 'ADOP', 'BAPM', 'CENS'].includes(c.tag)).length, 0)

  for (const person of individuals) {
    if (!person.name) addIssue(issues, { rowNumber: person.line, field: 'NAME', value: '', level: 'error', message: '成员姓名缺失，该记录不会导入' })
    if (person.birthPlace && options.placeTarget === 'residence' && !person.residence) person.residence = person.birthPlace
    if ((person.birthPlace || person.deathPlace) && options.placeTarget === 'remark') {
      person.remark = [person.remark, person.birthPlace ? `出生地：${person.birthPlace}` : '', person.deathPlace ? `卒地：${person.deathPlace}` : ''].filter(Boolean).join('\n')
    }
    if (options.preserveUnsupported && person.unsupported.length) {
      const kept = person.unsupported.filter((item) => (options.unsupportedActions[item.split(/\s/)[0]] ?? 'note') === 'note')
      person.remark = [person.remark, ...kept.map((u) => `[${u}]`)].filter(Boolean).join('\n')
    }
  }

  const existing = db.listMembers({ limit: 100000 }).rows
  const existingKeys = new Map<string, string[]>()
  for (const m of existing) {
    if (!m.birthDate) continue
    const key = `${m.name.trim()}|${m.gender}|${m.birthDate}`
    if (!existingKeys.has(key)) existingKeys.set(key, [])
    existingKeys.get(key)!.push(m.name)
  }
  const duplicates: GedcomPreview['duplicates'] = []
  const duplicateIds = new Set<string>()
  for (const person of individuals) {
    if (!person.name || !person.birthDate) continue
    const key = `${person.name.trim()}|${person.gender}|${person.birthDate}`
    const names = existingKeys.get(key)
    if (!names?.length) continue
    duplicates.push({ id: person.sourceId, name: person.name, gender: person.gender, birthDate: person.birthDate, existingNames: [...new Set(names)] })
    duplicateIds.add(person.sourceId)
    addIssue(issues, { rowNumber: person.line, field: 'NAME', value: person.name, level: 'warning', message: `疑似重复成员：与现有成员「${names[0]}」的姓名、性别、出生日期一致` })
  }

  const unsupportedCounts = new Map<string, { count: number; firstLine: number }>()
  const walkUnsupported = (node: GNode): void => {
    for (const c of node.children) {
      if (c.tag.startsWith('_') || !SUPPORTED_TAGS.has(c.tag)) {
        const current = unsupportedCounts.get(c.tag) ?? { count: 0, firstLine: c.line }
        current.count++
        unsupportedCounts.set(c.tag, current)
      }
      walkUnsupported(c)
    }
  }
  walkUnsupported(parsed.root)
  const unsupportedTags: GedcomPreview['unsupportedTags'] = [...unsupportedCounts.entries()].map(([tag, info]) => ({
    tag, count: info.count, firstLine: info.firstLine,
    action: options.unsupportedActions[tag] ?? (options.preserveUnsupported ? 'note' : 'skip'),
  }))
  for (const item of unsupportedTags) addIssue(issues, { rowNumber: item.firstLine, field: item.tag, value: '', level: 'warning', message: `不支持标签 ${item.tag} 共 ${item.count} 处，将${item.action === 'note' ? '保留到备注' : '跳过'}并写入报告` })

  const accepted = individuals.filter((person) => {
    if (!person.name) return false
    if (!duplicateIds.has(person.sourceId)) return true
    if (options.duplicateMode === 'import') return true
    if (options.duplicateMode === 'ask') return options.duplicateDecisions?.[person.sourceId] === 'import'
    return false
  })
  const acceptedIds = new Set(accepted.map((p) => p.sourceId))
  const relations: GedcomImportRelation[] = []
  const parentEdges: { parentId: string; childId: string; subtype: string; isPrimary: boolean; note: string }[] = []
  for (const family of families) {
    const parents = [family.husband, family.wife].filter((id): id is string => !!id && acceptedIds.has(id))
    for (const parentId of parents) {
      const parent = byId.get(parentId)!
      for (const chil of family.children) {
        if (!acceptedIds.has(chil.sourceId)) continue
        const pedi = nodeText(child(chil.node, 'PEDI')).toLowerCase()
        let subtype = parent.gender === '女' ? '生母' : '生父'
        if (pedi === 'adopted' || pedi === 'adoption') subtype = parent.gender === '女' ? '养母' : '养父'
        else if (pedi === 'foster' || pedi === 'fostering') subtype = parent.gender === '女' ? '继母' : '继父'
        const special = [nodeText(child(chil.node, '_FREL')), nodeText(child(chil.node, '_MREL')), nodeText(child(chil.node, '_JITI'))].filter(Boolean)
        const note = special.length ? `GEDCOM 本地扩展：${special.join('；')}` : ''
        parentEdges.push({ parentId, childId: chil.sourceId, subtype, isPrimary: true, note })
      }
    }
    if (parents.length === 2) {
      const [a, b] = parents.sort()
      relations.push({ fromSourceId: a, toSourceId: b, type: 'spouse', subtype: '原配', isPrimary: true, note: family.unsupported.length ? `GEDCOM 本地扩展：${family.unsupported.join('；')}` : '' })
    }
  }
  for (const edge of parentEdges) relations.push({ fromSourceId: edge.parentId, toSourceId: edge.childId, type: 'parent_child', subtype: edge.subtype, isPrimary: edge.isPrimary, note: edge.note })

  const generation = new Map<string, number>()
  if (!options.autoDeriveGeneration) {
    for (const person of accepted) generation.set(person.sourceId, options.defaultGeneration)
  } else {
    const parentMap = new Map<string, string[]>()
    for (const edge of parentEdges) {
      if (!parentMap.has(edge.childId)) parentMap.set(edge.childId, [])
      parentMap.get(edge.childId)!.push(edge.parentId)
    }
    for (let round = 0; round < accepted.length; round++) {
      let changed = false
      for (const person of accepted) {
        if (generation.has(person.sourceId)) continue
        const parents = parentMap.get(person.sourceId) ?? []
        if (!parents.length) { generation.set(person.sourceId, options.defaultGeneration); changed = true; continue }
        const known = parents.map((id) => generation.get(id)).filter((g): g is number => g != null)
        if (known.length === parents.length) { generation.set(person.sourceId, Math.max(...known) + 1); changed = true }
      }
      if (!changed) break
    }
    for (const person of accepted) {
      if (!generation.has(person.sourceId)) {
        generation.set(person.sourceId, options.defaultGeneration)
        addIssue(issues, { rowNumber: person.line, field: 'GENERATION', value: '', level: 'warning', message: '世系关系存在环或父母未导入，世代使用默认值' })
      }
    }
  }

  const photos: PhotoRef[] = []
  const members: GedcomImportMember[] = accepted.map((person) => {
    for (const raw of person.photos) {
      const resolved = resolvePhoto(filePath, raw)
      if (!resolved) addIssue(issues, { rowNumber: person.line, field: 'OBJE.FILE', value: raw, level: 'warning', message: '照片不存在、格式不支持或超过 20MB，已跳过' })
      else photos.push({ sourceId: person.sourceId, rawPath: raw, resolvedPath: resolved, line: person.line })
    }
    return {
      sourceId: person.sourceId,
      member: {
        name: person.name, gender: person.gender, generation: generation.get(person.sourceId) ?? options.defaultGeneration,
        birthDate: person.birthDate, deathDate: person.deathDate, alive: person.alive,
        courtesyName: person.courtesyName, title: person.title, occupation: person.occupation,
        residence: person.residence, burial: person.burial, biography: person.biography, remark: person.remark,
        photoPath: options.photoMode === 'path' ? person.photos[0] ?? '' : '',
      },
    }
  })

  const sample: GedcomPreviewMember[] = accepted.slice(0, 20).map((person) => ({
    id: person.sourceId, name: person.name, gender: person.gender,
    generation: generation.get(person.sourceId) ?? options.defaultGeneration,
    birthDate: person.birthDate, duplicate: duplicateIds.has(person.sourceId),
    errorCount: issues.filter((i) => i.rowNumber === person.line && i.level === 'error').length,
    warningCount: issues.filter((i) => i.rowNumber === person.line && i.level === 'warning').length,
  }))
  const compatibility = [
    'GEDCOM 不直接表达世代与支系；世代按父母关系推导，支系留空。',
    '兼祧、过继等本地扩展关系尽量保留原文与说明，无法标准表达时写入备注和兼容性报告。',
    '导入不会覆盖现有成员；疑似重复必须由你选择跳过或仍作为新成员导入。',
  ]
  const preview: GedcomPreview = {
    analysisId: randomUUID(), fileName: path.basename(filePath), fileHash, version, encoding: decoded.encoding,
    individualCount: individuals.length, familyCount: families.length, eventCount,
    photoCount: options.photoMode === 'ignore' ? 0 : photos.length,
    validCount: members.length, skippedCount: individuals.length - members.length, duplicateCount: duplicates.length,
    defaultGeneration: options.defaultGeneration, duplicates, unsupportedTags, compatibility, sample, issues,
  }
  return { preview, members, relations, photos }
}

export function commitGedcom(
  db: GenealogyDb, filePath: string, options: GedcomAnalyzeOptions, expectedHash: string, io: GedcomPhotoIo,
): GedcomCommitResult {
  const analysis = analyzeGedcom(db, filePath, options)
  if (analysis.preview.fileHash !== expectedHash) {
    return { ok: false, batchId: null, successCount: 0, skippedCount: 0, failedCount: 0, relationCount: 0, photoCount: 0, message: '文件在预检后已变化，请重新预检' }
  }
  if (!analysis.members.length) {
    return { ok: false, batchId: null, successCount: 0, skippedCount: analysis.preview.skippedCount, failedCount: 0, relationCount: 0, photoCount: 0, message: '没有可导入的有效成员' }
  }
  const copied: string[] = []
  const photoByMember = new Map<string, string[]>()
  if (options.photoMode === 'copy') {
    for (const photo of analysis.photos) {
      try {
        const rel = io.savePhoto(photo.resolvedPath)
        copied.push(rel)
        if (!photoByMember.has(photo.sourceId)) photoByMember.set(photo.sourceId, [])
        photoByMember.get(photo.sourceId)!.push(rel)
      } catch (e) {
        addIssue(analysis.preview.issues, { rowNumber: photo.line, field: 'OBJE.FILE', value: photo.rawPath, level: 'warning', message: `照片复制失败：${(e as Error).message}` })
      }
    }
    for (const row of analysis.members) {
      const list = photoByMember.get(row.sourceId)
      if (list?.length) row.member.photoPath = list[0]
    }
  }
  const batchId = randomUUID()
  const payload: GedcomImportCommit = {
    batchId, sourceName: analysis.preview.fileName, sourceHash: expectedHash,
    totalRows: analysis.preview.individualCount, skippedCount: analysis.preview.skippedCount,
    failedCount: analysis.preview.issues.filter((i) => i.level === 'error').length,
    members: analysis.members, relations: analysis.relations, issues: analysis.preview.issues,
    options: { ...options, photoPaths: copied },
  }
  try {
    const result = db.importGedcom(payload)
    return {
      ok: true, batchId, successCount: analysis.members.length, skippedCount: analysis.preview.skippedCount,
      failedCount: payload.failedCount, relationCount: result.relationCount, photoCount: copied.length,
    }
  } catch (e) {
    for (const rel of copied) io.deletePhoto(rel)
    throw e
  }
}

function formatGedcomDate(iso: string): string {
  const full = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (full) {
    const month = Object.entries(MONTHS).find(([, value]) => value === full[2])?.[0] ?? full[2]
    return `${Number(full[3])} ${month} ${full[1]}`
  }
  const monthOnly = iso.match(/^(\d{4})-(\d{2})$/)
  if (monthOnly) return `${Object.entries(MONTHS).find(([, value]) => value === monthOnly[2])?.[0] ?? monthOnly[2]} ${monthOnly[1]}`
  return iso
}

function escapeGedcom(value: string): string {
  return /^@[^@]+@$/.test(value) ? value : value.replace(/@/g, '@@')
}

export function exportGedcom(
  db: GenealogyDb, meta: GenealogyMeta, options: GedcomExportOptions, appVersion: string, photoBaseDir: string,
): GedcomExportResult {
  const graph = db.graph()
  let members = graph.members
  if (options.scope === 'branch' && options.branchId) {
    const ids = new Set(db.branchSubtreeIds(options.branchId))
    members = members.filter((m) => m.branchId && ids.has(m.branchId))
  } else if (options.scope === 'generation' && options.generation != null) {
    members = members.filter((m) => m.generation === options.generation)
  } else if (options.scope === 'selected') {
    const ids = new Set(options.memberIds ?? [])
    members = members.filter((m) => ids.has(m.id))
  }
  const memberIds = new Set(members.map((m) => m.id))
  const edges = graph.edges.filter((e) => memberIds.has(e.from) && memberIds.has(e.to))
  const warnings: string[] = []
  const lines: string[] = []
  const push = (level: number, tag: string, value = '', xref?: string): void => {
    const prefix = `${level} ${xref ? `${xref} ` : ''}${tag}${value ? ` ${escapeGedcom(value)}` : ''}`
    const chunks: string[] = []
    let current = ''
    for (const char of prefix) {
      if (Buffer.byteLength(current + char, 'utf8') > 180) { chunks.push(current); current = char }
      else current += char
    }
    if (current || !chunks.length) chunks.push(current)
    lines.push(chunks[0])
    for (let i = 1; i < chunks.length; i++) lines.push(`${level + 1} CONC ${chunks[i]}`)
  }
  push(0, 'HEAD')
  push(1, 'SOUR', 'JIAPU')
  push(2, 'VERS', appVersion)
  push(1, 'GEDC')
  push(2, 'VERS', options.version)
  push(2, 'FORM', 'LINEAGE-LINKED')
  push(1, 'CHAR', options.encoding === 'gbk' ? 'ANSI' : 'UNICODE')
  push(1, 'LANG', 'Chinese')
  push(1, 'SUBM', 'JIAPU')
  push(0, 'SUBM', 'JIAPU')
  push(1, 'NAME', meta.compiler || '家谱管理软件用户')

  const idToXref = new Map(members.map((m, index) => [m.id, `@I${String(index + 1).padStart(4, '0')}@`]))
  const photos: GedcomExportResult['photos'] = []
  const usedPhotoNames = new Set<string>()
  for (const member of members) {
    const xref = idToXref.get(member.id)!
    push(0, 'INDI', '', xref)
    push(1, 'NAME', member.name)
    push(2, 'GIVN', member.name)
    push(1, 'SEX', member.gender === '男' ? 'M' : member.gender === '女' ? 'F' : 'U')
    if (member.courtesyName) push(1, 'NICK', member.courtesyName)
    if (member.title) push(1, 'TITL', member.title)
    if (member.birthDate) { push(1, 'BIRT'); push(2, 'DATE', formatGedcomDate(member.birthDate)) }
    if (!member.alive || member.deathDate) { push(1, 'DEAT', member.deathDate ? '' : 'Y'); if (member.deathDate) push(2, 'DATE', formatGedcomDate(member.deathDate)) }
    if (member.occupation) { push(1, 'OCCU', member.occupation) }
    if (member.residence) { push(1, 'RESI', member.residence) }
    if (member.burial) { push(1, 'BURI', member.burial) }
    if (member.biography) { push(1, 'BIOG'); for (const line of member.biography.split(/\r?\n/)) push(2, 'NOTE', line) }
    if (options.includeNotes && member.remark) { push(1, 'NOTE'); for (const line of member.remark.split(/\r?\n/)) push(2, 'CONT', line) }
    if (options.includePhotos && member.photoPath) {
      const source = path.resolve(photoBaseDir, member.photoPath)
      if (fs.existsSync(source) && PHOTO_EXTS.has(path.extname(source).toLowerCase())) {
        let base = path.basename(source)
        if (usedPhotoNames.has(base)) base = `${idToXref.get(member.id)!.replace(/[^A-Za-z0-9]/g, '')}-${base}`
        usedPhotoNames.add(base)
        const targetRelative = `photos/${base}`
        photos.push({ sourcePath: source, targetRelative })
        push(1, 'OBJE'); push(2, 'FILE', targetRelative)
      } else warnings.push(`成员「${member.name}」的照片不存在或格式不支持，已跳过`)
    }
  }

  const parentByChild = new Map<string, { parentId: string; subtype: string; isPrimary: boolean; note: string }[]>()
  for (const edge of edges) {
    if (edge.type !== 'parent_child') continue
    if (!parentByChild.has(edge.to)) parentByChild.set(edge.to, [])
    parentByChild.get(edge.to)!.push({ parentId: edge.from, subtype: edge.subtype, isPrimary: edge.isPrimary, note: '' })
  }
  const familyGroups = new Map<string, { parents: string[]; children: string[] }>()
  for (const [childId, parents] of parentByChild) {
    const key = parents.map((p) => p.parentId).sort().join('|')
    if (!familyGroups.has(key)) familyGroups.set(key, { parents: key ? key.split('|') : [], children: [] })
    familyGroups.get(key)!.children.push(childId)
  }
  for (const edge of edges) {
    if (edge.type !== 'spouse') continue
    const key = [edge.from, edge.to].sort().join('|')
    if (!familyGroups.has(key)) familyGroups.set(key, { parents: key.split('|'), children: [] })
  }
  const memberById = new Map(members.map((m) => [m.id, m]))
  const families = [...familyGroups.values()]
  families.forEach((family, index) => {
    const xref = `@F${String(index + 1).padStart(4, '0')}@`
    push(0, 'FAM', '', xref)
    const sortedParents = [...family.parents].sort((a, b) => {
      const ga = memberById.get(a)?.gender === '男' ? 0 : 1
      const gb = memberById.get(b)?.gender === '男' ? 0 : 1
      return ga - gb || a.localeCompare(b)
    })
    const husband = sortedParents.find((id) => memberById.get(id)?.gender === '男') ?? sortedParents[0]
    const wife = sortedParents.find((id) => memberById.get(id)?.gender === '女' && id !== husband) ?? sortedParents.find((id) => id !== husband)
    if (husband) push(1, 'HUSB', idToXref.get(husband))
    if (wife) push(1, 'WIFE', idToXref.get(wife))
    const spouseEdge = edges.find((e) => e.type === 'spouse' && family.parents.includes(e.from) && family.parents.includes(e.to))
    if (spouseEdge && spouseEdge.subtype !== '原配') {
      push(1, '_JSPOUSE', spouseEdge.subtype)
      if (options.includeCompatibility) push(1, 'NOTE', `本地扩展配偶关系：${spouseEdge.subtype}`)
    }
    for (const childId of family.children) {
      push(1, 'CHIL', idToXref.get(childId))
      const parentLinks = (parentByChild.get(childId) ?? []).filter((p) => family.parents.includes(p.parentId))
      const pedi = parentLinks.find((p) => p.subtype.includes('养'))?.subtype.includes('养') ? 'adopted'
        : parentLinks.find((p) => p.subtype.includes('继'))?.subtype.includes('继') ? 'foster' : 'birth'
      push(2, 'PEDI', pedi)
      for (const parent of parentLinks) {
        if (!parent.subtype.includes('生') || !parent.isPrimary || options.includeCompatibility) {
          push(2, '_JPARENT', parent.subtype)
          push(2, '_JPARENT_PRIMARY', parent.isPrimary ? 'Y' : 'N')
          if (options.includeCompatibility) push(2, 'NOTE', `本地扩展关系：${parent.subtype}${parent.isPrimary ? '（主承）' : ''}`)
        }
      }
    }
    if (options.includeCompatibility) push(1, 'NOTE', '由家谱管理软件导出；兼祧、过继等关系同时保留标准 PEDI 与本地扩展说明。')
  })
  push(0, 'TRLR')
  const content = lines.join('\r\n') + '\r\n'
  return { content, photos, warnings, memberCount: members.length, familyCount: families.length, photoCount: photos.length }
}

export function gedcomExportPreview(
  db: GenealogyDb, meta: GenealogyMeta, options: GedcomExportOptions, appVersion: string, photoBaseDir: string,
): GedcomExportPreview {
  const result = exportGedcom(db, meta, options, appVersion, photoBaseDir)
  return {
    memberCount: result.memberCount, familyCount: result.familyCount, photoCount: result.photoCount,
    content: result.content.split(/\r?\n/).slice(0, 40).join('\n'), warnings: result.warnings,
  }
}
