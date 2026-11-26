import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'
import AdmZip from 'adm-zip'
import { GenealogyDb } from '../electron/main/db.ts'
import {
  analyzeWorkbook, commitWorkbook, createIssueReport, createTemplate,
} from '../electron/main/excel.ts'
import { EXCEL_FIELDS, type ExcelAnalyzeOptions } from '../electron/shared/types.ts'
import { lunarPartsToSolar } from '../electron/shared/lunar.ts'

function fixture(t: { after: (fn: () => void) => void }): { db: GenealogyDb; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiapu-excel-test-'))
  const db = new GenealogyDb(path.join(dir, 'genealogy.db'))
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  return { db, dir }
}

function baseOptions(patch: Partial<ExcelAnalyzeOptions> = {}): ExcelAnalyzeOptions {
  return { mapping: {}, duplicateMode: 'ask', branchMode: 'error', defaultGeneration: 1, ...patch }
}

async function writeRows(dir: string, name: string, rows: Record<string, unknown>[], headers = EXCEL_FIELDS.map((f) => f.label)): Promise<string> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('成员数据')
  ws.addRow(headers)
  for (const row of rows) ws.addRow(headers.map((h) => row[h] ?? ''))
  const file = path.join(dir, name)
  await wb.xlsx.writeFile(file)
  return file
}

test('Excel 模板包含成员表、说明与可选值', async (t) => {
  const { dir } = fixture(t)
  const bytes = await createTemplate()
  const file = path.join(dir, 'template.xlsx')
  fs.writeFileSync(file, bytes)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(file)
  assert.deepEqual(wb.worksheets.map((s) => s.name), ['成员数据', '填写说明', '可选值'])
  const headers = wb.worksheets[0].getRow(1).values as unknown[]
  assert.deepEqual(headers.slice(1), EXCEL_FIELDS.map((f) => f.label))
  assert.match(wb.worksheets[1].getCell('C20').text, /关系|照片/)
})

test('预检支持农历、默认世代、重复确认和错误行', async (t) => {
  const { db, dir } = fixture(t)
  db.createBranch('长房', null, null, '')
  db.createMember({ name: '张三', gender: '男', birthDate: '1990-01-01' })
  const expectedLunar = lunarPartsToSolar(2020, 5, 5, false)
  const file = await writeRows(dir, 'members.xlsx', [
    { 姓名: '张三', 性别: '男', 出生日期: '1990-01-01', 出生历法: '公历' },
    { 姓名: '李四', 性别: '女', 出生日期: '2020年5月5日', 出生历法: '农历', 支系: '长房', 备注: '待考证' },
    { 姓名: '王五', 性别: '男', 出生日期: '2020-02-30', 出生历法: '公历' },
    { 姓名: '赵六', 性别: '男', 支系: '不存在' },
  ])
  const analysis = await analyzeWorkbook(db, file, baseOptions({ defaultGeneration: 4, duplicateDecisions: { 2: 'import' } }))
  assert.equal(analysis.preview.totalRows, 4)
  assert.equal(analysis.preview.validRows, 2)
  assert.equal(analysis.preview.errorRows, 2)
  assert.equal(analysis.preview.duplicateRows, 1)
  assert.equal(analysis.preview.blankGenerationRows, 4)
  assert.equal(analysis.preview.suggestedMapping.name, '姓名')
  const lunar = analysis.rows.find((r) => r.member.name === '李四')!
  assert.equal(lunar.member.birthDate, expectedLunar)
  assert.equal(lunar.member.birthLunar, true)
  assert.equal(lunar.member.generation, 4)
  assert.equal(lunar.member.remark, '待考证')
  assert.ok(analysis.preview.issues.some((i) => i.rowNumber === 4 && i.field === '出生日期' && i.level === 'error'))
  assert.ok(analysis.preview.issues.some((i) => i.rowNumber === 5 && i.field === '支系' && i.level === 'error'))
})

test('Excel 日期单元格与公式结果可读取', async (t) => {
  const { db, dir } = fixture(t)
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('成员数据')
  ws.addRow(['名字', '生日', '称号'])
  const row = ws.addRow(['日期成员', '', ''])
  row.getCell(2).value = new Date(Date.UTC(1988, 4, 20))
  row.getCell(3).value = { formula: '"先生"', result: '先生' }
  const file = path.join(dir, 'dates.xlsx')
  await wb.xlsx.writeFile(file)
  const analysis = await analyzeWorkbook(db, file, baseOptions())
  assert.equal(analysis.preview.validRows, 1)
  assert.equal(analysis.rows[0].member.birthDate, '1988-05-20')
})

test('重复成员策略：跳过、全部导入、逐行确认', async (t) => {
  const { db, dir } = fixture(t)
  db.createMember({ name: '张三', gender: '男', birthDate: '1990-01-01' })
  const file = await writeRows(dir, 'dups.xlsx', [
    { 姓名: '张三', 性别: '男', 出生日期: '1990/1/1' },
    { 姓名: '李四', 性别: '女' },
  ])
  const skip = await analyzeWorkbook(db, file, baseOptions({ duplicateMode: 'skip' }))
  assert.equal(skip.preview.validRows, 1)
  assert.equal(skip.skippedCount, 1)
  const all = await analyzeWorkbook(db, file, baseOptions({ duplicateMode: 'import' }))
  assert.equal(all.preview.validRows, 2)
  const ask = await analyzeWorkbook(db, file, baseOptions({ duplicateMode: 'ask', duplicateDecisions: { 2: 'import' } }))
  assert.equal(ask.preview.validRows, 2)
})

test('导入事务创建支系并可按批次撤销', async (t) => {
  const { db, dir } = fixture(t)
  const parent = db.createMember({ name: '父辈', gender: '男' })
  const file = await writeRows(dir, 'commit.xlsx', [
    { 姓名: '新成员', 性别: '女', 支系: '新支系', 备注: 'Excel 备注' },
    { 姓名: '错误成员', 性别: '非法' },
  ])
  const options = baseOptions({ branchMode: 'create' })
  const analysis = await analyzeWorkbook(db, file, options)
  assert.deepEqual(analysis.preview.missingBranches, ['新支系'])
  const result = await commitWorkbook(db, file, options, analysis.preview.fileHash)
  assert.equal(result.ok, true)
  assert.equal(result.successCount, 1)
  assert.equal(result.failedCount, 1)
  assert.ok(result.batchId)
  const member = db.listMembers({ keyword: '新成员' }).rows[0]
  assert.equal(member.remark, 'Excel 备注')
  assert.equal(db.listBranches()[0].name, '新支系')
  assert.equal(db.listImportBatches()[0].id, result.batchId)
  assert.equal(db.importIssues(result.batchId!).length, 1)

  db.updateMember(member.id, { ...member, spouses: [], parents: [{ otherId: parent.id, subtype: '生父' }] })
  const undone = db.undoImport(result.batchId!)
  assert.deepEqual(undone, { ok: true, count: 1 })
  assert.equal(db.getMember(member.id), null)
  assert.equal(db.getMember(parent.id)!.children.length, 0)
  assert.equal(db.listBranches().length, 0)
  assert.equal(db.listImportBatches()[0].status, 'undone')
  assert.equal(db.undoImport(result.batchId!).ok, false)
})

test('提交拒绝预检后被修改的文件且不写入成员', async (t) => {
  const { db, dir } = fixture(t)
  const file = await writeRows(dir, 'changed.xlsx', [{ 姓名: '甲', 性别: '男' }])
  const options = baseOptions()
  const analysis = await analyzeWorkbook(db, file, options)
  await writeRows(dir, 'changed.xlsx', [{ 姓名: '甲', 性别: '男' }, { 姓名: '乙', 性别: '女' }])
  const result = await commitWorkbook(db, file, options, analysis.preview.fileHash)
  assert.equal(result.ok, false)
  assert.match(result.message ?? '', /变化/)
  assert.equal(db.countMembers(), 0)
  assert.equal(db.listImportBatches().length, 0)
})

test('问题报告 neutralize 公式样式文本', async (t) => {
  const { dir } = fixture(t)
  const bytes = await createIssueReport('=bad.xlsx', [
    { rowNumber: 2, field: '姓名', value: '=HYPERLINK("https://example.com")', level: 'error', message: '+危险内容' },
  ])
  const file = path.join(dir, 'report.xlsx')
  fs.writeFileSync(file, bytes)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(file)
  const ws = wb.worksheets[0]
  assert.equal(ws.getCell('D2').text, "'=HYPERLINK(\"https://example.com\")")
  assert.equal(ws.getCell('E2').text, "'+危险内容")
  assert.equal(wb.worksheets[1].getCell('B1').text, "'=bad.xlsx")
})

test('拒绝非 xlsx 文件', async (t) => {
  const { db, dir } = fixture(t)
  const file = path.join(dir, 'old.xls')
  fs.writeFileSync(file, 'not a workbook')
  await assert.rejects(() => analyzeWorkbook(db, file, baseOptions()), /仅支持 \.xlsx/)
})

test('拒绝改名的宏工作簿和外部链接工作簿', async (t) => {
  const { db, dir } = fixture(t)
  const macroFile = await writeRows(dir, 'macro.xlsx', [{ 姓名: '甲', 性别: '男' }])
  const macroZip = new AdmZip(macroFile)
  macroZip.addFile('xl/vbaProject.bin', Buffer.from('macro'))
  macroZip.writeZip(macroFile)
  await assert.rejects(() => analyzeWorkbook(db, macroFile, baseOptions()), /宏/)

  const linkFile = await writeRows(dir, 'links.xlsx', [{ 姓名: '乙', 性别: '女' }])
  const linkZip = new AdmZip(linkFile)
  linkZip.addFile('xl/externalLinks/externalLink1.xml', Buffer.from('<externalLink/>'))
  linkZip.writeZip(linkFile)
  await assert.rejects(() => analyzeWorkbook(db, linkFile, baseOptions()), /外部链接/)
})

test('拒绝无效默认世代', async (t) => {
  const { db, dir } = fixture(t)
  const file = await writeRows(dir, 'generation.xlsx', [{ 姓名: '甲', 性别: '男' }])
  await assert.rejects(() => analyzeWorkbook(db, file, baseOptions({ defaultGeneration: 0 })), /默认世代/)
  await assert.rejects(() => analyzeWorkbook(db, file, baseOptions({ defaultGeneration: 1.5 })), /默认世代/)
})
