<script setup lang="ts">
import { ref, computed } from 'vue'
import { api } from '../api'
import { state, setSkin, run, toast, loadGenealogies, openGenealogy, closeToHome } from '../store'
import type { AppSettings, Skin } from '@shared/types'
import Modal from '../components/Modal.vue'

const SKIN_CARDS: { key: Skin; name: string; desc: string; sw: string[] }[] = [
  { key: 'system', name: '跟随系统', desc: '自动匹配明暗主题', sw: ['#f4f1ea', '#2e2a23', '#a03a28'] },
  { key: 'light', name: '浅色现代', desc: '米白 + 朱砂', sw: ['#fffdf8', '#2e2a23', '#a03a28'] },
  { key: 'dark', name: '深色', desc: '夜墨 + 赭红', sw: ['#1e2228', '#e9e6df', '#d4715a'] },
  { key: 'classic', name: '古典中国风', desc: '宣纸 + 墨色 + 朱砂印', sw: ['#f7f1e0', '#3b3025', '#8f2f1f'] },
]

const migrateTarget = ref<string | null>(null)
const dirBusy = ref(false)

const dataDir = computed(() => state.settings?.dataDir ?? '')
const autoBackup = computed(() => state.settings?.autoBackup ?? true)
const keepCount = computed(() => state.settings?.autoBackupKeep ?? 10)
const lunarDefault = computed(() => state.settings?.lunarDefault ?? false)

async function update(patch: Partial<Omit<AppSettings, 'dataDir'>>): Promise<void> {
  state.settings = await api.settings.update(patch)
}
async function chooseDir(): Promise<void> {
  const dir = await api.settings.chooseDir()
  if (!dir) return
  if (dir === dataDir.value) { toast('数据目录未变化'); return }
  const check = await api.settings.checkDataDir(dir)
  if (!check.ok) { toast(check.message ?? '该目录不可写', 'err'); return }
  migrateTarget.value = dir
}
async function doMigrate(): Promise<void> {
  const dir = migrateTarget.value
  migrateTarget.value = null
  if (!dir) return
  dirBusy.value = true
  const curId = state.current?.id ?? null
  const r = await run(() => api.settings.setDataDir(dir))
  if (r?.ok) {
    state.settings = await api.settings.get()
    state.appInfo = await api.appInfo()
    await loadGenealogies()
    if (curId && state.genealogies.some((g) => g.id === curId)) await openGenealogy(curId)
    else await closeToHome()
    toast(r.migrated ? `数据目录已更改，已迁移 ${r.migrated} 份家谱（原数据保留）` : (r.message ?? '数据目录已更改'))
  } else if (r) toast(r.message ?? '更改数据目录失败', 'err')
  dirBusy.value = false
}
async function revealDir(): Promise<void> { await api.settings.revealDataDir() }
</script>

<template>
  <div>
    <div class="jp-page-head">
      <h2 class="jp-page-title jp-serif-c">设置 · 皮肤</h2>
      <span class="jp-muted">即时切换，可按家谱单独记忆</span>
    </div>

    <div class="jp-panel">
      <div class="jp-panel-title">界面皮肤</div>
      <div class="jp-skin-cards">
        <button v-for="c in SKIN_CARDS" :key="c.key" class="jp-skin-card" :aria-pressed="state.skin === c.key" @click="setSkin(c.key)">
          <span class="jp-swatches"><i v-for="(s, i) in c.sw" :key="i" :style="{ background: s }"></i></span>
          <span>{{ c.name }}</span>
          <span class="jp-muted">{{ c.desc }}</span>
        </button>
      </div>
    </div>

    <div class="jp-panel" style="margin-top:14px">
      <div class="jp-panel-title">数据存储</div>
      <div class="jp-set-row">
        <span class="jp-set-label">数据目录</span>
        <code class="jp-code">{{ dataDir }}</code>
        <button :disabled="dirBusy" @click="chooseDir">选择目录…</button>
        <button @click="revealDir">打开目录</button>
      </div>
      <p class="jp-muted" style="padding:0 0 10px">每谱一个 SQLite 库文件与照片目录。选择空目录将校验可写并迁移全部家谱（原数据保留）；选择已有家谱数据的目录则直接切换使用。安装目录可在安装时自定义。</p>
      <div class="jp-set-row">
        <span class="jp-set-label">自动备份</span>
        <label><input type="checkbox" :checked="autoBackup" @change="update({ autoBackup: ($event.target as HTMLInputElement).checked })">打开家谱 / 每日首次写入时自动备份</label>
        <label>保留份数
          <select :value="keepCount" aria-label="自动备份保留份数" @change="update({ autoBackupKeep: parseInt(($event.target as HTMLSelectElement).value, 10) })">
            <option :value="5">5</option><option :value="10">10</option><option :value="20">20</option><option :value="30">30</option>
          </select>
        </label>
      </div>
      <div class="jp-set-row">
        <span class="jp-set-label">农历优先</span>
        <label><input type="checkbox" :checked="lunarDefault" @change="update({ lunarDefault: ($event.target as HTMLInputElement).checked })">录入与显示默认使用农历</label>
        <span class="jp-muted">公历日期始终无损存储，可随时切换</span>
      </div>
      <div class="jp-set-row">
        <span class="jp-set-label">云端同步</span>
        <span class="jp-badge jp-badge-gold">预留接口 · P2</span>
        <button disabled>配置同步（敬请期待）</button>
      </div>
      <div class="jp-set-row">
        <span class="jp-set-label">关于</span>
        <span>家谱管理软件 v{{ state.appInfo?.version }} · Electron + Vue 3 + SQLite（node:sqlite）</span>
      </div>
      <div class="jp-set-row">
        <span class="jp-set-label">配置文件</span>
        <code class="jp-code">{{ state.appInfo?.configPath }}</code>
      </div>
    </div>

    <Modal v-if="migrateTarget" title="更改数据目录" confirm-text="迁移并更改"
      :message="`将全部家谱数据迁移到新目录：\n${migrateTarget}\n\n原目录数据将保留作为备份，当前家谱会重新打开。确认继续？`"
      @confirm="doMigrate" @cancel="migrateTarget = null" />
  </div>
</template>
