export const PARENT_SUBTYPES = [
  '生父', '生母', '养父', '养母', '继父', '继母',
  '嗣父（过继）', '嗣母（过继）', '兼祧父', '兼祧母',
] as const
export type ParentSubtype = (typeof PARENT_SUBTYPES)[number]

export const SPOUSE_SUBTYPES = ['原配', '继配'] as const
export type SpouseSubtype = (typeof SPOUSE_SUBTYPES)[number]

export const SKINS = ['system', 'light', 'dark', 'classic'] as const
export type Skin = (typeof SKINS)[number]

export interface GenealogyMeta {
  id: string
  name: string
  hall: string
  surname: string
  origin: string
  compiler: string
  note: string
  createdAt: number
  updatedAt: number
  memberCount: number
  lastOpenedAt: number
}

export interface Member {
  id: string
  name: string
  gender: '男' | '女' | '其他'
  generation: number
  branchId: string | null
  birthDate: string
  birthLunar: boolean
  deathDate: string
  deathLunar: boolean
  alive: boolean
  birthOrder: number
  courtesyName: string
  title: string
  occupation: string
  residence: string
  burial: string
  biography: string
  photoPath: string
  createdAt: number
  updatedAt: number
}

export interface RelationLink {
  id: string
  type: 'parent_child' | 'spouse'
  subtype: string
  otherId: string
  otherName: string
  isPrimary: boolean
  note: string
}

export interface MemberDetail extends Member {
  parents: RelationLink[]
  spouses: RelationLink[]
  children: RelationLink[]
}

export interface MemberInput {
  name: string
  gender: Member['gender']
  generation?: number | null
  branchId?: string | null
  birthDate?: string
  birthLunar?: boolean
  deathDate?: string
  deathLunar?: boolean
  alive?: boolean
  birthOrder?: number
  courtesyName?: string
  title?: string
  occupation?: string
  residence?: string
  burial?: string
  biography?: string
  photoPath?: string
  parents?: { otherId: string; subtype: ParentSubtype; isPrimary?: boolean; note?: string }[]
  spouses?: { otherId: string; subtype: SpouseSubtype; note?: string }[]
}

export interface MemberFilter {
  keyword?: string
  generation?: number | null
  branchId?: string | null
  gender?: string | null
  aliveOnly?: boolean
  limit?: number
  offset?: number
}

export interface ZibeiEntry {
  id: string
  branchId: string | null
  generation: number
  char: string
  note: string
}

export interface ZibeiPoem {
  branchId: string | null
  branchName: string
  poem: string
  entries: ZibeiEntry[]
}

export interface Branch {
  id: string
  name: string
  parentId: string | null
  founderId: string | null
  founderName: string
  note: string
  memberCount: number
  createdAt: number
}

export interface BackupEntry {
  file: string
  genealogyId: string
  genealogyName: string
  createdAt: number
  size: number
  memberCount: number
  kind: 'manual' | 'auto'
  note: string
}

export interface AppSettings {
  dataDir: string
  skin: Skin
  autoBackup: boolean
  autoBackupKeep: number
  lunarDefault: boolean
}

export interface GenealogyStats {
  memberCount: number
  maleCount: number
  femaleCount: number
  aliveCount: number
  generations: number
  branchCount: number
  earliestYear: number | null
  latestYear: number | null
}

export interface GraphData {
  members: Member[]
  edges: {
    id: string
    type: 'parent_child' | 'spouse'
    subtype: string
    from: string
    to: string
    isPrimary: boolean
  }[]
}

export interface ChangeResult {
  ok: boolean
  message?: string
}

export interface DirCheck {
  ok: boolean
  message?: string
  migrated?: number
}

export interface RestoreResult {
  ok: boolean
  message?: string
  genealogyId: string
  genealogyName: string
}

export interface LunarInfo {
  solar: string
  lunar: string
  yearGanZhi: string
  animal: string
}