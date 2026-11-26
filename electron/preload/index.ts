import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings, BackupEntry, Branch, BranchOperation, BranchOperationPreview, BranchOperationResult, DirCheck,
  DuplicateMemberGroup, GenealogyMeta, GenealogyStats, GraphData, GraphPngOptions, Member, MemberDetail, MemberFilter, MemberInput,
  MemberMergeRequest, MemberMergeResult, RestoreResult, ZibeiPoem,
  ExcelAnalyzeOptions, ExcelBatch, ExcelCommitResult, ExcelIssue, ExcelPreview,
  GedcomAnalyzeOptions, GedcomBatch, GedcomCommitResult, GedcomExportOptions, GedcomExportPreview,
  GedcomExportSaveResult, GedcomIssue, GedcomPreview,
} from '../shared/types'
import type { PrintOptions } from '../../src/print/build'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>

const api = {
  appInfo: () => invoke<{ version: string; dataDir: string; configPath: string; platform: string }>('app:info'),

  settings: {
    get: () => invoke<AppSettings>('settings:get'),
    update: (patch: Partial<Omit<AppSettings, 'dataDir'>>) => invoke<AppSettings>('settings:update', patch),
    checkDataDir: (dir: string) => invoke<{ ok: boolean; message?: string }>('settings:checkDataDir', dir),
    setDataDir: (dir: string) => invoke<DirCheck>('settings:setDataDir', dir),
    chooseDir: () => invoke<string | null>('settings:chooseDir'),
    revealDataDir: () => invoke<string>('settings:revealDataDir'),
  },

  genealogy: {
    list: () => invoke<GenealogyMeta[]>('genealogy:list'),
    create: (input: { name: string; hall?: string; surname?: string; origin?: string; compiler?: string; note?: string }) =>
      invoke<GenealogyMeta>('genealogy:create', input),
    seedDemo: () => invoke<GenealogyMeta>('genealogy:seedDemo'),
    open: (id: string) => invoke<GenealogyMeta>('genealogy:open', id),
    close: () => invoke<boolean>('genealogy:close'),
    current: () => invoke<GenealogyMeta | null>('genealogy:current'),
    updateMeta: (id: string, patch: Partial<GenealogyMeta>) => invoke<GenealogyMeta | null>('genealogy:updateMeta', id, patch),
    delete: (id: string) => invoke<{ name: string; trashName: string | null }>('genealogy:delete', id),
    undoDelete: () => invoke<GenealogyMeta | null>('genealogy:undoDelete'),
    duplicate: (id: string, newName: string) => invoke<GenealogyMeta>('genealogy:duplicate', id, newName),
    stats: () => invoke<GenealogyStats>('genealogy:stats'),
  },

  member: {
    list: (filter: MemberFilter) => invoke<{ total: number; rows: Member[] }>('member:list', filter),
    get: (id: string) => invoke<MemberDetail | null>('member:get', id),
    getMany: (ids: string[]) => invoke<MemberDetail[]>('member:getMany', ids),
    create: (input: MemberInput) => invoke<MemberDetail>('member:create', input),
    update: (id: string, input: MemberInput) => invoke<MemberDetail>('member:update', id, input),
    delete: (id: string) => invoke<{ name: string }>('member:delete', id),
    restore: (id: string) => invoke<boolean>('member:restore', id),
    generations: () => invoke<number[]>('member:generations'),
    recommendedChar: (generation: number, branchId: string | null) => invoke<string | null>('member:recommendedChar', generation, branchId),
    duplicates: () => invoke<DuplicateMemberGroup[]>('member:duplicates'),
    merge: (request: MemberMergeRequest) => invoke<MemberMergeResult>('member:merge', request),
    choosePhoto: () => invoke<string | null>('member:choosePhoto'),
    savePhoto: (sourcePath: string) => invoke<string>('member:savePhoto', sourcePath),
  },

  graph: {
    data: () => invoke<GraphData>('graph:data'),
    savePng: (payload: { data: GraphData; meta: GenealogyMeta; opts: GraphPngOptions }, defaultName: string) =>
      invoke<string | null>('graph:savePng', payload, defaultName),
  },

  zibei: {
    list: () => invoke<ZibeiPoem[]>('zibei:list'),
    setPoem: (branchId: string | null, poem: string, startGen: number) => invoke<ZibeiPoem[]>('zibei:setPoem', branchId, poem, startGen),
  },

  branch: {
    list: () => invoke<Branch[]>('branch:list'),
    create: (name: string, parentId: string | null, founderId: string | null, note: string) =>
      invoke<Branch>('branch:create', name, parentId, founderId, note),
    update: (id: string, name: string, parentId: string | null, founderId: string | null, note: string) =>
      invoke<Branch[]>('branch:update', id, name, parentId, founderId, note),
    delete: (id: string) => invoke<Branch[]>('branch:delete', id),
    preview: (request: BranchOperation) => invoke<BranchOperationPreview>('branch:preview', request),
    operate: (request: BranchOperation) => invoke<BranchOperationResult & { branches: Branch[] }>('branch:operate', request),
  },

  operation: { undo: (id: string) => invoke<boolean>('operation:undo', id) },

  backup: {
    list: () => invoke<BackupEntry[]>('backup:list'),
    create: (note: string) => invoke<BackupEntry>('backup:create', note),
    verify: (file: string) => invoke<{ ok: boolean; message?: string }>('backup:verify', file),
    delete: (file: string) => invoke<BackupEntry[]>('backup:delete', file),
    chooseZip: () => invoke<string | null>('backup:chooseZip'),
    restore: (file: string, asNewName: string | null) => invoke<RestoreResult>('backup:restore', file, asNewName),
    exportJson: () => invoke<string | null>('backup:exportJson'),
    chooseJson: () => invoke<string | null>('backup:chooseJson'),
    importJson: (file: string, newName: string) => invoke<{ ok: boolean; count?: number; message?: string; meta?: GenealogyMeta | null }>('backup:importJson', file, newName),
  },

  excel: {
    template: () => invoke<string | null>('excel:template'),
    choose: () => invoke<string | null>('excel:choose'),
    analyze: (file: string, options: ExcelAnalyzeOptions) => invoke<{ preview: ExcelPreview }>('excel:analyze', file, options),
    commit: (file: string, options: ExcelAnalyzeOptions, expectedHash: string) =>
      invoke<ExcelCommitResult>('excel:commit', file, options, expectedHash),
    saveReport: (report: ExcelPreview | { batchId: string }) => invoke<string | null>('excel:saveReport', report),
    batches: () => invoke<ExcelBatch[]>('excel:batches'),
    issues: (batchId: string) => invoke<ExcelIssue[]>('excel:issues', batchId),
    undo: (batchId: string) => invoke<{ ok: boolean; count: number; message?: string }>('excel:undo', batchId),
  },

  gedcom: {
    choose: () => invoke<string | null>('gedcom:choose'),
    analyze: (file: string, options: GedcomAnalyzeOptions) => invoke<{ preview: GedcomPreview }>('gedcom:analyze', file, options),
    commit: (file: string, options: GedcomAnalyzeOptions, expectedHash: string) =>
      invoke<GedcomCommitResult>('gedcom:commit', file, options, expectedHash),
    saveReport: (report: GedcomPreview | { batchId: string }) => invoke<string | null>('gedcom:saveReport', report),
    batches: () => invoke<GedcomBatch[]>('gedcom:batches'),
    issues: (batchId: string) => invoke<GedcomIssue[]>('gedcom:issues', batchId),
    undo: (batchId: string) => invoke<{ ok: boolean; count: number; message?: string }>('gedcom:undo', batchId),
    exportPreview: (options: GedcomExportOptions) => invoke<GedcomExportPreview>('gedcom:exportPreview', options),
    export: (options: GedcomExportOptions) => invoke<GedcomExportSaveResult | null>('gedcom:export', options),
  },

  pdf: {
    save: (payload: { data: GraphData; meta: GenealogyMeta; branches: Branch[]; zibei: ZibeiPoem[]; opts: PrintOptions }, defaultName: string) =>
      invoke<string | null>('pdf:save', payload, defaultName),
  },

  window: { setTitle: (title: string) => invoke<void>('window:setTitle', title) },
}

export type JiapuApi = typeof api

contextBridge.exposeInMainWorld('jiapu', api)