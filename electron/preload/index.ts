import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings, BackupEntry, Branch, DirCheck, GenealogyMeta, GenealogyStats,
  GraphData, Member, MemberDetail, MemberFilter, MemberInput, RestoreResult, ZibeiPoem,
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
    choosePhoto: () => invoke<string | null>('member:choosePhoto'),
    savePhoto: (sourcePath: string) => invoke<string>('member:savePhoto', sourcePath),
  },

  graph: { data: () => invoke<GraphData>('graph:data') },

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
  },

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

  pdf: {
    save: (payload: { data: GraphData; meta: GenealogyMeta; branches: Branch[]; zibei: ZibeiPoem[]; opts: PrintOptions }, defaultName: string) =>
      invoke<string | null>('pdf:save', payload, defaultName),
  },

  window: { setTitle: (title: string) => invoke<void>('window:setTitle', title) },
}

export type JiapuApi = typeof api

contextBridge.exposeInMainWorld('jiapu', api)