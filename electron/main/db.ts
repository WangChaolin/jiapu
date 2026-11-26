import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type {
  Branch, BranchOperation, BranchOperationPreview, BranchOperationResult, DuplicateMemberGroup,
  ExcelBatch, ExcelIssue, GenealogyStats, GraphData, Member, MemberDetail, MemberFilter,
  MemberInput, MemberMergeRequest, MemberMergeResult, MergeField, RelationLink, ZibeiEntry, ZibeiPoem,
} from '../shared/types'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS member (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  gender TEXT NOT NULL DEFAULT '男',
  generation INTEGER NOT NULL DEFAULT 1,
  branch_id TEXT,
  birth_date TEXT NOT NULL DEFAULT '',
  birth_lunar INTEGER NOT NULL DEFAULT 0,
  death_date TEXT NOT NULL DEFAULT '',
  death_lunar INTEGER NOT NULL DEFAULT 0,
  alive INTEGER NOT NULL DEFAULT 1,
  birth_order INTEGER NOT NULL DEFAULT 1,
  courtesy_name TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  occupation TEXT NOT NULL DEFAULT '',
  residence TEXT NOT NULL DEFAULT '',
  burial TEXT NOT NULL DEFAULT '',
  biography TEXT NOT NULL DEFAULT '',
  remark TEXT NOT NULL DEFAULT '',
  photo_path TEXT NOT NULL DEFAULT '',
  deleted INTEGER NOT NULL DEFAULT 0,
  delete_batch TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_member_gen ON member(generation, deleted);
CREATE INDEX IF NOT EXISTS idx_member_name ON member(name, deleted);
CREATE TABLE IF NOT EXISTS relation (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  subtype TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  deleted INTEGER NOT NULL DEFAULT 0,
  delete_batch TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rel_from ON relation(from_id, deleted);
CREATE INDEX IF NOT EXISTS idx_rel_to ON relation(to_id, deleted);
CREATE TABLE IF NOT EXISTS generation_char (
  id TEXT PRIMARY KEY,
  branch_id TEXT,
  generation INTEGER NOT NULL,
  char TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS branch (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  founder_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS change_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS import_batch (
  id TEXT PRIMARY KEY,
  source_name TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  total_rows INTEGER NOT NULL,
  success_count INTEGER NOT NULL,
  skipped_count INTEGER NOT NULL,
  failed_count INTEGER NOT NULL,
  options_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  undone_at INTEGER
);
CREATE TABLE IF NOT EXISTS import_issue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  row_number INTEGER NOT NULL,
  field TEXT NOT NULL DEFAULT '',
  value TEXT NOT NULL DEFAULT '',
  level TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_import_issue_batch ON import_issue(batch_id);
CREATE TABLE IF NOT EXISTS undo_action (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  undone_at INTEGER
);
`

interface MemberRow {
  id: string; name: string; gender: string; generation: number; branch_id: string | null
  birth_date: string; birth_lunar: number; death_date: string; death_lunar: number
  alive: number; birth_order: number; courtesy_name: string; title: string
  occupation: string; residence: string; burial: string; biography: string; remark: string
  photo_path: string; deleted: number; created_at: number; updated_at: number
}

interface RelationRow {
  id: string; type: string; subtype: string; from_id: string; to_id: string
  is_primary: number; note: string
}

interface BranchRow {
  id: string; name: string; parent_id: string | null; founder_id: string | null
  note: string; deleted: number; created_at: number
}

interface GenerationCharRow {
  id: string; branch_id: string | null; generation: number; char: string; note: string
}

interface UndoMemberSnapshot extends MemberRow { delete_batch: string }
interface UndoRelationSnapshot extends RelationRow { deleted: number; delete_batch: string; created_at: number; updated_at: number }
interface BranchSnapshot {
  members: { id: string; branch_id: string | null }[]
  branches: BranchRow[]
  generationChars: GenerationCharRow[]
  createdBranchIds: string[]
  createdGenerationCharIds: string[]
}
interface MemberMergeSnapshot {
  members: UndoMemberSnapshot[]
  relations: UndoRelationSnapshot[]
  founders: { id: string; founderId: string | null }[]
}

export interface ExcelImportRow {
  sourceRow: number
  member: MemberInput
  branchName?: string | null
}

export interface ExcelImportCommit {
  batchId: string
  sourceName: string
  sourceHash: string
  totalRows: number
  skippedCount: number
  failedCount: number
  rows: ExcelImportRow[]
  issues: ExcelIssue[]
  missingBranches: string[]
  options: unknown
}

export interface GedcomImportMember {
  sourceId: string
  member: MemberInput
}

export interface GedcomImportRelation {
  fromSourceId: string
  toSourceId: string
  type: 'parent_child' | 'spouse'
  subtype: string
  isPrimary: boolean
  note: string
}

export interface GedcomImportCommit {
  batchId: string
  sourceName: string
  sourceHash: string
  totalRows: number
  skippedCount: number
  failedCount: number
  members: GedcomImportMember[]
  relations: GedcomImportRelation[]
  issues: ExcelIssue[]
  options: unknown
}

function rowToMember(r: MemberRow): Member {
  return {
    id: r.id, name: r.name, gender: r.gender as Member['gender'],
    generation: r.generation, branchId: r.branch_id,
    birthDate: r.birth_date, birthLunar: r.birth_lunar === 1,
    deathDate: r.death_date, deathLunar: r.death_lunar === 1,
    alive: r.alive === 1, birthOrder: r.birth_order,
    courtesyName: r.courtesy_name, title: r.title, occupation: r.occupation,
    residence: r.residence, burial: r.burial, biography: r.biography, remark: r.remark,
    photoPath: r.photo_path, createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

const now = (): number => Date.now()

export class GenealogyDb {
  private db: DatabaseSync

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA foreign_keys = ON;')
    this.db.exec(SCHEMA)
    const memberColumns = this.db.prepare('PRAGMA table_info(member)').all() as { name: string }[]
    if (!memberColumns.some((c) => c.name === 'remark')) {
      this.db.exec("ALTER TABLE member ADD COLUMN remark TEXT NOT NULL DEFAULT ''")
    }
  }

  close(): void { this.db.close() }

  private log(entity: string, entityId: string, op: string, payload = ''): void {
    this.db.prepare('INSERT INTO change_log(entity, entity_id, op, payload, created_at) VALUES(?,?,?,?,?)')
      .run(entity, entityId, op, payload, now())
  }

  getMeta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    return r ? r.value : null
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }

  integrityCheck(): boolean {
    const r = this.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
    return r.integrity_check === 'ok'
  }

  vacuumInto(target: string): void {
    this.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
  }

  // ---------- members ----------

  listMembers(filter: MemberFilter = {}): { total: number; rows: Member[] } {
    const where: string[] = ['deleted = 0']
    const params: (string | number)[] = []
    if (filter.keyword) {
      where.push('(name LIKE ? OR courtesy_name LIKE ? OR title LIKE ?)')
      const kw = `%${filter.keyword}%`
      params.push(kw, kw, kw)
    }
    if (filter.generation != null) { where.push('generation = ?'); params.push(filter.generation) }
    if (filter.gender) { where.push('gender = ?'); params.push(filter.gender) }
    if (filter.aliveOnly) { where.push('alive = 1') }
    if (filter.branchId) {
      const ids = this.branchSubtreeIds(filter.branchId)
      where.push(`branch_id IN (${ids.map(() => '?').join(',')})`)
      params.push(...ids)
    }
    const w = where.join(' AND ')
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM member WHERE ${w}`).get(...params) as { c: number }).c
    let sql = `SELECT * FROM member WHERE ${w} ORDER BY generation, birth_order, name`
    if (filter.limit != null) { sql += ' LIMIT ? OFFSET ?'; params.push(filter.limit, filter.offset ?? 0) }
    const rows = (this.db.prepare(sql).all(...params) as unknown as MemberRow[]).map(rowToMember)
    return { total, rows }
  }

  getMember(id: string): MemberDetail | null {
    const r = this.db.prepare('SELECT * FROM member WHERE id = ? AND deleted = 0').get(id) as MemberRow | undefined
    if (!r) return null
    const m = rowToMember(r)
    const otherOf = this.db.prepare('SELECT name, gender FROM member WHERE id = ?')
    const toLink = (rel: RelationRow, otherId: string): RelationLink => {
      const other = otherOf.get(otherId) as { name: string; gender: Member['gender'] } | undefined
      return {
        id: rel.id, type: rel.type as RelationLink['type'], subtype: rel.subtype,
        otherId, otherName: other?.name ?? '（已删除）', otherGender: other?.gender ?? '其他',
        isPrimary: rel.is_primary === 1, note: rel.note,
      }
    }
    const parentRels = this.db.prepare(
      "SELECT * FROM relation WHERE type = 'parent_child' AND to_id = ? AND deleted = 0 ORDER BY created_at, rowid",
    ).all(id) as unknown as RelationRow[]
    const childRels = this.db.prepare(
      "SELECT * FROM relation WHERE type = 'parent_child' AND from_id = ? AND deleted = 0 ORDER BY created_at, rowid",
    ).all(id) as unknown as RelationRow[]
    const spouseRels = this.db.prepare(
      "SELECT * FROM relation WHERE type = 'spouse' AND (from_id = ? OR to_id = ?) AND deleted = 0 ORDER BY created_at, rowid",
    ).all(id, id) as unknown as RelationRow[]
    return {
      ...m,
      parents: parentRels.map((rel) => toLink(rel, rel.from_id)),
      children: childRels.map((rel) => toLink(rel, rel.to_id)),
      spouses: spouseRels.map((rel) => toLink(rel, rel.from_id === id ? rel.to_id : rel.from_id)),
    }
  }

  getMembersDetails(ids: string[]): MemberDetail[] {
    if (!ids.length) return []
    const ph = ids.map(() => '?').join(',')
    const rows = this.db.prepare(`SELECT * FROM member WHERE id IN (${ph}) AND deleted = 0`).all(...ids) as unknown as MemberRow[]
    const rels = this.db.prepare(
      `SELECT * FROM relation WHERE deleted = 0 AND (from_id IN (${ph}) OR to_id IN (${ph})) ORDER BY created_at, rowid`,
    ).all(...ids, ...ids) as unknown as RelationRow[]
    const involved = new Set<string>()
    for (const r of rels) { involved.add(r.from_id); involved.add(r.to_id) }
    const nameMap = new Map<string, { name: string; gender: Member['gender'] }>()
    if (involved.size) {
      const nph = [...involved].map(() => '?').join(',')
      const nr = this.db.prepare(`SELECT id, name, gender FROM member WHERE id IN (${nph})`).all(...involved) as { id: string; name: string; gender: Member['gender'] }[]
      for (const n of nr) nameMap.set(n.id, { name: n.name, gender: n.gender })
    }
    const link = (rel: RelationRow, otherId: string): RelationLink => ({
      id: rel.id, type: rel.type as RelationLink['type'], subtype: rel.subtype,
      otherId, otherName: nameMap.get(otherId)?.name ?? '（已删除）', otherGender: nameMap.get(otherId)?.gender ?? '其他',
      isPrimary: rel.is_primary === 1, note: rel.note,
    })
    const byId = new Map<string, MemberDetail>(rows.map((r) => [r.id, { ...rowToMember(r), parents: [], spouses: [], children: [] }]))
    for (const rel of rels) {
      if (rel.type === 'parent_child') {
        byId.get(rel.to_id)?.parents.push(link(rel, rel.from_id))
        byId.get(rel.from_id)?.children.push(link(rel, rel.to_id))
      } else if (rel.type === 'spouse') {
        byId.get(rel.from_id)?.spouses.push(link(rel, rel.to_id))
        byId.get(rel.to_id)?.spouses.push(link(rel, rel.from_id))
      }
    }
    return ids.map((id) => byId.get(id)).filter((d): d is MemberDetail => !!d)
  }

  private descendantIds(id: string): Set<string> {
    const seen = new Set<string>([id])
    const queue = [id]
    const stmt = this.db.prepare("SELECT to_id FROM relation WHERE type = 'parent_child' AND from_id = ? AND deleted = 0")
    while (queue.length) {
      const cur = queue.pop()!
      for (const r of stmt.all(cur) as { to_id: string }[]) {
        if (!seen.has(r.to_id)) { seen.add(r.to_id); queue.push(r.to_id) }
      }
    }
    return seen
  }

  private ancestorIds(id: string): Set<string> {
    const seen = new Set<string>([id])
    const queue = [id]
    const stmt = this.db.prepare("SELECT from_id FROM relation WHERE type = 'parent_child' AND to_id = ? AND deleted = 0")
    while (queue.length) {
      const cur = queue.pop()!
      for (const r of stmt.all(cur) as { from_id: string }[]) {
        if (!seen.has(r.from_id)) { seen.add(r.from_id); queue.push(r.from_id) }
      }
    }
    return seen
  }

  private deriveGeneration(parentIds: string[]): number {
    let max = 0
    const stmt = this.db.prepare('SELECT generation FROM member WHERE id = ? AND deleted = 0')
    for (const pid of parentIds) {
      const r = stmt.get(pid) as { generation: number } | undefined
      if (r && r.generation > max) max = r.generation
    }
    return max > 0 ? max + 1 : 1
  }

  private validateParents(childId: string | null, parents: { otherId: string }[]): void {
    if (!childId) return
    const desc = this.descendantIds(childId)
    for (const p of parents) {
      if (p.otherId === childId) throw new Error('不能将本人设为自己的父母')
      if (desc.has(p.otherId)) throw new Error('关系将形成循环：所选父母是该成员的后代')
    }
  }

  private insertParentRels(childId: string, parents: NonNullable<MemberInput['parents']>): void {
    const stmt = this.db.prepare(
      `INSERT INTO relation(id, type, subtype, from_id, to_id, is_primary, note, created_at, updated_at)
       VALUES(?, 'parent_child', ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const p of parents) {
      const t = now()
      const rid = randomUUID()
      stmt.run(rid, p.subtype, p.otherId, childId, p.isPrimary === false ? 0 : 1, p.note ?? '', t, t)
      this.log('relation', rid, 'create', JSON.stringify({ type: 'parent_child', from: p.otherId, to: childId }))
    }
  }

  private insertSpouseRels(memberId: string, spouses: NonNullable<MemberInput['spouses']>): void {
    const stmt = this.db.prepare(
      `INSERT INTO relation(id, type, subtype, from_id, to_id, is_primary, note, created_at, updated_at)
       VALUES(?, 'spouse', ?, ?, ?, 1, ?, ?, ?)`,
    )
    for (const s of spouses) {
      if (s.otherId === memberId) throw new Error('不能与本人建立配偶关系')
      const t = now()
      const rid = randomUUID()
      const [a, b] = [memberId, s.otherId].sort()
      stmt.run(rid, s.subtype, a, b, s.note ?? '', t, t)
      this.log('relation', rid, 'create', JSON.stringify({ type: 'spouse', from: a, to: b }))
    }
  }

  createMember(input: MemberInput): Member {
    if (!input.name.trim()) throw new Error('姓名不能为空')
    const parents = input.parents ?? []
    this.validateParents(null, parents)
    const id = randomUUID()
    const t = now()
    const generation = input.generation ?? this.deriveGeneration(parents.map((p) => p.otherId))
    this.db.prepare(
      `INSERT INTO member(id, name, gender, generation, branch_id, birth_date, birth_lunar, death_date, death_lunar,
        alive, birth_order, courtesy_name, title, occupation, residence, burial, biography, remark, photo_path, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id, input.name.trim(), input.gender, generation, input.branchId ?? null,
      input.birthDate ?? '', input.birthLunar ? 1 : 0, input.deathDate ?? '', input.deathLunar ? 1 : 0,
      input.alive === false ? 0 : 1, input.birthOrder ?? 1, input.courtesyName ?? '', input.title ?? '',
      input.occupation ?? '', input.residence ?? '', input.burial ?? '', input.biography ?? '', input.remark ?? '',
      input.photoPath ?? '', t, t,
    )
    this.insertParentRels(id, parents)
    this.insertSpouseRels(id, input.spouses ?? [])
    this.log('member', id, 'create', JSON.stringify({ name: input.name }))
    return this.getMember(id)!
  }

  updateMember(id: string, input: MemberInput): MemberDetail {
    const existing = this.getMember(id)
    if (!existing) throw new Error('成员不存在')
    if (!input.name.trim()) throw new Error('姓名不能为空')
    const parents = input.parents ?? []
    this.validateParents(id, parents)
    const t = now()
    const generation = input.generation ?? existing.generation
    this.db.prepare(
      `UPDATE member SET name=?, gender=?, generation=?, branch_id=?, birth_date=?, birth_lunar=?, death_date=?,
        death_lunar=?, alive=?, birth_order=?, courtesy_name=?, title=?, occupation=?, residence=?, burial=?,
        biography=?, remark=?, photo_path=?, updated_at=? WHERE id=?`,
    ).run(
      input.name.trim(), input.gender, generation, input.branchId ?? null,
      input.birthDate ?? '', input.birthLunar ? 1 : 0, input.deathDate ?? '', input.deathLunar ? 1 : 0,
      input.alive === false ? 0 : 1, input.birthOrder ?? 1, input.courtesyName ?? '', input.title ?? '',
      input.occupation ?? '', input.residence ?? '', input.burial ?? '', input.biography ?? '', input.remark ?? '',
      input.photoPath ?? '', t, id,
    )
    const batch = randomUUID()
    this.db.prepare(
      "UPDATE relation SET deleted = 1, delete_batch = ?, updated_at = ? WHERE deleted = 0 AND (to_id = ? OR (type = 'spouse' AND from_id = ?))",
    ).run(batch, t, id, id)
    this.insertParentRels(id, parents)
    this.insertSpouseRels(id, input.spouses ?? [])
    this.log('member', id, 'update', JSON.stringify({ name: input.name, replacedRelations: batch }))
    return this.getMember(id)!
  }

  deleteMember(id: string): { name: string } {
    const m = this.getMember(id)
    if (!m) throw new Error('成员不存在')
    const batch = randomUUID()
    const t = now()
    this.db.prepare('UPDATE member SET deleted = 1, delete_batch = ?, updated_at = ? WHERE id = ?').run(batch, t, id)
    this.db.prepare(
      'UPDATE relation SET deleted = 1, delete_batch = ?, updated_at = ? WHERE deleted = 0 AND (from_id = ? OR to_id = ?)',
    ).run(batch, t, id, id)
    this.db.prepare('UPDATE branch SET founder_id = NULL WHERE founder_id = ?').run(id)
    this.log('member', id, 'delete', JSON.stringify({ name: m.name, batch }))
    return { name: m.name }
  }

  restoreMember(id: string): boolean {
    const r = this.db.prepare('SELECT delete_batch FROM member WHERE id = ? AND deleted = 1').get(id) as { delete_batch: string } | undefined
    if (!r || !r.delete_batch) return false
    const t = now()
    this.db.prepare("UPDATE member SET deleted = 0, delete_batch = '', updated_at = ? WHERE delete_batch = ?").run(t, r.delete_batch)
    this.db.prepare("UPDATE relation SET deleted = 0, delete_batch = '', updated_at = ? WHERE delete_batch = ?").run(t, r.delete_batch)
    this.log('member', id, 'restore', JSON.stringify({ batch: r.delete_batch }))
    return true
  }

  countMembers(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM member WHERE deleted = 0').get() as { c: number }).c
  }

  stats(): GenealogyStats {
    const one = this.db.prepare(
      `SELECT COUNT(*) AS c,
        SUM(CASE WHEN gender = '男' THEN 1 ELSE 0 END) AS male,
        SUM(CASE WHEN gender = '女' THEN 1 ELSE 0 END) AS female,
        SUM(alive) AS aliveCount,
        MAX(generation) AS maxGen
       FROM member WHERE deleted = 0`,
    ).get() as { c: number; male: number | null; female: number | null; aliveCount: number | null; maxGen: number | null }
    const years = (this.db.prepare(
      "SELECT birth_date FROM member WHERE deleted = 0 AND birth_date != ''",
    ).all() as { birth_date: string }[])
      .map((r) => parseInt(r.birth_date.slice(0, 4), 10))
      .filter((y) => Number.isFinite(y))
    return {
      memberCount: one.c, maleCount: one.male ?? 0, femaleCount: one.female ?? 0,
      aliveCount: one.aliveCount ?? 0, generations: one.maxGen ?? 0,
      branchCount: (this.db.prepare('SELECT COUNT(*) AS c FROM branch WHERE deleted = 0').get() as { c: number }).c,
      earliestYear: years.length ? Math.min(...years) : null,
      latestYear: years.length ? Math.max(...years) : null,
    }
  }

  graph(): GraphData {
    const members = (this.db.prepare('SELECT * FROM member WHERE deleted = 0 ORDER BY generation, birth_order, name').all() as unknown as MemberRow[]).map(rowToMember)
    const edges = (this.db.prepare('SELECT * FROM relation WHERE deleted = 0').all() as unknown as RelationRow[]).map((r) => ({
      id: r.id, type: r.type as 'parent_child' | 'spouse', subtype: r.subtype,
      from: r.from_id, to: r.to_id, isPrimary: r.is_primary === 1,
    }))
    return { members, edges }
  }

  // ---------- branches ----------

  listBranches(): Branch[] {
    const rows = this.db.prepare('SELECT * FROM branch WHERE deleted = 0 ORDER BY created_at').all() as {
      id: string; name: string; parent_id: string | null; founder_id: string | null; note: string; created_at: number
    }[]
    const counts = this.db.prepare(
      'SELECT branch_id, COUNT(*) AS c FROM member WHERE deleted = 0 AND branch_id IS NOT NULL GROUP BY branch_id',
    ).all() as { branch_id: string; c: number }[]
    const countMap = new Map(counts.map((r) => [r.branch_id, r.c]))
    const nameOf = this.db.prepare('SELECT name FROM member WHERE id = ?')
    return rows.map((r) => ({
      id: r.id, name: r.name, parentId: r.parent_id, founderId: r.founder_id,
      founderName: r.founder_id ? ((nameOf.get(r.founder_id) as { name: string } | undefined)?.name ?? '') : '',
      note: r.note, memberCount: countMap.get(r.id) ?? 0, createdAt: r.created_at,
    }))
  }

  branchSubtreeIds(rootId: string): string[] {
    const all = this.db.prepare('SELECT id, parent_id FROM branch WHERE deleted = 0').all() as { id: string; parent_id: string | null }[]
    const children = new Map<string, string[]>()
    for (const b of all) {
      if (b.parent_id) {
        if (!children.has(b.parent_id)) children.set(b.parent_id, [])
        children.get(b.parent_id)!.push(b.id)
      }
    }
    const out: string[] = []
    const queue = [rootId]
    while (queue.length) {
      const cur = queue.pop()!
      out.push(cur)
      queue.push(...(children.get(cur) ?? []))
    }
    return out
  }

  createBranch(name: string, parentId: string | null, founderId: string | null, note: string): Branch {
    if (!name.trim()) throw new Error('支系名称不能为空')
    if (parentId && !this.db.prepare('SELECT id FROM branch WHERE id = ? AND deleted = 0').get(parentId)) {
      throw new Error('上级支系不存在')
    }
    const id = randomUUID()
    this.db.prepare('INSERT INTO branch(id, name, parent_id, founder_id, note, created_at) VALUES(?,?,?,?,?,?)')
      .run(id, name.trim(), parentId, founderId, note, now())
    this.log('branch', id, 'create', JSON.stringify({ name }))
    return this.listBranches().find((b) => b.id === id)!
  }

  updateBranch(id: string, name: string, parentId: string | null, founderId: string | null, note: string): void {
    if (!name.trim()) throw new Error('支系名称不能为空')
    if (parentId === id) throw new Error('上级支系不能是自身')
    if (parentId && this.branchSubtreeIds(id).includes(parentId)) throw new Error('上级支系不能是自身的下级')
    this.db.prepare('UPDATE branch SET name = ?, parent_id = ?, founder_id = ?, note = ? WHERE id = ? AND deleted = 0')
      .run(name.trim(), parentId, founderId, note, id)
    this.log('branch', id, 'update', JSON.stringify({ name }))
  }

  deleteBranch(id: string): void {
    const b = this.db.prepare('SELECT * FROM branch WHERE id = ? AND deleted = 0').get(id) as { parent_id: string | null } | undefined
    if (!b) throw new Error('支系不存在')
    const ids = this.branchSubtreeIds(id)
    const marks = ids.map(() => '?').join(',')
    this.db.prepare(`UPDATE branch SET deleted = 1 WHERE id IN (${marks})`).run(...ids)
    this.db.prepare(`UPDATE member SET branch_id = ? WHERE branch_id IN (${marks})`).run(b.parent_id, ...ids)
    this.db.prepare(`UPDATE generation_char SET branch_id = ? WHERE branch_id IN (${marks})`).run(b.parent_id, ...ids)
    this.log('branch', id, 'delete', JSON.stringify({ subtree: ids }))
  }

  // ---------- P1 branch operations ----------

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  private saveUndoAction(kind: 'branch' | 'member-merge', payload: BranchSnapshot | MemberMergeSnapshot): string {
    const id = randomUUID()
    this.db.prepare('INSERT INTO undo_action(id, kind, payload, created_at) VALUES(?,?,?,?)')
      .run(id, kind, JSON.stringify(payload), now())
    return id
  }

  private branchSnapshot(branchIds: string[], memberIds?: string[]): BranchSnapshot {
    const marks = branchIds.map(() => '?').join(',')
    const memberMarks = memberIds?.map(() => '?').join(',')
    return {
      members: this.db.prepare(memberMarks
        ? `SELECT id, branch_id FROM member WHERE id IN (${memberMarks})`
        : branchIds.length ? `SELECT id, branch_id FROM member WHERE branch_id IN (${marks})` : 'SELECT id, branch_id FROM member WHERE 0')
        .all(...(memberIds ?? branchIds)) as { id: string; branch_id: string | null }[],
      branches: branchIds.length
        ? this.db.prepare(`SELECT * FROM branch WHERE id IN (${marks})`).all(...branchIds) as unknown as BranchRow[]
        : [],
      generationChars: branchIds.length
        ? this.db.prepare(`SELECT * FROM generation_char WHERE branch_id IN (${marks})`).all(...branchIds) as unknown as GenerationCharRow[]
        : [],
      createdBranchIds: [],
      createdGenerationCharIds: [],
    }
  }

  private restoreBranchSnapshot(snapshot: BranchSnapshot): void {
    const deleteBranch = this.db.prepare('UPDATE branch SET deleted = 1 WHERE id = ?')
    for (const id of snapshot.createdBranchIds) deleteBranch.run(id)
    const deleteChar = this.db.prepare('DELETE FROM generation_char WHERE id = ?')
    for (const id of snapshot.createdGenerationCharIds) deleteChar.run(id)
    const restoreMember = this.db.prepare('UPDATE member SET branch_id = ?, updated_at = ? WHERE id = ?')
    for (const m of snapshot.members) restoreMember.run(m.branch_id, now(), m.id)
    const restoreChar = this.db.prepare('UPDATE generation_char SET branch_id = ? WHERE id = ?')
    for (const c of snapshot.generationChars) restoreChar.run(c.branch_id, c.id)
    const restoreBranch = this.db.prepare(
      `INSERT INTO branch(id, name, parent_id, founder_id, note, deleted, created_at) VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, parent_id=excluded.parent_id, founder_id=excluded.founder_id,
       note=excluded.note, deleted=excluded.deleted, created_at=excluded.created_at`,
    )
    for (const b of snapshot.branches) restoreBranch.run(b.id, b.name, b.parent_id, b.founder_id, b.note, b.deleted, b.created_at)
  }

  private branchPreview(request: BranchOperation): BranchOperationPreview {
    let branchIds: string[] = []
    let rootBranchIds: string[] = []
    let memberIds: string[] = []
    let targetName = ''
    if (request.kind === 'merge') {
      const target = this.db.prepare('SELECT name FROM branch WHERE id = ? AND deleted = 0').get(request.targetId) as { name: string } | undefined
      if (!target) throw new Error('目标支系不存在')
      targetName = target.name
      rootBranchIds = [...new Set(request.sourceIds)]
      for (const id of rootBranchIds) branchIds.push(...this.branchSubtreeIds(id))
      branchIds = [...new Set(branchIds)]
      const marks = branchIds.map(() => '?').join(',')
      memberIds = (this.db.prepare(`SELECT id FROM member WHERE deleted = 0 AND branch_id IN (${marks})`).all(...branchIds) as { id: string }[]).map((m) => m.id)
    } else if (request.kind === 'split') {
      const source = this.db.prepare('SELECT name FROM branch WHERE id = ? AND deleted = 0').get(request.branchId) as { name: string } | undefined
      if (!source) throw new Error('待拆分支系不存在')
      targetName = request.name.trim() || '新支系'
      rootBranchIds = [request.branchId]
      branchIds = this.branchSubtreeIds(request.branchId)
      const descendant = this.descendantIds(request.founderId)
      const marks = branchIds.map(() => '?').join(',')
      memberIds = (this.db.prepare(`SELECT id FROM member WHERE deleted = 0 AND branch_id IN (${marks})`).all(...branchIds) as { id: string }[])
        .map((m) => m.id).filter((id) => descendant.has(id))
    } else {
      memberIds = request.memberIds
      if (request.targetBranchId) {
        const target = this.db.prepare('SELECT name FROM branch WHERE id = ? AND deleted = 0').get(request.targetBranchId) as { name: string } | undefined
        if (!target) throw new Error('目标支系不存在')
        targetName = target.name
      } else targetName = '无支系'
    }
    const memberMarks = memberIds.map(() => '?').join(',')
    const relationCount = memberIds.length
      ? ((this.db.prepare(`SELECT COUNT(*) AS c FROM relation WHERE deleted = 0 AND (from_id IN (${memberMarks}) OR to_id IN (${memberMarks}))`)
        .get(...memberIds, ...memberIds) as unknown as { c: number } | undefined)?.c ?? 0)
      : 0
    const branchMarks = branchIds.map(() => '?').join(',')
    const rows = branchIds.length
      ? this.db.prepare(`SELECT id, name, founder_id FROM branch WHERE id IN (${branchMarks})`).all(...branchIds) as { id: string; name: string; founder_id: string | null }[]
      : []
    const founderIds = rows.map((b) => b.founder_id).filter((id): id is string => !!id)
    const founderNames = founderIds.length
      ? (this.db.prepare(`SELECT name FROM member WHERE id IN (${founderIds.map(() => '?').join(',')})`).all(...founderIds) as { name: string }[]).map((m) => m.name)
      : []
    return {
      memberCount: memberIds.length,
      childBranchCount: rows.filter((b) => !rootBranchIds.includes(b.id)).length,
      relationCount,
      founderNames: [...new Set(founderNames)],
      sourceNames: rows.map((b) => b.name),
      targetName,
    }
  }

  previewBranchOperation(request: BranchOperation): BranchOperationPreview {
    if (request.kind === 'merge') {
      const sourceIds = [...new Set(request.sourceIds)]
      if (sourceIds.length < 2) throw new Error('请至少选择两个待合并支系')
      for (const id of sourceIds) {
        if (!this.db.prepare('SELECT id FROM branch WHERE id = ? AND deleted = 0').get(id)) throw new Error('待合并支系不存在')
        if (id === request.targetId || this.branchSubtreeIds(id).includes(request.targetId)) throw new Error('不能把支系合并到自身或下级支系')
      }
      return this.branchPreview({ ...request, sourceIds })
    }
    if (request.kind === 'split') {
      if (!request.name.trim()) throw new Error('请填写新支系名称')
      const source = this.db.prepare('SELECT id FROM branch WHERE id = ? AND deleted = 0').get(request.branchId)
      const founder = this.db.prepare('SELECT id FROM member WHERE id = ? AND deleted = 0').get(request.founderId)
      if (!source || !founder) throw new Error('支系或开基祖不存在')
      return this.branchPreview(request)
    }
    const ids = [...new Set(request.memberIds)]
    if (!ids.length) throw new Error('请至少选择一位成员')
    for (const id of ids) if (!this.db.prepare('SELECT id FROM member WHERE id = ? AND deleted = 0').get(id)) throw new Error('待迁移成员不存在')
    return this.branchPreview({ ...request, memberIds: ids })
  }

  runBranchOperation(request: BranchOperation): BranchOperationResult {
    const preview = this.previewBranchOperation(request)
    return this.transaction(() => {
      const t = now()
      let operationId: string
      let branchId: string | undefined
      if (request.kind === 'merge') {
        const sourceIds = [...new Set(request.sourceIds)]
        const affected = [...new Set([request.targetId, ...sourceIds.flatMap((id) => this.branchSubtreeIds(id))])]
        const snapshot = this.branchSnapshot(affected)
        const target = snapshot.branches.find((b) => b.id === request.targetId)!
        const founderId = target.founder_id ?? snapshot.branches.find((b) => b.founder_id)?.founder_id ?? null
        const marks = affected.map(() => '?').join(',')
        this.db.prepare('UPDATE member SET branch_id = ?, updated_at = ? WHERE deleted = 0 AND branch_id IN (' + marks + ')').run(request.targetId, t, ...affected)
        this.db.prepare('UPDATE generation_char SET branch_id = ? WHERE branch_id IN (' + marks + ')').run(request.targetId, ...affected)
        this.db.prepare('UPDATE branch SET parent_id = ? WHERE parent_id IN (' + marks + ')').run(request.targetId, ...affected)
        this.db.prepare('UPDATE branch SET deleted = 1 WHERE id IN (' + sourceIds.map(() => '?').join(',') + ')').run(...sourceIds)
        this.db.prepare('UPDATE branch SET founder_id = ? WHERE id = ?').run(founderId, request.targetId)
        operationId = this.saveUndoAction('branch', snapshot)
        this.log('branch', request.targetId, 'merge', JSON.stringify({ sourceIds, operationId }))
      } else if (request.kind === 'split') {
        const affected = this.branchSubtreeIds(request.branchId)
        const descendants = this.descendantIds(request.founderId)
        const marks = affected.map(() => '?').join(',')
        const memberIds = (this.db.prepare(`SELECT id FROM member WHERE deleted = 0 AND branch_id IN (${marks})`).all(...affected) as { id: string }[])
          .map((m) => m.id).filter((id) => descendants.has(id))
        const snapshot = this.branchSnapshot(affected, memberIds)
        branchId = randomUUID()
        const source = snapshot.branches.find((b) => b.id === request.branchId)!
        this.db.prepare('INSERT INTO branch(id, name, parent_id, founder_id, note, created_at) VALUES(?,?,?,?,?,?)')
          .run(branchId, request.name.trim(), source.parent_id, request.founderId, `由「${source.name}」拆分`, t)
        snapshot.createdBranchIds.push(branchId)
        const insertChar = this.db.prepare('INSERT INTO generation_char(id, branch_id, generation, char, note) VALUES(?,?,?,?,?)')
        for (const c of snapshot.generationChars) {
          const id = randomUUID()
          insertChar.run(id, branchId, c.generation, c.char, c.note)
          snapshot.createdGenerationCharIds.push(id)
        }
        const move = this.db.prepare('UPDATE member SET branch_id = ?, updated_at = ? WHERE id = ?')
        for (const id of memberIds) move.run(branchId, t, id)
        operationId = this.saveUndoAction('branch', snapshot)
        this.log('branch', branchId, 'split', JSON.stringify({ from: request.branchId, founderId: request.founderId, operationId }))
      } else {
        const ids = [...new Set(request.memberIds)]
        const snapshot = this.branchSnapshot([], ids)
        const move = this.db.prepare('UPDATE member SET branch_id = ?, updated_at = ? WHERE id = ?')
        for (const id of ids) move.run(request.targetBranchId, t, id)
        operationId = this.saveUndoAction('branch', snapshot)
        this.log('branch', request.targetBranchId ?? '', 'migrate', JSON.stringify({ memberIds: ids, operationId }))
      }
      return { operationId, preview, branchId }
    })
  }

  // ---------- P1 duplicate detection & member merge ----------

  private memberSnapshot(ids: string[]): MemberMergeSnapshot {
    const marks = ids.map(() => '?').join(',')
    return {
      members: this.db.prepare(`SELECT * FROM member WHERE id IN (${marks})`).all(...ids) as unknown as UndoMemberSnapshot[],
      relations: this.db.prepare(`SELECT * FROM relation WHERE from_id IN (${marks}) OR to_id IN (${marks})`).all(...ids, ...ids) as unknown as UndoRelationSnapshot[],
      founders: (this.db.prepare(`SELECT id, founder_id FROM branch WHERE founder_id IN (${marks})`).all(...ids) as unknown as { id: string; founder_id: string | null }[])
        .map((b) => ({ id: b.id, founderId: b.founder_id })),
    }
  }

  findDuplicateMembers(): DuplicateMemberGroup[] {
    const members = (this.db.prepare('SELECT * FROM member WHERE deleted = 0 ORDER BY name, id').all() as unknown as MemberRow[]).map(rowToMember)
    const relations = this.db.prepare("SELECT * FROM relation WHERE deleted = 0").all() as unknown as RelationRow[]
    const parents = new Map<string, Set<string>>(), spouses = new Map<string, Set<string>>()
    for (const r of relations) {
      const map = r.type === 'parent_child' ? parents : spouses
      const add = (a: string, b: string): void => { if (!map.has(a)) map.set(a, new Set()); map.get(a)!.add(b) }
      add(r.from_id, r.to_id); add(r.to_id, r.from_id)
    }
    const intersects = (a: Set<string> | undefined, b: Set<string> | undefined): boolean => {
      if (!a || !b) return false
      for (const id of a) if (b.has(id)) return true
      return false
    }
    const buckets = new Map<string, Member[]>()
    for (const m of members) {
      const key = m.name.trim()
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key)!.push(m)
    }
    const parent = new Map<string, string>()
    const reasons = new Map<string, Set<string>>()
    const scores = new Map<string, number>()
    const find = (id: string): string => { let r = id; while (parent.get(r) !== r) r = parent.get(r)!; return r }
    for (const m of members) parent.set(m.id, m.id)
    for (const bucket of buckets.values()) {
      for (let i = 0; i < bucket.length; i++) for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i], b = bucket[j]
        const evidence: string[] = []
        if (a.birthDate && a.birthDate === b.birthDate) evidence.push('出生日期相同')
        if (intersects(parents.get(a.id), parents.get(b.id))) evidence.push('父母相同')
        if (intersects(spouses.get(a.id), spouses.get(b.id))) evidence.push('配偶相同')
        if (a.generation === b.generation) evidence.push('世代相同')
        const ra = find(a.id), rb = find(b.id)
        if (ra !== rb) parent.set(rb, ra)
        const key = [a.id, b.id].sort().join('|')
        reasons.set(key, new Set(['姓名相同', ...evidence]))
        scores.set(key, Math.min(99, 55 + evidence.length * 13))
      }
    }
    const grouped = new Map<string, string[]>()
    for (const m of members) { const root = find(m.id); if (!grouped.has(root)) grouped.set(root, []); grouped.get(root)!.push(m.id) }
    const groups: DuplicateMemberGroup[] = []
    for (const ids of grouped.values()) {
      if (ids.length < 2) continue
      const pairKeys = [...reasons.keys()].filter((key) => { const [a, b] = key.split('|'); return find(a) === find(ids[0]) })
      const detail = this.getMembersDetails(ids)
      groups.push({
        id: [...ids].sort().join('|'),
        score: Math.max(0, ...pairKeys.map((key) => scores.get(key) ?? 0)),
        reasons: [...new Set(pairKeys.flatMap((key) => [...reasons.get(key)!]))],
        members: detail,
      })
    }
    return groups.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 50)
  }

  mergeMembers(request: MemberMergeRequest): MemberMergeResult {
    const sourceIds = [...new Set(request.sourceIds)]
    if (!sourceIds.length || sourceIds.includes(request.targetId)) throw new Error('合并成员参数无效')
    const ids = [request.targetId, ...sourceIds]
    const snapshot = this.memberSnapshot(ids)
    const rows = new Map(snapshot.members.map((m) => [m.id, m]))
    const target = rows.get(request.targetId)
    if (!target || sourceIds.some((id) => !rows.has(id))) throw new Error('待合并成员不存在')
    for (const id of sourceIds) if (!this.db.prepare('SELECT id FROM member WHERE id = ? AND deleted = 0').get(id)) throw new Error('待合并成员已删除')
    return this.transaction(() => {
      const t = now()
      const merged: UndoMemberSnapshot = { ...target }
      const columns: Record<MergeField, keyof UndoMemberSnapshot> = {
        name: 'name', gender: 'gender', generation: 'generation', branchId: 'branch_id', birthDate: 'birth_date', birthLunar: 'birth_lunar',
        deathDate: 'death_date', deathLunar: 'death_lunar', alive: 'alive', birthOrder: 'birth_order', courtesyName: 'courtesy_name', title: 'title',
        occupation: 'occupation', residence: 'residence', burial: 'burial', biography: 'biography', remark: 'remark', photoPath: 'photo_path',
      }
      for (const [field, sourceId] of Object.entries(request.fieldSources ?? {})) {
        if (!sourceIds.includes(sourceId)) continue
        const source = rows.get(sourceId)!
        ;(merged as unknown as Record<string, unknown>)[columns[field as MergeField]] = source[columns[field as MergeField]]
      }
      if (request.mergeTextFields) {
        for (const field of ['biography', 'remark'] as const) {
          const col = columns[field]
          const parts = ids.map((id) => String(rows.get(id)![col] ?? '')).filter(Boolean)
          ;(merged as unknown as Record<string, unknown>)[col] = [...new Set(parts)].join('\n\n')
        }
      }
      if (!String(merged.name).trim()) throw new Error('姓名不能为空')
      this.db.prepare(
        `UPDATE member SET name=?, gender=?, generation=?, branch_id=?, birth_date=?, birth_lunar=?, death_date=?, death_lunar=?, alive=?,
         birth_order=?, courtesy_name=?, title=?, occupation=?, residence=?, burial=?, biography=?, remark=?, photo_path=?, updated_at=? WHERE id=?`,
      ).run(
        merged.name, merged.gender, merged.generation, merged.branch_id, merged.birth_date, merged.birth_lunar, merged.death_date, merged.death_lunar, merged.alive,
        merged.birth_order, merged.courtesy_name, merged.title, merged.occupation, merged.residence, merged.burial, merged.biography, merged.remark, merged.photo_path, t, request.targetId,
      )
      for (const id of sourceIds) {
        this.db.prepare(
          'UPDATE relation SET from_id = CASE WHEN from_id = ? THEN ? ELSE from_id END, to_id = CASE WHEN to_id = ? THEN ? ELSE to_id END, updated_at = ? WHERE deleted = 0 AND (from_id = ? OR to_id = ?)',
        ).run(id, request.targetId, id, request.targetId, t, id, id)
      }
      const operationId = randomUUID()
      this.db.prepare('UPDATE relation SET deleted = 1, delete_batch = ?, updated_at = ? WHERE deleted = 0 AND from_id = to_id').run(operationId, t)
      const active = this.db.prepare('SELECT * FROM relation WHERE deleted = 0 AND (from_id = ? OR to_id = ?) ORDER BY created_at, rowid')
        .all(request.targetId, request.targetId) as unknown as RelationRow[]
      const seen = new Set<string>()
      const markDuplicate = this.db.prepare('UPDATE relation SET deleted = 1, delete_batch = ?, updated_at = ? WHERE id = ?')
      for (const r of active) {
        const key = [r.type, r.subtype, [r.from_id, r.to_id].sort().join('|'), r.is_primary, r.note].join('|')
        if (seen.has(key)) markDuplicate.run(operationId, t, r.id)
        else seen.add(key)
      }
      const markMember = this.db.prepare('UPDATE member SET deleted = 1, delete_batch = ?, updated_at = ? WHERE id = ?')
      for (const id of sourceIds) markMember.run(operationId, t, id)
      this.db.prepare('UPDATE branch SET founder_id = ? WHERE founder_id IN (' + sourceIds.map(() => '?').join(',') + ')').run(request.targetId, ...sourceIds)
      const undoId = this.saveUndoAction('member-merge', snapshot)
      this.log('member', request.targetId, 'merge', JSON.stringify({ sourceIds, operationId: undoId }))
      const relationCount = (this.db.prepare('SELECT COUNT(*) AS c FROM relation WHERE deleted = 0 AND (from_id = ? OR to_id = ?)')
        .get(request.targetId, request.targetId) as { c: number }).c
      return { operationId: undoId, relationCount }
    })
  }

  undoOperation(id: string): boolean {
    const action = this.db.prepare('SELECT kind, payload, undone_at FROM undo_action WHERE id = ?').get(id) as
      { kind: 'branch' | 'member-merge'; payload: string; undone_at: number | null } | undefined
    if (!action || action.undone_at) return false
    const payload = JSON.parse(action.payload) as BranchSnapshot | MemberMergeSnapshot
    return this.transaction(() => {
      if (action.kind === 'branch') {
        this.restoreBranchSnapshot(payload as BranchSnapshot)
      } else {
        const snapshot = payload as MemberMergeSnapshot
        const restoreMember = this.db.prepare(
          `INSERT INTO member(id, name, gender, generation, branch_id, birth_date, birth_lunar, death_date, death_lunar, alive, birth_order,
           courtesy_name, title, occupation, residence, burial, biography, remark, photo_path, deleted, delete_batch, created_at, updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET name=excluded.name, gender=excluded.gender, generation=excluded.generation, branch_id=excluded.branch_id,
           birth_date=excluded.birth_date, birth_lunar=excluded.birth_lunar, death_date=excluded.death_date, death_lunar=excluded.death_lunar,
           alive=excluded.alive, birth_order=excluded.birth_order, courtesy_name=excluded.courtesy_name, title=excluded.title,
           occupation=excluded.occupation, residence=excluded.residence, burial=excluded.burial, biography=excluded.biography,
           remark=excluded.remark, photo_path=excluded.photo_path, deleted=excluded.deleted, delete_batch=excluded.delete_batch,
           created_at=excluded.created_at, updated_at=excluded.updated_at`,
        )
        for (const m of snapshot.members) restoreMember.run(
          m.id, m.name, m.gender, m.generation, m.branch_id, m.birth_date, m.birth_lunar, m.death_date, m.death_lunar, m.alive, m.birth_order,
          m.courtesy_name, m.title, m.occupation, m.residence, m.burial, m.biography, m.remark, m.photo_path, m.deleted, m.delete_batch, m.created_at, m.updated_at,
        )
        const restoreRelation = this.db.prepare(
          `INSERT INTO relation(id, type, subtype, from_id, to_id, is_primary, note, deleted, delete_batch, created_at, updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET type=excluded.type, subtype=excluded.subtype,
           from_id=excluded.from_id, to_id=excluded.to_id, is_primary=excluded.is_primary, note=excluded.note,
           deleted=excluded.deleted, delete_batch=excluded.delete_batch, created_at=excluded.created_at, updated_at=excluded.updated_at`,
        )
        for (const r of snapshot.relations) restoreRelation.run(
          r.id, r.type, r.subtype, r.from_id, r.to_id, r.is_primary, r.note, r.deleted, r.delete_batch, r.created_at, r.updated_at,
        )
        for (const f of snapshot.founders) this.db.prepare('UPDATE branch SET founder_id = ? WHERE id = ?').run(f.founderId, f.id)
      }
      this.db.prepare('UPDATE undo_action SET undone_at = ? WHERE id = ?').run(now(), id)
      this.log('undo', id, 'restore', action.kind)
      return true
    })
  }

  // ---------- zibei ----------

  listZibei(): ZibeiPoem[] {
    const branches = this.listBranches()
    const rows = this.db.prepare('SELECT * FROM generation_char ORDER BY generation').all() as {
      id: string; branch_id: string | null; generation: number; char: string; note: string
    }[]
    const groups = new Map<string | null, ZibeiEntry[]>()
    for (const r of rows) {
      if (!groups.has(r.branch_id)) groups.set(r.branch_id, [])
      groups.get(r.branch_id)!.push({ id: r.id, branchId: r.branch_id, generation: r.generation, char: r.char, note: r.note })
    }
    const out: ZibeiPoem[] = []
    const push = (branchId: string | null, branchName: string): void => {
      const entries = groups.get(branchId) ?? []
      out.push({ branchId, branchName, poem: entries.map((e) => e.char).join(''), entries })
    }
    push(null, '全谱通用')
    for (const b of branches) if (groups.has(b.id)) push(b.id, b.name)
    return out
  }

  setPoem(branchId: string | null, poem: string, startGeneration = 1): void {
    const chars = [...poem.replace(/[\s，。、；！？,.;!?"'“”‘’（）()《》<>【\]—\-·]/g, '')]
    this.db.prepare(branchId === null ? 'DELETE FROM generation_char WHERE branch_id IS NULL' : 'DELETE FROM generation_char WHERE branch_id = ?')
      .run(...(branchId === null ? [] : [branchId]))
    const stmt = this.db.prepare('INSERT INTO generation_char(id, branch_id, generation, char, note) VALUES(?,?,?,?,?)')
    chars.forEach((c, i) => stmt.run(randomUUID(), branchId, startGeneration + i, c, ''))
    this.log('zibei', branchId ?? 'global', 'set', JSON.stringify({ poem }))
  }

  recommendedChar(generation: number, branchId: string | null): string | null {
    let cur = branchId
    const stmt = this.db.prepare('SELECT char FROM generation_char WHERE generation = ? AND branch_id = ?')
    const globalStmt = this.db.prepare('SELECT char FROM generation_char WHERE generation = ? AND branch_id IS NULL')
    while (cur) {
      const r = stmt.get(generation, cur) as { char: string } | undefined
      if (r) return r.char
      const b = this.db.prepare('SELECT parent_id FROM branch WHERE id = ?').get(cur) as { parent_id: string | null } | undefined
      cur = b?.parent_id ?? null
    }
    const g = globalStmt.get(generation) as { char: string } | undefined
    return g ? g.char : null
  }

  // ---------- excel import ----------

  importMembers(input: ExcelImportCommit): { createdBranchCount: number } {
    const t = now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(
        `INSERT INTO import_batch(id, source_name, source_hash, status, total_rows, success_count, skipped_count,
          failed_count, options_json, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        input.batchId, input.sourceName, input.sourceHash, 'done', input.totalRows, input.rows.length,
        input.skippedCount, input.failedCount, '{}', t,
      )
      const branchMap = new Map<string, string>()
      for (const b of this.db.prepare('SELECT id, name FROM branch WHERE deleted = 0').all() as { id: string; name: string }[]) {
        if (!branchMap.has(b.name)) branchMap.set(b.name, b.id)
      }
      const createdBranchIds: string[] = []
      const insertBranch = this.db.prepare('INSERT INTO branch(id, name, parent_id, founder_id, note, created_at) VALUES(?,?,NULL,NULL,?,?)')
      for (const name of input.missingBranches) {
        const clean = name.trim()
        if (!clean || branchMap.has(clean)) continue
        const id = randomUUID()
        insertBranch.run(id, clean, 'Excel 导入自动创建', t)
        branchMap.set(clean, id)
        createdBranchIds.push(id)
        this.log('branch', id, 'create', JSON.stringify({ name: clean, source: 'excel-import', batch: input.batchId }))
      }
      this.db.prepare('UPDATE import_batch SET options_json = ? WHERE id = ?')
        .run(JSON.stringify({ createdBranchIds }), input.batchId)

      const insertMember = this.db.prepare(
        `INSERT INTO member(id, name, gender, generation, branch_id, birth_date, birth_lunar, death_date, death_lunar,
          alive, birth_order, courtesy_name, title, occupation, residence, burial, biography, remark, photo_path,
          deleted, delete_batch, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`,
      )
      const logChange = this.db.prepare('INSERT INTO change_log(entity, entity_id, op, payload, created_at) VALUES(?,?,?,?,?)')
      for (const row of input.rows) {
        const m = row.member
        const id = randomUUID()
        const branchId = m.branchId ?? (row.branchName ? (branchMap.get(row.branchName.trim()) ?? null) : null)
        insertMember.run(
          id, m.name.trim(), m.gender, m.generation ?? 1, branchId,
          m.birthDate ?? '', m.birthLunar ? 1 : 0, m.deathDate ?? '', m.deathLunar ? 1 : 0,
          m.alive === false ? 0 : 1, m.birthOrder ?? 1, m.courtesyName ?? '', m.title ?? '',
          m.occupation ?? '', m.residence ?? '', m.burial ?? '', m.biography ?? '', m.remark ?? '', m.photoPath ?? '',
          input.batchId, t, t,
        )
        logChange.run('member', id, 'create', JSON.stringify({ name: m.name, source: 'excel-import', batch: input.batchId, row: row.sourceRow }), t)
      }
      const insertIssue = this.db.prepare(
        'INSERT INTO import_issue(batch_id, row_number, field, value, level, message) VALUES(?,?,?,?,?,?)',
      )
      for (const issue of input.issues) {
        insertIssue.run(input.batchId, issue.rowNumber, issue.field, issue.value, issue.level, issue.message)
      }
      this.db.exec('COMMIT')
      return { createdBranchCount: createdBranchIds.length }
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  importGedcom(input: GedcomImportCommit): { relationCount: number } {
    const t = now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(
        `INSERT INTO import_batch(id, source_name, source_hash, status, total_rows, success_count, skipped_count,
          failed_count, options_json, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        input.batchId, input.sourceName, input.sourceHash, 'done', input.totalRows, input.members.length,
        input.skippedCount, input.failedCount, JSON.stringify(input.options ?? {}), t,
      )
      const insertMember = this.db.prepare(
        `INSERT INTO member(id, name, gender, generation, branch_id, birth_date, birth_lunar, death_date, death_lunar,
          alive, birth_order, courtesy_name, title, occupation, residence, burial, biography, remark, photo_path,
          deleted, delete_batch, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`,
      )
      const insertRelation = this.db.prepare(
        `INSERT INTO relation(id, type, subtype, from_id, to_id, is_primary, note, deleted, delete_batch, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,0,?,?,?)`,
      )
      const logChange = this.db.prepare('INSERT INTO change_log(entity, entity_id, op, payload, created_at) VALUES(?,?,?,?,?)')
      const idMap = new Map<string, string>()
      for (const row of input.members) {
        const id = randomUUID()
        idMap.set(row.sourceId, id)
        const m = row.member
        insertMember.run(
          id, m.name.trim(), m.gender, m.generation ?? 1, m.branchId ?? null,
          m.birthDate ?? '', m.birthLunar ? 1 : 0, m.deathDate ?? '', m.deathLunar ? 1 : 0,
          m.alive === false ? 0 : 1, m.birthOrder ?? 1, m.courtesyName ?? '', m.title ?? '',
          m.occupation ?? '', m.residence ?? '', m.burial ?? '', m.biography ?? '', m.remark ?? '', m.photoPath ?? '',
          input.batchId, t, t,
        )
        logChange.run('member', id, 'create', JSON.stringify({ name: m.name, source: 'gedcom-import', batch: input.batchId, sourceId: row.sourceId }), t)
      }
      const relationKeys = new Set<string>()
      let relationCount = 0
      for (const rel of input.relations) {
        const from = idMap.get(rel.fromSourceId), to = idMap.get(rel.toSourceId)
        if (!from || !to || from === to) continue
        const key = `${rel.type}|${from}|${to}|${rel.subtype}|${rel.isPrimary ? 1 : 0}`
        if (relationKeys.has(key)) continue
        relationKeys.add(key)
        const id = randomUUID()
        insertRelation.run(id, rel.type, rel.subtype, from, to, rel.isPrimary ? 1 : 0, rel.note, input.batchId, t, t)
        logChange.run('relation', id, 'create', JSON.stringify({ type: rel.type, from, to, source: 'gedcom-import', batch: input.batchId }), t)
        relationCount++
      }
      const insertIssue = this.db.prepare(
        'INSERT INTO import_issue(batch_id, row_number, field, value, level, message) VALUES(?,?,?,?,?,?)',
      )
      for (const issue of input.issues) insertIssue.run(input.batchId, issue.rowNumber, issue.field, issue.value, issue.level, issue.message)
      this.db.exec('COMMIT')
      return { relationCount }
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  importBatchOptions(batchId: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT options_json FROM import_batch WHERE id = ?').get(batchId) as { options_json: string } | undefined
    if (!row) return {}
    try { return JSON.parse(row.options_json) as Record<string, unknown> } catch { return {} }
  }

  listImportBatches(): ExcelBatch[] {
    const rows = this.db.prepare('SELECT * FROM import_batch ORDER BY created_at DESC LIMIT 50').all() as {
      id: string; source_name: string; source_hash: string; status: 'done' | 'undone'
      total_rows: number; success_count: number; skipped_count: number; failed_count: number
      options_json: string; created_at: number; undone_at: number | null
    }[]
    return rows.map((r) => {
      let createdBranchCount = 0
      try { createdBranchCount = (JSON.parse(r.options_json) as { createdBranchIds?: string[] }).createdBranchIds?.length ?? 0 } catch { /* ignore */ }
      return {
        id: r.id, sourceName: r.source_name, sourceHash: r.source_hash, status: r.status,
        totalRows: r.total_rows, successCount: r.success_count, skippedCount: r.skipped_count,
        failedCount: r.failed_count, createdBranchCount, createdAt: r.created_at, undoneAt: r.undone_at,
      }
    })
  }

  importIssues(batchId: string): ExcelIssue[] {
    return (this.db.prepare(
      'SELECT row_number, field, value, level, message FROM import_issue WHERE batch_id = ? ORDER BY id',
    ).all(batchId) as { row_number: number; field: string; value: string; level: 'error' | 'warning'; message: string }[])
      .map((r) => ({ rowNumber: r.row_number, field: r.field, value: r.value, level: r.level, message: r.message }))
  }

  undoImport(batchId: string): { ok: boolean; count: number; message?: string } {
    const batch = this.db.prepare('SELECT status, options_json FROM import_batch WHERE id = ?').get(batchId) as
      { status: string; options_json: string } | undefined
    if (!batch) return { ok: false, count: 0, message: '导入批次不存在' }
    if (batch.status !== 'done') return { ok: false, count: 0, message: '该批次已撤销' }
    const t = now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const members = this.db.prepare('SELECT id FROM member WHERE delete_batch = ? AND deleted = 0').all(batchId) as { id: string }[]
      const undoBatch = 'undo-' + batchId
      const markMember = this.db.prepare('UPDATE member SET deleted = 1, delete_batch = ?, updated_at = ? WHERE id = ? AND deleted = 0')
      const markRelations = this.db.prepare(
        'UPDATE relation SET deleted = 1, delete_batch = ?, updated_at = ? WHERE deleted = 0 AND (from_id = ? OR to_id = ?)',
      )
      const clearFounder = this.db.prepare('UPDATE branch SET founder_id = NULL WHERE founder_id = ?')
      for (const m of members) {
        markMember.run(undoBatch, t, m.id)
        markRelations.run(undoBatch, t, m.id, m.id)
        clearFounder.run(m.id)
      }
      let createdBranchIds: string[] = []
      try { createdBranchIds = (JSON.parse(batch.options_json) as { createdBranchIds?: string[] }).createdBranchIds ?? [] } catch { /* ignore */ }
      for (const id of createdBranchIds) {
        const used = this.db.prepare('SELECT COUNT(*) AS c FROM member WHERE branch_id = ? AND deleted = 0').get(id) as { c: number }
        const child = this.db.prepare('SELECT COUNT(*) AS c FROM branch WHERE parent_id = ? AND deleted = 0').get(id) as { c: number }
        if (used.c || child.c) continue
        this.db.prepare('UPDATE branch SET deleted = 1 WHERE id = ?').run(id)
        this.db.prepare('UPDATE generation_char SET branch_id = NULL WHERE branch_id = ?').run(id)
      }
      this.db.prepare("UPDATE import_batch SET status = 'undone', undone_at = ? WHERE id = ?").run(t, batchId)
      this.log('import', batchId, 'undo', JSON.stringify({ count: members.length }))
      this.db.exec('COMMIT')
      return { ok: true, count: members.length }
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  // ---------- misc ----------

  generations(): number[] {
    return (this.db.prepare('SELECT DISTINCT generation FROM member WHERE deleted = 0 ORDER BY generation').all() as { generation: number }[])
      .map((r) => r.generation)
  }

  changeCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM change_log').get() as { c: number }).c
  }
}