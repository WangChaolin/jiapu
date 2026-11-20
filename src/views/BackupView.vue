<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { api } from '../api'
import { state, run, toast, fmtBytes, fmtTime, loadGenealogies, openGenealogy } from '../store'
import type { BackupEntry } from '@shared/types'
import Modal from '../components/Modal.vue'

const backups = ref<BackupEntry[]>([])
const busy = ref(false)
const restoreTarget = ref<{ file: string; name: string } | null>(null)
const restoreNewName = ref('')
const delTarget = ref<BackupEntry | null>(null)
const importTarget = ref<string | null>(null)
const importName = ref('')

const autoBackup = computed(() => state.settings?.autoBackup ?? true)
const keepCount = computed(() => state.settings?.autoBackupKeep ?? 10)

function baseName(file: string): string { return file.split(/[\\/]/).pop() ?? file }

async function load(): Promise<void> { backups.value = await api.backup.list() }

async function backupNow(): Promise<void> {
  busy.value = true
  const e = await run(() => api.backup.create('手动备份'), '备份完成')
  busy.value = false
  if (e) await load()
}
async function toggleAuto(v: boolean): Promise<void> { state.settings = await api.settings.update({ autoBackup: v }) }
async function setKeep(n: number): Promise<void> { state.settings = await api.settings.update({ autoBackupKeep: n }) }

async function verify(file: string): Promise<void> {
  const r = await run(() => api.backup.verify(file))
  if (r) toast(r.ok ? '校验通过，备份完整可用' : `校验失败：${r.message ?? '文件损坏'}`, r.ok ? 'info' : 'err')
}
function askRestore(entry: BackupEntry): void { restoreTarget.value = { file: entry.file, name: entry.genealogyName }; restoreNewName.value = '' }
async function chooseZipRestore(): Promise<void> {
  const file = await api.backup.chooseZip()
  if (file) { restoreTarget.value = { file, name: baseName(file) }; restoreNewName.value = '' }
}
async function doRestore(): Promise<void> {
  const t = restoreTarget.value
  restoreTarget.value = null
  if (!t) return
  busy.value = true
  const asNew = restoreNewName.value.trim() || null
  const r = await run(() => api.backup.restore(t.file, asNew))
  busy.value = false
  if (r?.ok) {
    await loadGenealogies()
    await openGenealogy(r.genealogyId)
    await load()
    toast(`已恢复「${r.genealogyName}」`)
  } else if (r) toast(r.message ?? '恢复失败', 'err')
}
async function doDelete(): Promise<void> {
  const t = delTarget.value
  delTarget.value = null
  if (!t) return
  const list = await run(() => api.backup.delete(t.file))
  if (list) { backups.value = list; toast('备份已删除') }
}
async function exportJson(): Promise<void> {
  const file = await run(() => api.backup.exportJson())
  if (file) toast(`已导出 JSON：${file}`)
}
async function chooseJson(): Promise<void> {
  const file = await api.backup.chooseJson()
  if (file) { importTarget.value = file; importName.value = baseName(file).replace(/\.json$/i, '') }
}
async function doImport(): Promise<void> {
  const file = importTarget.value
  importTarget.value = null
  const name = importName.value.trim()
  if (!file || !name) { toast('请填写新家谱名称', 'err'); return }
  busy.value = true
  const r = await run(() => api.backup.importJson(file, name))
  busy.value = false
  if (r?.ok) {
    await loadGenealogies()
    if (r.meta) await openGenealogy(r.meta.id)
    toast(`已导入 ${r.count ?? 0} 位成员到「${name}」`)
  } else if (r) toast(r.message ?? '导入失败', 'err')
}

watch(() => state.tick, load)
onMounted(load)
</script>

<template>
  <div>
    <div class="jp-page-head">
      <h2 class="jp-page-title jp-serif-c">备份与恢复</h2>
      <span class="jp-muted">数据库 + 照片打包为单个备份文件，可跨机器恢复</span>
    </div>
    <div class="jp-toolbar">
      <button class="jp-primary" :disabled="busy" @click="backupNow">立即备份</button>
      <label><input type="checkbox" :checked="autoBackup" @change="toggleAuto(($event.target as HTMLInputElement).checked)">自动备份（打开 / 每日首次写入）</label>
      <label>保留份数
        <select :value="keepCount" aria-label="自动备份保留份数" @change="setKeep(parseInt(($event.target as HTMLSelectElement).value, 10))">
          <option :value="5">5</option><option :value="10">10</option><option :value="20">20</option><option :value="30">30</option>
        </select>
      </label>
      <span style="flex:1"></span>
      <button @click="chooseZipRestore">选择文件恢复</button>
      <button @click="exportJson">导出 JSON</button>
      <button @click="chooseJson">导入 JSON</button>
    </div>

    <div v-if="restoreTarget" class="jp-confirm">
      <span>确认恢复 <strong>{{ restoreTarget.name }}</strong>？恢复前将自动备份当前数据。</span>
      <input v-model="restoreNewName" type="text" placeholder="新谱名（留空则恢复原谱）" style="width:200px" aria-label="恢复为新家谱名称">
      <button class="jp-primary" :disabled="busy" @click="doRestore">确认恢复</button>
      <button @click="restoreTarget = null">取消</button>
    </div>

    <div class="jp-table-wrap">
      <table class="jp-table" aria-label="备份列表">
        <thead><tr><th>备份文件</th><th>时间</th><th class="jp-col-opt">大小</th><th class="jp-col-opt">类型</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-if="!backups.length"><td colspan="5"><div class="jp-empty"><div class="jp-empty-seal">备</div>暂无备份，点击「立即备份」创建</div></td></tr>
          <tr v-for="b in backups" :key="b.file" style="cursor:default">
            <td>
              <div class="jp-serif-c">{{ baseName(b.file) }}</div>
              <div class="jp-muted">{{ b.genealogyName }} · {{ b.memberCount }} 人<template v-if="b.note"> · {{ b.note }}</template></div>
            </td>
            <td class="jp-muted">{{ fmtTime(b.createdAt) }}</td>
            <td class="jp-muted jp-col-opt">{{ fmtBytes(b.size) }}</td>
            <td class="jp-col-opt"><span :class="b.kind === 'auto' ? 'jp-badge' : 'jp-badge jp-badge-accent'">{{ b.kind === 'auto' ? '自动' : '手动' }}</span></td>
            <td>
              <div class="jp-chips">
                <button class="jp-link" style="min-height:28px" @click="verify(b.file)">校验</button>
                <button class="jp-link" style="min-height:28px" @click="askRestore(b)">恢复</button>
                <button class="jp-link jp-danger" style="min-height:28px" @click="delTarget = b">删除</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="jp-muted" style="margin-top:10px">备份含格式版本清单，恢复时先校验完整性；云同步接口已预留（P2）。</p>

    <Modal v-if="delTarget" title="删除备份" danger confirm-text="删除"
      :message="`确认删除备份「${baseName(delTarget.file)}」？此操作不可撤销。`"
      @confirm="doDelete" @cancel="delTarget = null" />

    <Teleport to="body">
      <div v-if="importTarget" class="jp-modal-mask" @click.self="importTarget = null">
        <div class="jp-modal" role="dialog" aria-modal="true" aria-label="导入 JSON">
          <h3>导入 JSON 为新家谱</h3>
          <div class="jp-modal-body">
            <p class="jp-muted" style="margin-bottom:8px">{{ baseName(importTarget) }}</p>
            <div class="jp-field"><span>新家谱名称 *</span><input v-model="importName" type="text" aria-label="新家谱名称" @keydown.enter="doImport"></div>
          </div>
          <div class="jp-modal-actions">
            <button @click="importTarget = null">取消</button>
            <button class="jp-primary" @click="doImport">导入</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
