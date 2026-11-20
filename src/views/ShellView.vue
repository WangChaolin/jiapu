<script setup lang="ts">
import { ref, computed } from 'vue'
import { api } from '../api'
import { state, setPage, closeToHome, setSkin, locateInGraph, toast, type Page } from '../store'
import MembersView from './MembersView.vue'
import MemberFormView from './MemberFormView.vue'
import GraphView from './GraphView.vue'
import ZibeiView from './ZibeiView.vue'
import BranchView from './BranchView.vue'
import PdfView from './PdfView.vue'
import BackupView from './BackupView.vue'
import SettingsView from './SettingsView.vue'

const NAV: { key: Page; label: string; icon: string }[] = [
  { key: 'members', label: '成员管理', icon: '<circle cx="5.5" cy="5" r="2.2"/><path d="M1.5 13c.5-2.4 2-3.5 4-3.5s3.5 1.1 4 3.5"/><circle cx="11" cy="5.5" r="1.8"/><path d="M10.5 9.7c1.9.2 3.2 1.2 3.7 3.3"/>' },
  { key: 'form', label: '成员录入', icon: '<rect x="2" y="2" width="12" height="12" rx="2"/><path d="M8 5v6M5 8h6"/>' },
  { key: 'graph', label: '关系图谱', icon: '<circle cx="8" cy="3" r="1.8"/><circle cx="3.5" cy="12" r="1.8"/><circle cx="12.5" cy="12" r="1.8"/><path d="M8 4.8V8m0 0-3.5 2.2M8 8l3.5 2.2"/>' },
  { key: 'zibei', label: '字辈管理', icon: '<path d="M3 2h10M3 6h10M3 10h7M3 14h5"/>' },
  { key: 'branch', label: '支系管理', icon: '<path d="M8 2v4m0 0-4 3v5m4-8 4 3v5"/><circle cx="8" cy="2" r="1.4"/><circle cx="4" cy="14" r="1.4"/><circle cx="12" cy="14" r="1.4"/>' },
  { key: 'pdf', label: '导出 PDF', icon: '<path d="M4 1.5h5.5L12 4v10.5H4z"/><path d="M9.5 1.5V4H12M6 8h4M6 11h4"/>' },
  { key: 'backup', label: '备份恢复', icon: '<path d="M8 1.5 13 3v5c0 3.5-2.2 5.5-5 6.5C5.2 13.5 3 11.5 3 8V3z"/><path d="M5.8 8l1.6 1.6 3-3"/>' },
  { key: 'settings', label: '设置 · 皮肤', icon: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4"/>' },
]

const VIEWS: Record<Page, unknown> = {
  members: MembersView, form: MemberFormView, graph: GraphView, zibei: ZibeiView,
  branch: BranchView, pdf: PdfView, backup: BackupView, settings: SettingsView,
}
const activeView = computed(() => VIEWS[state.page])
const title = computed(() => state.current ? `${state.current.name}${state.current.hall ? ' · ' + state.current.hall : ''}` : '')
const search = ref('')

async function globalSearch(): Promise<void> {
  const q = search.value.trim()
  if (!q) return
  const r = await api.member.list({ keyword: q, limit: 1 })
  if (r.rows.length) { locateInGraph(r.rows[0].id); search.value = '' }
  else toast(`未找到「${q}」`, 'err')
}
</script>

<template>
  <div class="jp-window">
    <header class="jp-titlebar">
      <button class="jp-link" @click="closeToHome">‹ 家谱列表</button>
      <span class="jp-title">{{ title }}</span>
      <span v-if="state.stats" class="jp-badge jp-badge-blue">{{ state.stats.memberCount }} 人 · {{ state.stats.generations }} 世</span>
      <span class="jp-spacer"></span>
      <input v-model="search" type="search" placeholder="搜索成员，回车定位" aria-label="全局搜索成员" style="width:190px" @keydown.enter="globalSearch">
      <label class="jp-muted">皮肤
        <select :value="state.skin" aria-label="切换皮肤" @change="setSkin(($event.target as HTMLSelectElement).value as never)">
          <option value="system">跟随系统</option>
          <option value="light">浅色现代</option>
          <option value="dark">深色</option>
          <option value="classic">古典中国风</option>
        </select>
      </label>
    </header>
    <div class="jp-body">
      <nav class="jp-sidebar" aria-label="功能导航">
        <button v-for="n in NAV" :key="n.key" class="jp-navbtn" :title="n.label"
          :aria-current="state.page === n.key ? 'page' : undefined" @click="setPage(n.key)">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" v-html="n.icon"></svg>
          <span class="jp-navtext">{{ n.label }}</span>
        </button>
        <div class="jp-nav-foot">
          <div>{{ state.current?.surname }}氏 · {{ state.current?.hall || '—' }}</div>
          <div style="margin-top:4px">v{{ state.appInfo?.version }}</div>
        </div>
      </nav>
      <main class="jp-main">
        <component :is="activeView" :key="state.page + (state.editingId ?? '')" />
      </main>
    </div>
  </div>
</template>