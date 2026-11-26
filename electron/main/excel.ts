import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import AdmZip from 'adm-zip'
import type { GenealogyDb, ExcelImportCommit, ExcelImportRow } from './db.ts'
import { lunarPartsToSolar } from '../shared/lunar.ts'
import {
  EXCEL_FIELDS,
  type ExcelAnalyzeOptions, type ExcelBatch, type ExcelCommitResult, type ExcelFieldKey,
  type ExcelIssue, type ExcelMapping, type ExcelPreview, type ExcelPreviewRow, type MemberInput,
} from '../shared/types.ts'

const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_ROWS = 10000
const HEADER_FILL = '8F2F1F'

export interface ExcelAnalysis {
  preview: ExcelPreview
  rows: ExcelImportRow[]
  missingBranches: string[]
  skippedCount: number
  failedCount: number
}

function sha256(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function checkFile(filePath: string): void {
  const ext = path.extname(filePath).toLowerCase()
  if (ext !== '.xlsx') throw new Error('仅支持 .xlsx 文件；旧版 .xls 请另存为 .xlsx')
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) throw new Error('所选路径不是文件')
  if (stat.size > MAX_FILE_BYTES) throw new Error('文件超过 20MB 限制')
  const fd = fs.openSync(filePath, 'r')
  try {
    const head = Buffer.alloc(4)
    fs.readSync(fd, head, 0, 4, 0)
    if (head.toString('hex') !== '504b0304') throw new Error('文件不是有效的 xlsx 工作簿')
  } finally { fs.closeSync(fd) }
  let zip: AdmZip
  try {
    zip = new AdmZip(filePath)
  } catch {
    throw new Error('文件不是有效的 xlsx 工作簿')
  }
  const entries = zip.getEntries().map((entry) => entry.entryName)
  if (entries.includes('xl/vbaProject.bin')) throw new Error('不支持包含宏的工作簿，请另存为 .xlsx')
  if (entries.some((entry) => entry.startsWith('xl/externalLinks/'))) throw new Error('不支持包含外部链接的工作簿')
}

function valueOf(cell: ExcelJS.Cell): unknown {
  const v = cell.value
  if (v && typeof v === 'object') {
    if ('formula' in v) return (v as { formula: string; result?: unknown }).result ?? cell.text
    if ('richText' in v) return (v as { richText: { text: string }[] }).richText.map((x) => x.text).join('')
    if ('hyperlink' in v) return (v as { text?: string }).text ?? cell.text
  }
  return v
}

function textOf(cell: ExcelJS.Cell | undefined): string {
  if (!cell) return ''
  const v = valueOf(cell)
  if (v == null) return ''
  if (v instanceof Date) return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`
  return String(v).trim()
}

function normalizeHeader(s: string): string {
  return s.toLowerCase().replace(/[\s_\-/\\（）()\[\]【】:：.]/g, '')
}

function suggestMapping(headers: string[]): ExcelMapping {
  const normalized = headers.map(normalizeHeader)
  const used = new Set<number>()
  const mapping: ExcelMapping = {}
  for (const field of EXCEL_FIELDS) {
    const names = [field.label, ...field.aliases].map(normalizeHeader)
    const idx = normalized.findIndex((h, i) => h && names.includes(h) && !used.has(i))
    if (idx >= 0) {
      mapping[field.key] = headers[idx]
      used.add(idx)
    }
  }
  return mapping
}

function pad(n: number): string { return String(n).padStart(2, '0') }

function excelSerialToDate(serial: number): Date | null {
  if (!Number.isFinite(serial) || serial < 1 || serial === 60 || serial > 2958465) return null
  return new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000)
}

function validSolarDate(date: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return false
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3])
  const d = new Date(0)
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCFullYear(year, month - 1, day)
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
}

function parseDateCell(cell: ExcelJS.Cell | undefined): string | null {
  if (!cell) return ''
  const v = valueOf(cell)
  if (v == null || v === '') return ''
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null
    return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`
  }
  if (typeof v === 'number') {
    const fmt = String(cell.numFmt || '')
    if (!/[ymd]/i.test(fmt) && v < 10000) return null
    const d = excelSerialToDate(v)
    return d ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` : null
  }
  const s = String(v).trim()
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s)
  if (!m) m = /^(\d{4})年(\d{1,2})月(\d{1,2})日?$/.exec(s)
  if (!m) return null
  const date = `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`
  return date
}

function parseCalendar(raw: string, field: string, rowNumber: number, issues: ExcelIssue[]): boolean | null {
  const s = raw.trim()
  if (!s || ['公历', '阳历', '公', 'solar'].includes(s.toLowerCase())) return false
  if (['农历', '阴历', '农', 'lunar'].includes(s.toLowerCase())) return true
  issues.push({ rowNumber, field, value: raw, level: 'error', message: '历法仅支持“公历”或“农历”' })
  return null
}

function parseDateValue(
  cell: ExcelJS.Cell | undefined, raw: string, lunar: boolean | null, field: string, rowNumber: number, issues: ExcelIssue[],
): string {
  if (!raw) return ''
  if (lunar === null) return ''
  const parsed = parseDateCell(cell)
  if (!parsed) {
    issues.push({ rowNumber, field, value: raw, level: 'error', message: '日期无法识别，请使用 1990-05-15 或 1990年5月15日' })
    return ''
  }
  if (!lunar) {
    if (!validSolarDate(parsed)) {
      issues.push({ rowNumber, field, value: raw, level: 'error', message: '公历日期不存在' })
      return ''
    }
    return parsed
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parsed)
  if (!m) return ''
  const solar = lunarPartsToSolar(Number(m[1]), Number(m[2]), Number(m[3]), false)
  if (!solar) {
    issues.push({ rowNumber, field, value: raw, level: 'error', message: '农历日期不存在或超出可转换范围' })
    return ''
  }
  return solar
}

function parsePositiveInt(raw: string, max: number, field: string, rowNumber: number, issues: ExcelIssue[]): number | null {
  if (!raw) return null
  if (!/^\d+$/.test(raw)) {
    issues.push({ rowNumber, field, value: raw, level: 'error', message: '请输入正整数' })
    return null
  }
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < 1 || n > max) {
    issues.push({ rowNumber, field, value: raw, level: 'error', message: `数值应在 1–${max} 之间` })
    return null
  }
  return n
}

function duplicateKey(m: MemberInput): string {
  return [m.name.trim().toLowerCase(), m.gender, m.birthDate ?? '', m.birthLunar ? 1 : 0].join('|')
}

function safeCellText(value: string): string {
  return /^[=+\-@]/.test(value.trimStart()) ? `'${value}` : value
}

export async function createTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = '家谱管理软件'
  wb.created = new Date()
  const ws = wb.addWorksheet('成员数据')
  ws.columns = EXCEL_FIELDS.map((f) => ({ header: f.label, key: f.key, width: f.width }))
  const header = ws.getRow(1)
  header.height = 26
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } }
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFD9C7B8' } } }
  })
  ws.views = [{ state: 'frozen', ySplit: 1 }]
  ws.autoFilter = `A1:Q${MAX_ROWS + 1}`
  const validations = (ws as unknown as {
    dataValidations: { add: (address: string, value: { type: string; allowBlank: boolean; formulae: string[] }) => void }
  }).dataValidations
  const list = (col: string, values: string[]): void => {
    validations.add(`${col}2:${col}${MAX_ROWS + 1}`, { type: 'list', allowBlank: true, formulae: [`"${values.join(',')}"`] })
  }
  list('B', ['男', '女', '未知'])
  list('I', ['公历', '农历'])
  list('K', ['公历', '农历'])
  list('L', ['在世', '已故', '未详'])

  const info = wb.addWorksheet('填写说明')
  info.columns = [{ width: 18 }, { width: 12 }, { width: 80 }]
  info.addRow(['字段', '必填', '说明'])
  for (const f of EXCEL_FIELDS) {
    let note = ''
    if (f.key === 'name') note = '成员姓名，导入时自动去除首尾空格'
    else if (f.key === 'gender') note = '男 / 女 / 未知；未知按“其他”导入'
    else if (f.key === 'generation') note = '正整数；留空时使用导入向导中的默认世代'
    else if (f.key === 'birthOrder') note = '正整数；留空默认为 1'
    else if (f.key === 'branchName') note = '填写已有支系名称，或选择自动创建'
    else if (f.key === 'birthDate' || f.key === 'deathDate') note = '支持 1990-05-15、1990年5月15日、Excel 日期单元格'
    else if (f.key === 'birthCalendar' || f.key === 'deathCalendar') note = '公历 / 农历；留空默认公历'
    else if (f.key === 'alive') note = '在世 / 已故 / 未详；留空按是否有卒日期推断'
    else if (f.key === 'courtesyName' || f.key === 'hao') note = '字与号会合并展示在“字 / 号”字段'
    info.addRow([f.label, f.required ? '是' : '否', note])
  }
  info.addRow([])
  info.addRow(['重要提示', '', '首期仅导入成员基本信息，不自动建立父母、配偶、子女关系；照片请导入后单独上传。'])
  info.addRow(['文件安全', '', '仅支持 .xlsx；不支持宏、外部链接和公式执行。公式单元格只读取显示结果。'])
  info.getRow(1).font = { bold: true }

  const opts = wb.addWorksheet('可选值')
  opts.columns = [{ width: 18 }, { width: 60 }]
  opts.addRow(['字段', '可选值'])
  opts.addRow(['性别', '男 / 女 / 未知'])
  opts.addRow(['出生历法、卒历法', '公历 / 农历'])
  opts.addRow(['在世状态', '在世 / 已故 / 未详'])
  opts.getRow(1).font = { bold: true }
  return Buffer.from(await wb.xlsx.writeBuffer())
}

export async function analyzeWorkbook(db: GenealogyDb, filePath: string, options: ExcelAnalyzeOptions): Promise<ExcelAnalysis> {
  checkFile(filePath)
  if (!['skip', 'import', 'ask'].includes(options.duplicateMode)) throw new Error('重复成员处理方式无效')
  if (!['keep-empty', 'create', 'error'].includes(options.branchMode)) throw new Error('未知支系处理方式无效')
  if (!Number.isInteger(options.defaultGeneration) || options.defaultGeneration < 1 || options.defaultGeneration > 9999) {
    throw new Error('默认世代应为 1–9999 之间的正整数')
  }
  const fileHash = sha256(filePath)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(filePath)
  const ws = wb.worksheets.find((s) => s.name === '成员数据') ?? wb.worksheets[0]
  if (!ws) throw new Error('工作簿中没有工作表')

  let headerRowNumber = 1
  for (let r = 1; r <= Math.min(ws.rowCount, 10); r++) {
    if (ws.getRow(r).cellCount > 0) { headerRowNumber = r; break }
  }
  const headerRow = ws.getRow(headerRowNumber)
  const headers: string[] = []
  for (let c = 1; c <= Math.max(ws.columnCount, EXCEL_FIELDS.length); c++) {
    headers.push(textOf(headerRow.getCell(c)))
  }
  while (headers.length && !headers[headers.length - 1]) headers.pop()
  const nonEmpty = headers.filter(Boolean)
  if (!nonEmpty.length) throw new Error('首行未找到表头')
  if (new Set(nonEmpty).size !== nonEmpty.length) throw new Error('存在重复表头，请修正后重新导入')

  const mapping = { ...suggestMapping(headers), ...options.mapping }
  for (const key of Object.keys(mapping) as ExcelFieldKey[]) {
    const h = mapping[key]
    if (h && !headers.includes(h)) delete mapping[key]
  }
  const issues: ExcelIssue[] = []
  if (!mapping.name) issues.push({ rowNumber: 0, field: '姓名', value: '', level: 'error', message: '未映射必填字段“姓名”' })
  const indexByKey = new Map<ExcelFieldKey, number>()
  for (const f of EXCEL_FIELDS) {
    const h = mapping[f.key]
    if (h) indexByKey.set(f.key, headers.indexOf(h))
  }
  const cellFor = (row: ExcelJS.Row, key: ExcelFieldKey): ExcelJS.Cell | undefined => {
    const idx = indexByKey.get(key)
    return idx == null ? undefined : row.getCell(idx + 1)
  }
  const textFor = (row: ExcelJS.Row, key: ExcelFieldKey): string => textOf(cellFor(row, key))

  const branches = db.listBranches()
  const branchMap = new Map(branches.map((b) => [b.name, b.id]))
  const existing = db.listMembers({ limit: 100000 }).rows
  const existingKeys = new Set(existing.map(duplicateKey))
  const seenKeys = new Set<string>()
  const missingBranchSet = new Set<string>()
  const rows: ExcelImportRow[] = []
  const sample: ExcelPreviewRow[] = []
  let totalRows = 0, errorRows = 0, duplicateRows = 0, blankGenerationRows = 0, skippedCount = 0

  const lastRow = Math.min(ws.rowCount, MAX_ROWS + headerRowNumber)
  if (ws.rowCount > MAX_ROWS + headerRowNumber) {
    issues.push({ rowNumber: 0, field: '', value: String(ws.rowCount - headerRowNumber), level: 'warning', message: `数据超过 ${MAX_ROWS} 行上限，超出部分未读取` })
  }
  for (let r = headerRowNumber + 1; r <= lastRow; r++) {
    const row = ws.getRow(r)
    if (!row.cellCount) continue
    const values = Array.from({ length: headers.length }, (_, i) => textOf(row.getCell(i + 1)))
    if (!values.some(Boolean)) continue
    totalRows++
    const rowIssues: ExcelIssue[] = []
    const add = (field: string, value: string, message: string, level: 'error' | 'warning' = 'error'): void => {
      rowIssues.push({ rowNumber: r, field, value, message, level })
    }
    const name = textFor(row, 'name')
    if (!name) add('姓名', name, '姓名不能为空')
    if (name.length > 100) add('姓名', name, '姓名不能超过 100 个字符')

    const genderRaw = textFor(row, 'gender')
    let gender: MemberInput['gender'] = '其他'
    if (!genderRaw || ['未知', '其他', '未知性别'].includes(genderRaw)) gender = '其他'
    else if (['男', 'male', 'm'].includes(genderRaw.toLowerCase())) gender = '男'
    else if (['女', 'female', 'f'].includes(genderRaw.toLowerCase())) gender = '女'
    else add('性别', genderRaw, '性别仅支持男 / 女 / 未知')

    const generation = parsePositiveInt(textFor(row, 'generation'), 9999, '世代', r, rowIssues)
    if (!textFor(row, 'generation')) blankGenerationRows++
    const birthOrder = parsePositiveInt(textFor(row, 'birthOrder'), 999, '行第', r, rowIssues)
    const birthCalendarRaw = textFor(row, 'birthCalendar')
    const birthLunar = parseCalendar(birthCalendarRaw, '出生历法', r, rowIssues)
    const deathCalendarRaw = textFor(row, 'deathCalendar')
    const deathLunar = parseCalendar(deathCalendarRaw, '卒历法', r, rowIssues)
    const birthRaw = textFor(row, 'birthDate')
    const deathRaw = textFor(row, 'deathDate')
    const birthDate = parseDateValue(cellFor(row, 'birthDate'), birthRaw, birthLunar, '出生日期', r, rowIssues)
    const deathDate = parseDateValue(cellFor(row, 'deathDate'), deathRaw, deathLunar, '卒日期', r, rowIssues)
    if (birthDate && deathDate && deathDate < birthDate) add('卒日期', deathRaw, '卒日期不能早于出生日期')

    const aliveRaw = textFor(row, 'alive')
    let alive = !deathDate
    if (!aliveRaw || aliveRaw === '未详') {
      if (aliveRaw === '未详') add('在世状态', aliveRaw, '在世状态未详，已按卒日期推断', 'warning')
    } else if (['在世', '生存', '活', '是', '1', 'true'].includes(aliveRaw.toLowerCase())) alive = true
    else if (['已故', '去世', '死亡', '否', '0', 'false'].includes(aliveRaw.toLowerCase())) alive = false
    else add('在世状态', aliveRaw, '在世状态仅支持在世 / 已故 / 未详')

    const branchName = textFor(row, 'branchName')
    let branchId: string | null = null
    if (branchName) {
      const found = branchMap.get(branchName)
      if (found) branchId = found
      else if (options.branchMode === 'error') add('支系', branchName, '支系不存在')
      else if (options.branchMode === 'keep-empty') add('支系', branchName, '支系不存在，导入后留空', 'warning')
      else missingBranchSet.add(branchName)
    }

    const courtesy = textFor(row, 'courtesyName')
    const hao = textFor(row, 'hao')
    const courtesyName = [courtesy ? `字 ${courtesy}` : '', hao ? `号 ${hao}` : ''].filter(Boolean).join('；')
    const member: MemberInput = {
      name, gender, generation: generation ?? options.defaultGeneration, branchId,
      birthDate, birthLunar: birthLunar === true, deathDate, deathLunar: deathLunar === true,
      alive, birthOrder: birthOrder ?? 1, courtesyName,
      occupation: textFor(row, 'occupation'), residence: textFor(row, 'residence'), burial: textFor(row, 'burial'),
      biography: textFor(row, 'biography'), remark: textFor(row, 'remark'),
    }
    const errors = rowIssues.filter((x) => x.level === 'error')
    if (errors.length) errorRows++
    let duplicate = false
    if (!errors.length) {
      const key = duplicateKey(member)
      if (existingKeys.has(key) || seenKeys.has(key)) {
        duplicate = true
        duplicateRows++
        add('姓名', name, '疑似重复成员（姓名 + 性别 + 出生日期相同）', 'warning')
      }
      seenKeys.add(key)
    }
    let skipped = false
    if (!errors.length && duplicate) {
      if (options.duplicateMode === 'skip') skipped = true
      else if (options.duplicateMode === 'ask') skipped = (options.duplicateDecisions?.[r] ?? 'skip') !== 'import'
    }
    if (skipped) skippedCount++
    if (!errors.length && !skipped) rows.push({ sourceRow: r, member, branchName: branchName || null })
    issues.push(...rowIssues)
    if (sample.length < 30) {
      sample.push({
        rowNumber: r, name: name || '（空）', gender: genderRaw || '其他',
        generation: generation, branchName, birthDate, birthLunar: birthLunar === true,
        duplicate, errorCount: errors.length, warningCount: rowIssues.filter((x) => x.level === 'warning').length,
      })
    }
  }

  const missingBranches = [...missingBranchSet]
  const preview: ExcelPreview = {
    analysisId: randomUUID(), fileName: path.basename(filePath), fileHash,
    totalRows, validRows: rows.length, errorRows, duplicateRows, blankGenerationRows,
    missingBranches, headers, suggestedMapping: suggestMapping(headers),
    defaultGeneration: options.defaultGeneration, sample, issues,
  }
  return { preview, rows, missingBranches, skippedCount, failedCount: errorRows }
}

export async function commitWorkbook(
  db: GenealogyDb, filePath: string, options: ExcelAnalyzeOptions, expectedHash: string,
): Promise<ExcelCommitResult> {
  const analysis = await analyzeWorkbook(db, filePath, options)
  if (analysis.preview.fileHash !== expectedHash) {
    return { ok: false, batchId: null, successCount: 0, skippedCount: 0, failedCount: 0, message: '文件在预检后已变化，请重新预检' }
  }
  const commitOptions: ExcelAnalyzeOptions = {
    ...options, mapping: { ...analysis.preview.suggestedMapping, ...options.mapping },
  }
  if (!commitOptions.mapping.name) {
    return { ok: false, batchId: null, successCount: 0, skippedCount: 0, failedCount: 0, message: '请先映射必填字段“姓名”' }
  }
  if (!analysis.rows.length) {
    return { ok: false, batchId: null, successCount: 0, skippedCount: analysis.skippedCount, failedCount: analysis.failedCount, message: '没有可导入的有效成员' }
  }
  const batchId = randomUUID()
  const payload: ExcelImportCommit = {
    batchId, sourceName: analysis.preview.fileName, sourceHash: expectedHash,
    totalRows: analysis.preview.totalRows, skippedCount: analysis.skippedCount, failedCount: analysis.failedCount,
    rows: analysis.rows, issues: analysis.preview.issues, missingBranches: analysis.missingBranches, options: commitOptions,
  }
  db.importMembers(payload)
  return {
    ok: true, batchId, successCount: analysis.rows.length,
    skippedCount: analysis.skippedCount, failedCount: analysis.failedCount,
  }
}

export async function createIssueReport(
  fileName: string, issues: ExcelIssue[], summary?: { totalRows: number; successCount: number; skippedCount: number; failedCount: number },
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = '家谱管理软件'
  const ws = wb.addWorksheet('问题清单')
  ws.columns = [
    { header: 'Excel行号', width: 12 }, { header: '级别', width: 10 }, { header: '字段', width: 16 },
    { header: '原始值', width: 32 }, { header: '原因 / 建议', width: 70 },
  ]
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } }
  if (!issues.length) ws.addRow(['—', '通过', '', '', '未发现问题'])
  for (const issue of issues) {
    ws.addRow([issue.rowNumber || '全局', issue.level === 'error' ? '错误' : '警告', safeCellText(issue.field), safeCellText(issue.value), safeCellText(issue.message)])
  }
  ws.views = [{ state: 'frozen', ySplit: 1 }]
  ws.autoFilter = `A1:E${Math.max(ws.rowCount, 1)}`
  const sum = wb.addWorksheet('导入摘要')
  sum.columns = [{ width: 20 }, { width: 40 }]
  sum.addRow(['来源文件', safeCellText(fileName)])
  sum.addRow(['导出时间', new Date().toLocaleString('zh-CN')])
  if (summary) {
    sum.addRow(['总行数', summary.totalRows])
    sum.addRow(['成功数', summary.successCount])
    sum.addRow(['跳过数', summary.skippedCount])
    sum.addRow(['失败数', summary.failedCount])
  }
  sum.addRow(['问题数', issues.length])
  return Buffer.from(await wb.xlsx.writeBuffer())
}

export function batchSummary(batch: ExcelBatch): { totalRows: number; successCount: number; skippedCount: number; failedCount: number } {
  return { totalRows: batch.totalRows, successCount: batch.successCount, skippedCount: batch.skippedCount, failedCount: batch.failedCount }
}
