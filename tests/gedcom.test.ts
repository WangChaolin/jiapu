import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import iconv from 'iconv-lite'
import { GenealogyDb } from '../electron/main/db.ts'
import { analyzeGedcom, commitGedcom, exportGedcom } from '../electron/main/gedcom.ts'
import type { GedcomAnalyzeOptions, GedcomExportOptions, GenealogyMeta } from '../electron/shared/types.ts'

function fixture(t: { after: (fn: () => void) => void }): { db: GenealogyDb; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiapu-gedcom-test-'))
  const db = new GenealogyDb(path.join(dir, 'genealogy.db'))
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  return { db, dir }
}

function baseOptions(patch: Partial<GedcomAnalyzeOptions> = {}): GedcomAnalyzeOptions {
  return {
    duplicateMode: 'ask', defaultGeneration: 1, autoDeriveGeneration: true,
    placeTarget: 'remark', photoMode: 'copy', preserveUnsupported: true,
    unsupportedActions: {}, duplicateDecisions: {}, ...patch,
  }
}

function exportOptions(patch: Partial<GedcomExportOptions> = {}): GedcomExportOptions {
  return {
    scope: 'all', branchId: null, generation: null, memberIds: [],
    version: '5.5.1', encoding: 'utf-8', includePhotos: false,
    includeNotes: true, includeCompatibility: true, ...patch,
  }
}

function meta(name = '张氏家谱'): GenealogyMeta {
  const now = Date.now()
  return { id: 'test', name, hall: '百忍堂', surname: '张', origin: '', compiler: '', note: '', createdAt: now, updatedAt: now, memberCount: 0, lastOpenedAt: now }
}

const sample = `0 HEAD
1 SOUR TEST
1 GEDC
2 VERS 5.5.1
2 FORM LINEAGE-LINKED
1 CHAR UNICODE
0 @I1@ INDI
1 NAME 张国栋 /张/
1 SEX M
1 BIRT
2 DATE 12 MAR 1850
2 PLAC 山东清河
1 OCCU 修谱人
1 NOTE 始祖
0 @I2@ INDI
1 NAME 李秀兰 /李/
1 SEX F
1 BIRT
2 DATE 6 JUN 1853
0 @I3@ INDI
1 NAME 张心兰 /张/
1 SEX F
1 BIRT
2 DATE 2 NOV 1872
1 FAMC @F1@
2 PEDI birth
1 _TODO 待考证
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
1 MARR
2 DATE 1872
0 TRLR
`

test('GEDCOM 预检解析个人、家庭、事件与特殊标签', (t) => {
  const { db, dir } = fixture(t)
  const file = path.join(dir, 'sample.ged')
  fs.writeFileSync(file, sample, 'utf8')
  const analysis = analyzeGedcom(db, file, baseOptions())
  assert.equal(analysis.preview.individualCount, 3)
  assert.equal(analysis.preview.familyCount, 1)
  assert.equal(analysis.preview.validCount, 3)
  assert.equal(analysis.preview.version, '5.5.1')
  assert.equal(analysis.preview.encoding, 'UTF-8')
  assert.equal(analysis.members.find((m) => m.sourceId === '@I1@')?.member.birthDate, '1850-03-12')
  assert.equal(analysis.members.find((m) => m.sourceId === '@I3@')?.member.generation, 2)
  assert.match(analysis.members.find((m) => m.sourceId === '@I3@')?.member.remark ?? '', /_TODO/)
  assert.ok(analysis.preview.unsupportedTags.some((tag) => tag.tag === '_TODO'))
  assert.ok(analysis.relations.some((r) => r.type === 'spouse'))
  assert.ok(analysis.relations.filter((r) => r.type === 'parent_child').length >= 2)
})

test('GEDCOM 导入事务写入关系并可按批次撤销', (t) => {
  const { db, dir } = fixture(t)
  const file = path.join(dir, 'commit.ged')
  fs.writeFileSync(file, sample, 'utf8')
  const analysis = analyzeGedcom(db, file, baseOptions())
  const result = commitGedcom(db, file, baseOptions(), analysis.preview.fileHash, { savePhoto: () => '', deletePhoto: () => {} })
  assert.equal(result.ok, true)
  assert.equal(result.successCount, 3)
  assert.ok(result.relationCount >= 3)
  const child = db.listMembers({ keyword: '张心兰' }).rows[0]
  assert.equal(child.generation, 2)
  assert.equal(db.getMember(child.id)!.parents.length, 2)
  assert.equal(db.listImportBatches()[0].sourceName, 'commit.ged')
  const undone = db.undoImport(result.batchId!)
  assert.deepEqual(undone, { ok: true, count: 3 })
  assert.equal(db.countMembers(), 0)
  assert.equal(db.graph().edges.length, 0)
})

test('GEDCOM 重复成员默认跳过，可确认作为新成员导入', (t) => {
  const { db, dir } = fixture(t)
  db.createMember({ name: '张国栋', gender: '男', birthDate: '1850-03-12' })
  const file = path.join(dir, 'duplicate.ged')
  fs.writeFileSync(file, sample, 'utf8')
  const skip = analyzeGedcom(db, file, baseOptions({ duplicateMode: 'skip' }))
  assert.equal(skip.preview.duplicateCount, 1)
  assert.equal(skip.preview.validCount, 2)
  const ask = analyzeGedcom(db, file, baseOptions({ duplicateMode: 'ask', duplicateDecisions: { '@I1@': 'import' } }))
  assert.equal(ask.preview.validCount, 3)
})

test('提交拒绝预检后被修改的文件', (t) => {
  const { db, dir } = fixture(t)
  const file = path.join(dir, 'changed.ged')
  fs.writeFileSync(file, sample, 'utf8')
  const analysis = analyzeGedcom(db, file, baseOptions())
  fs.appendFileSync(file, '0 @I9@ INDI\n1 NAME 新增\n')
  const result = commitGedcom(db, file, baseOptions(), analysis.preview.fileHash, { savePhoto: () => '', deletePhoto: () => {} })
  assert.equal(result.ok, false)
  assert.match(result.message ?? '', /变化/)
  assert.equal(db.countMembers(), 0)
})

test('GEDCOM 导出后可往返导入成员与关系', (t) => {
  const source = fixture(t)
  const father = source.db.createMember({ name: '张国栋', gender: '男', generation: 1, birthDate: '1850-03-12', occupation: '修谱人' })
  const mother = source.db.createMember({ name: '李秀兰', gender: '女', generation: 1, birthDate: '1853-06-06' })
  source.db.createMember({
    name: '张心兰', gender: '女', generation: 2, birthDate: '1872-11-02', remark: '兼祧说明',
    parents: [{ otherId: father.id, subtype: '生父' }, { otherId: mother.id, subtype: '生母' }],
    spouses: [],
  })
  source.db.updateMember(father.id, { ...father, spouses: [{ otherId: mother.id, subtype: '原配' }] })
  const exported = exportGedcom(source.db, meta(), exportOptions(), '1.0.0', source.dir)
  assert.match(exported.content, /0 @I0001@ INDI/)
  assert.match(exported.content, /2 DATE 12 MAR 1850/)
  assert.match(exported.content, /1 CHIL @I0003@/)
  const file = path.join(source.dir, 'roundtrip.ged')
  fs.writeFileSync(file, exported.content, 'utf8')

  const target = fixture(t)
  const analysis = analyzeGedcom(target.db, file, baseOptions())
  assert.equal(analysis.preview.individualCount, 3)
  const result = commitGedcom(target.db, file, baseOptions(), analysis.preview.fileHash, { savePhoto: () => '', deletePhoto: () => {} })
  assert.equal(result.ok, true)
  const child = target.db.listMembers({ keyword: '张心兰' }).rows[0]
  assert.equal(child.generation, 2)
  assert.equal(child.remark, '兼祧说明')
  assert.equal(target.db.getMember(child.id)!.parents.length, 2)
  const targetFather = target.db.listMembers({ keyword: '张国栋' }).rows[0]
  assert.equal(target.db.getMember(targetFather.id)!.spouses.length, 1)
})

test('支持 GBK 编码 GEDCOM 导入', (t) => {
  const { db, dir } = fixture(t)
  const file = path.join(dir, 'gbk.ged')
  fs.writeFileSync(file, iconv.encode(sample, 'gbk'))
  const analysis = analyzeGedcom(db, file, baseOptions())
  assert.equal(analysis.preview.encoding, 'GBK / ANSI')
  assert.equal(analysis.members[0].member.name, '张国栋')
})

test('拒绝非 GEDCOM 扩展名', (t) => {
  const { db, dir } = fixture(t)
  const file = path.join(dir, 'sample.txt')
  fs.writeFileSync(file, sample, 'utf8')
  assert.throws(() => analyzeGedcom(db, file, baseOptions()), /仅支持 \.ged/)
})
