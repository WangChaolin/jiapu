import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type {
  Branch, GenealogyStats, GraphData, Member, MemberDetail, MemberFilter,
  MemberInput, RelationLink, ZibeiEntry, ZibeiPoem,
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
`

interface MemberRow {
  id: string; name: string; gender: string; generation: number; branch_id: string | null
  birth_date: string; birth_lunar: number; death_date: string; death_lunar: number
  alive: number; birth_order: number; courtesy_name: string; title: string
  occupation: string; residence: string; burial: string; biography: string
  photo_path: string; deleted: number; created_at: number; updated_at: number
}

interface RelationRow {
  id: string; type: string; subtype: string; from_id: string; to_id: string
  is_primary: number; note: string
}

function rowToMember(r: MemberRow): Member {
  return {
    id: r.id, name: r.name, gender: r.gender as Member['gender'],
    generation: r.generation, branchId: r.branch_id,
    birthDate: r.birth_date, birthLunar: r.birth_lunar === 1,
    deathDate: r.death_date, deathLunar: r.death_lunar === 1,
    alive: r.alive === 1, birthOrder: r.birth_order,
    courtesyName: r.courtesy_name, title: r.title, occupation: r.occupation,
    residence: r.residence, burial: r.burial, biography: r.biography,
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
    const nameOf = this.db.prepare('SELECT name FROM member WHERE id = ?')
    const toLink = (rel: RelationRow, otherId: string): RelationLink => ({
      id: rel.id, type: rel.type as RelationLink['type'], subtype: rel.subtype,
      otherId, otherName: (nameOf.get(otherId) as { name: string } | undefined)?.name ?? '（已删除）',
      isPrimary: rel.is_primary === 1, note: rel.note,
    })
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
    const nameMap = new Map<string, string>()
    if (involved.size) {
      const nph = [...involved].map(() => '?').join(',')
      const nr = this.db.prepare(`SELECT id, name FROM member WHERE id IN (${nph})`).all(...involved) as { id: string; name: string }[]
      for (const n of nr) nameMap.set(n.id, n.name)
    }
    const link = (rel: RelationRow, otherId: string): RelationLink => ({
      id: rel.id, type: rel.type as RelationLink['type'], subtype: rel.subtype,
      otherId, otherName: nameMap.get(otherId) ?? '（已删除）', isPrimary: rel.is_primary === 1, note: rel.note,
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
        alive, birth_order, courtesy_name, title, occupation, residence, burial, biography, photo_path, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id, input.name.trim(), input.gender, generation, input.branchId ?? null,
      input.birthDate ?? '', input.birthLunar ? 1 : 0, input.deathDate ?? '', input.deathLunar ? 1 : 0,
      input.alive === false ? 0 : 1, input.birthOrder ?? 1, input.courtesyName ?? '', input.title ?? '',
      input.occupation ?? '', input.residence ?? '', input.burial ?? '', input.biography ?? '',
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
        biography=?, photo_path=?, updated_at=? WHERE id=?`,
    ).run(
      input.name.trim(), input.gender, generation, input.branchId ?? null,
      input.birthDate ?? '', input.birthLunar ? 1 : 0, input.deathDate ?? '', input.deathLunar ? 1 : 0,
      input.alive === false ? 0 : 1, input.birthOrder ?? 1, input.courtesyName ?? '', input.title ?? '',
      input.occupation ?? '', input.residence ?? '', input.burial ?? '', input.biography ?? '',
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

  // ---------- misc ----------

  generations(): number[] {
    return (this.db.prepare('SELECT DISTINCT generation FROM member WHERE deleted = 0 ORDER BY generation').all() as { generation: number }[])
      .map((r) => r.generation)
  }

  changeCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM change_log').get() as { c: number }).c
  }
}