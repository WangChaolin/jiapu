import { reactive } from 'vue'
import { api } from './api'
import type { AppSettings, GenealogyMeta, GenealogyStats, Skin } from '@shared/types'

export interface Toast {
  id: number
  msg: string
  type: 'info' | 'err'
  action?: { label: string; fn: () => void }
}

export type Page = 'members' | 'form' | 'graph' | 'zibei' | 'branch' | 'pdf' | 'gedcom' | 'backup' | 'settings'

interface State {
  ready: boolean
  settings: AppSettings | null
  appInfo: { version: string; dataDir: string; configPath: string; platform: string } | null
  genealogies: GenealogyMeta[]
  current: GenealogyMeta | null
  stats: GenealogyStats | null
  page: Page
  editingId: string | null
  formPrefill: { parents?: { otherId: string; subtype: string }[]; generation?: number; branchId?: string | null } | null
  graphFocusId: string | null
  memberFocusId: string | null
  skin: Skin
  toasts: Toast[]
  tick: number
}

export const state = reactive<State>({
  ready: false,
  settings: null,
  appInfo: null,
  genealogies: [],
  current: null,
  stats: null,
  page: 'members',
  editingId: null,
  formPrefill: null,
  graphFocusId: null,
  memberFocusId: null,
  skin: 'system',
  toasts: [],
  tick: 0,
})

let toastSeq = 0

export function toast(msg: string, type: 'info' | 'err' = 'info', action?: Toast['action']): void {
  const id = ++toastSeq
  state.toasts.push({ id, msg, type, action })
  const ttl = action ? 8000 : type === 'err' ? 6000 : 3500
  setTimeout(() => dismissToast(id), ttl)
}

export function dismissToast(id: number): void {
  const i = state.toasts.findIndex((t) => t.id === id)
  if (i >= 0) state.toasts.splice(i, 1)
}

export function bump(): void { state.tick++ }

export function applySkin(skin: Skin): void {
  state.skin = skin
  const root = document.documentElement
  if (skin === 'system') root.removeAttribute('data-skin')
  else root.setAttribute('data-skin', skin)
}

export async function setSkin(skin: Skin): Promise<void> {
  applySkin(skin)
  state.settings = await api.settings.update({ skin })
  if (state.current) {
    try { localStorage.setItem(`jiapu-skin-${state.current.id}`, skin) } catch { /* ignore */ }
  }
}

function rememberedSkin(id: string): Skin | null {
  try {
    const v = localStorage.getItem(`jiapu-skin-${id}`)
    return v ? (v as Skin) : null
  } catch { return null }
}

export async function init(): Promise<void> {
  state.settings = await api.settings.get()
  state.appInfo = await api.appInfo()
  applySkin(state.settings.skin)
  await loadGenealogies()
  state.ready = true
  let seeded = false
  try { seeded = !!localStorage.getItem('jiapu-seeded') } catch { /* ignore */ }
  if (!state.genealogies.length && !seeded) {
    try { localStorage.setItem('jiapu-seeded', '1') } catch { /* ignore */ }
    const meta = await api.genealogy.seedDemo()
    await openGenealogy(meta.id)
  }
}

export async function loadGenealogies(): Promise<void> {
  state.genealogies = await api.genealogy.list()
}

export async function openGenealogy(id: string): Promise<void> {
  state.current = await api.genealogy.open(id)
  const mem = rememberedSkin(id)
  if (mem) applySkin(mem)
  else if (state.settings) applySkin(state.settings.skin)
  state.page = 'members'
  state.editingId = null
  state.graphFocusId = null
  state.memberFocusId = null
  await refreshStats()
  api.window.setTitle(`${state.current.name}${state.current.hall ? ' · ' + state.current.hall : ''} — 家谱管理软件`)
  bump()
}

export async function closeToHome(): Promise<void> {
  state.current = null
  state.stats = null
  await api.genealogy.close()
  if (state.settings) applySkin(state.settings.skin)
  await loadGenealogies()
  api.window.setTitle('家谱管理软件')
  bump()
}

export async function refreshStats(): Promise<void> {
  if (state.current) state.stats = await api.genealogy.stats()
}

export function setPage(page: Page): void {
  state.page = page
  state.editingId = null
  state.formPrefill = null
}

export function editMember(id: string | null, prefill?: State['formPrefill']): void {
  state.editingId = id
  state.formPrefill = prefill ?? null
  state.page = 'form'
}

export function locateInGraph(id: string): void {
  state.graphFocusId = id
  state.page = 'graph'
}

export function showMember(id: string): void {
  state.memberFocusId = id
  state.page = 'members'
}

export async function run<T>(fn: () => Promise<T>, okMsg?: string): Promise<T | null> {
  try {
    const r = await fn()
    if (okMsg) toast(okMsg)
    return r
  } catch (e) {
    toast((e as Error).message || '操作失败', 'err')
    return null
  }
}

export const GEN_NAMES = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十']

export function genName(g: number): string {
  return g >= 1 && g <= GEN_NAMES.length ? `${GEN_NAMES[g - 1]}世` : `第${g}世`
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

export function fmtTime(t: number): string {
  const d = new Date(t)
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}