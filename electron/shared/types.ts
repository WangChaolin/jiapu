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
  remark: string
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
  otherGender: Member['gender']
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
  remark?: string
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

export type BranchOperation =
  | { kind: 'merge'; sourceIds: string[]; targetId: string }
  | { kind: 'split'; branchId: string; founderId: string; name: string }
  | { kind: 'migrate'; memberIds: string[]; targetBranchId: string | null }

export interface BranchOperationPreview {
  memberCount: number
  childBranchCount: number
  relationCount: number
  founderNames: string[]
  sourceNames: string[]
  targetName: string
}

export interface BranchOperationResult {
  operationId: string
  preview: BranchOperationPreview
  branchId?: string
}

export interface DuplicateMemberGroup {
  id: string
  score: number
  reasons: string[]
  members: MemberDetail[]
}

export type MergeField =
  | 'name' | 'gender' | 'generation' | 'branchId' | 'birthDate' | 'birthLunar'
  | 'deathDate' | 'deathLunar' | 'alive' | 'birthOrder' | 'courtesyName' | 'title'
  | 'occupation' | 'residence' | 'burial' | 'biography' | 'remark' | 'photoPath'

export interface MemberMergeRequest {
  targetId: string
  sourceIds: string[]
  fieldSources?: Partial<Record<MergeField, string>>
  mergeTextFields?: boolean
}

export interface MemberMergeResult {
  operationId: string
  relationCount: number
}

export type GraphOrientation = 'vertical' | 'horizontal'

export interface GraphPngOptions {
  orientation: GraphOrientation
  scope: 'viewport' | 'visible'
  scale: 1 | 2 | 4
  background: 'white' | 'rice' | 'transparent'
  legend: boolean
  title: boolean
  timestamp: boolean
  visibleIds: string[]
  viewBox: { x: number; y: number; width: number; height: number }
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

export type ExcelFieldKey =
  | 'name' | 'gender' | 'courtesyName' | 'hao' | 'generation' | 'birthOrder' | 'branchName'
  | 'birthDate' | 'birthCalendar' | 'deathDate' | 'deathCalendar' | 'alive'
  | 'occupation' | 'residence' | 'burial' | 'biography' | 'remark'

export interface ExcelFieldDef {
  key: ExcelFieldKey
  label: string
  required: boolean
  aliases: string[]
  width: number
}

export const EXCEL_FIELDS: ExcelFieldDef[] = [
  { key: 'name', label: '姓名', required: true, aliases: ['名字', '成员姓名'], width: 16 },
  { key: 'gender', label: '性别', required: false, aliases: [], width: 10 },
  { key: 'courtesyName', label: '字', required: false, aliases: ['表字'], width: 14 },
  { key: 'hao', label: '号', required: false, aliases: ['别号'], width: 14 },
  { key: 'generation', label: '世代', required: false, aliases: ['第几世'], width: 10 },
  { key: 'birthOrder', label: '行第', required: false, aliases: ['排行', '兄弟排行'], width: 10 },
  { key: 'branchName', label: '支系', required: false, aliases: ['房支', '所属支系'], width: 18 },
  { key: 'birthDate', label: '出生日期', required: false, aliases: ['生日', '生于'], width: 18 },
  { key: 'birthCalendar', label: '出生历法', required: false, aliases: ['出生日期历法'], width: 12 },
  { key: 'deathDate', label: '卒日期', required: false, aliases: ['去世日期', '卒于'], width: 18 },
  { key: 'deathCalendar', label: '卒历法', required: false, aliases: ['卒日期历法'], width: 12 },
  { key: 'alive', label: '在世状态', required: false, aliases: ['状态'], width: 12 },
  { key: 'occupation', label: '职业', required: false, aliases: [], width: 18 },
  { key: 'residence', label: '居地', required: false, aliases: ['居住地'], width: 22 },
  { key: 'burial', label: '葬地', required: false, aliases: ['墓地'], width: 22 },
  { key: 'biography', label: '生平', required: false, aliases: ['生平简介', '事迹'], width: 40 },
  { key: 'remark', label: '备注', required: false, aliases: ['注释'], width: 30 },
]

export type ExcelMapping = Partial<Record<ExcelFieldKey, string>>
export type ExcelDuplicateMode = 'skip' | 'import' | 'ask'
export type ExcelBranchMode = 'keep-empty' | 'create' | 'error'

export interface ExcelAnalyzeOptions {
  mapping: ExcelMapping
  duplicateMode: ExcelDuplicateMode
  branchMode: ExcelBranchMode
  defaultGeneration: number
  duplicateDecisions?: Record<number, 'skip' | 'import'>
}

export interface ExcelIssue {
  rowNumber: number
  field: string
  value: string
  level: 'error' | 'warning'
  message: string
}

export interface ExcelPreviewRow {
  rowNumber: number
  name: string
  gender: string
  generation: number | null
  branchName: string
  birthDate: string
  birthLunar: boolean
  duplicate: boolean
  errorCount: number
  warningCount: number
}

export interface ExcelPreview {
  analysisId: string
  fileName: string
  fileHash: string
  totalRows: number
  validRows: number
  errorRows: number
  duplicateRows: number
  blankGenerationRows: number
  missingBranches: string[]
  headers: string[]
  suggestedMapping: ExcelMapping
  defaultGeneration: number
  sample: ExcelPreviewRow[]
  issues: ExcelIssue[]
}

export interface ExcelCommitResult {
  ok: boolean
  batchId: string | null
  successCount: number
  skippedCount: number
  failedCount: number
  message?: string
}

export interface ExcelBatch {
  id: string
  sourceName: string
  sourceHash: string
  status: 'done' | 'undone'
  totalRows: number
  successCount: number
  skippedCount: number
  failedCount: number
  createdBranchCount: number
  createdAt: number
  undoneAt: number | null
}

export type GedcomBatch = ExcelBatch

export type GedcomDuplicateMode = 'skip' | 'import' | 'ask'
export type GedcomUnsupportedAction = 'note' | 'skip'
export type GedcomPlaceTarget = 'remark' | 'residence' | 'ignore'
export type GedcomPhotoMode = 'copy' | 'path' | 'ignore'

export interface GedcomAnalyzeOptions {
  duplicateMode: GedcomDuplicateMode
  defaultGeneration: number
  autoDeriveGeneration: boolean
  placeTarget: GedcomPlaceTarget
  photoMode: GedcomPhotoMode
  preserveUnsupported: boolean
  unsupportedActions: Record<string, GedcomUnsupportedAction>
  duplicateDecisions?: Record<string, 'skip' | 'import'>
}

export interface GedcomIssue {
  rowNumber: number
  field: string
  value: string
  level: 'error' | 'warning'
  message: string
}

export interface GedcomDuplicateGroup {
  id: string
  name: string
  gender: string
  birthDate: string
  existingNames: string[]
}

export interface GedcomUnsupportedTag {
  tag: string
  count: number
  firstLine: number
  action: GedcomUnsupportedAction
}

export interface GedcomPreviewMember {
  id: string
  name: string
  gender: string
  generation: number | null
  birthDate: string
  duplicate: boolean
  errorCount: number
  warningCount: number
}

export interface GedcomPreview {
  analysisId: string
  fileName: string
  fileHash: string
  version: string
  encoding: string
  individualCount: number
  familyCount: number
  eventCount: number
  photoCount: number
  validCount: number
  skippedCount: number
  duplicateCount: number
  defaultGeneration: number
  duplicates: GedcomDuplicateGroup[]
  unsupportedTags: GedcomUnsupportedTag[]
  compatibility: string[]
  sample: GedcomPreviewMember[]
  issues: GedcomIssue[]
}

export interface GedcomCommitResult {
  ok: boolean
  batchId: string | null
  successCount: number
  skippedCount: number
  failedCount: number
  relationCount: number
  photoCount: number
  message?: string
}

export type GedcomExportScope = 'all' | 'branch' | 'generation' | 'selected'
export type GedcomExportEncoding = 'utf-8' | 'gbk'

export interface GedcomExportOptions {
  scope: GedcomExportScope
  branchId?: string | null
  generation?: number | null
  memberIds?: string[]
  version: '5.5.1' | '5.5'
  encoding: GedcomExportEncoding
  includePhotos: boolean
  includeNotes: boolean
  includeCompatibility: boolean
}

export interface GedcomExportPreview {
  memberCount: number
  familyCount: number
  photoCount: number
  content: string
  warnings: string[]
}

export interface GedcomExportSaveResult {
  filePath: string
  photoCount: number
  warnings: string[]
}
