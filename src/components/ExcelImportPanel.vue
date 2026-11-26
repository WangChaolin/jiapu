<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api } from '../api'
import { fmtTime, run, toast } from '../store'
import { EXCEL_FIELDS, type ExcelAnalyzeOptions, type ExcelBatch, type ExcelCommitResult, type ExcelMapping, type ExcelPreview } from '@shared/types'
import Modal from './Modal.vue'

const emit = defineEmits<{ imported: []; viewMembers: [] }>()

type Stage = 'file' | 'mapping' | 'preview' | 'done'
const stage = ref<Stage>('file')
const filePath = ref<string | null>(null)
const fileInfo = ref<{ name: string } | null>(null)
const preview = ref<ExcelPreview | null>(null)
const mapping = ref<ExcelMapping>({})
const duplicateMode = ref<ExcelAnalyzeOptions['duplicateMode']>('ask')
const branchMode = ref<ExcelAnalyzeOptions['branchMode']>('error')
const defaultGeneration = ref(1)
const duplicateDecisions = ref<Record<number, 'skip' | 'import'>>({})
const busy = ref(false)
const result = ref<ExcelCommitResult | null>(null)
const batches = ref<ExcelBatch[]>([])
const issueFilter = ref<'all' | 'error' | 'warning'>('all')
const confirmImport = ref(false)
const undoTarget = ref<ExcelBatch | null>(null)

const step = computed(() => stage.value === 'file' ? 1 : stage.value === 'mapping' ? 2 : stage.value === 'preview' ? 3 : 4)
const errors = computed(() => preview.value?.issues.filter((i) => i.level === 'error') ?? [])
const warnings = computed(() => preview.value?.issues.filter((i) => i.level === 'warning') ?? [])
const shownIssues = computed(() => {
  const all = preview.value?.issues ?? []
  return issueFilter.value === 'all' ? all : all.filter((i) => i.level === issueFilter.value)
})
const duplicateIssues = computed(() => preview.value?.issues.filter((i) => i.message.startsWith('疑似重复成员')) ?? [])
const skippedPreview = computed(() => {
  const p = preview.value
  return p ? Math.max(0, p.totalRows - p.validRows - p.errorRows) : 0
})

function options(): ExcelAnalyzeOptions {
  const clean: ExcelMapping = {}
  for (const f of EXCEL_FIELDS) {
    const value = mapping.value[f.key]
    if (value) clean[f.key] = value
  }
  return JSON.parse(JSON.stringify({
    mapping: clean, duplicateMode: duplicateMode.value, branchMode: branchMode.value,
    defaultGeneration: defaultGeneration.value, duplicateDecisions: duplicateDecisions.value,
  })) as ExcelAnalyzeOptions
}

async function loadBatches(): Promise<void> {
  batches.value = await api.excel.batches()
}

async function downloadTemplate(): Promise<void> {
  const file = await run(() => api.excel.template())
  if (file) toast('模板已下载，请按“填写说明”填写')
}

async function chooseFile(): Promise<void> {
  const file = await api.excel.choose()
  if (!file) return
  filePath.value = file
  fileInfo.value = { name: file.split(/[\\/]/).pop() ?? file }
  preview.value = null
  mapping.value = {}
  duplicateDecisions.value = {}
  result.value = null
  stage.value = 'mapping'
  await analyze(false)
}

async function analyze(goPreview = true): Promise<void> {
  if (!filePath.value) return
  busy.value = true
  const r = await run(() => api.excel.analyze(filePath.value!, options()))
  busy.value = false
  if (!r) return
  preview.value = r.preview
  mapping.value = { ...r.preview.suggestedMapping, ...mapping.value }
  if (goPreview) stage.value = 'preview'
}

async function doImport(): Promise<void> {
  if (busy.value || !filePath.value || !preview.value) return
  busy.value = true
  const r = await run(() => api.excel.commit(filePath.value!, options(), preview.value!.fileHash))
  busy.value = false
  confirmImport.value = false
  if (!r) return
  if (!r.ok) { toast(r.message || '导入失败', 'err'); return }
  result.value = r
  stage.value = 'done'
  toast(`成功导入 ${r.successCount} 位成员`)
  await loadBatches()
  emit('imported')
}

async function savePreviewReport(): Promise<void> {
  if (!preview.value) return
  const file = await run(() => api.excel.saveReport(JSON.parse(JSON.stringify(preview.value)) as ExcelPreview))
  if (file) toast('导入问题报告已导出')
}

async function saveBatchReport(batch: ExcelBatch): Promise<void> {
  const file = await run(() => api.excel.saveReport({ batchId: batch.id }))
  if (file) toast('批次问题报告已导出')
}

async function saveResultReport(): Promise<void> {
  if (!result.value?.batchId) return
  const file = await run(() => api.excel.saveReport({ batchId: result.value!.batchId! }))
  if (file) toast('导入问题报告已导出')
}

async function undoBatch(): Promise<void> {
  const batch = undoTarget.value
  undoTarget.value = null
  if (!batch) return
  const r = await run(() => api.excel.undo(batch.id))
  if (r?.ok) {
    toast(`已撤销该批次的 ${r.count} 位成员`)
    await loadBatches()
    emit('imported')
  } else if (r) toast(r.message || '撤销失败', 'err')
}

async function init(): Promise<void> {
  const generations = await api.member.generations()
  defaultGeneration.value = Math.max(0, ...generations) + 1
  await loadBatches()
}

onMounted(init)

function reset(): void {
  stage.value = 'file'
  filePath.value = null
  fileInfo.value = null
  preview.value = null
  mapping.value = {}
  duplicateDecisions.value = {}
  result.value = null
}
</script>

<template>
  <div class="jp-excel">
    <div class="jp-excel-steps" aria-label="导入步骤">
      <span v-for="n in 4" :key="n" :class="{ active: step === n, done: step > n }">
        <b>{{ step > n ? '✓' : n }}</b>{{ ['选择文件', '字段映射', '校验预览', '导入完成'][n - 1] }}
      </span>
    </div>

    <section v-if="stage === 'file'" class="jp-panel jp-excel-intro">
      <div class="jp-excel-mark" aria-hidden="true">表</div>
      <h3>从 Excel 批量录入成员</h3>
      <p class="jp-muted">先下载标准模板，填写成员基本信息后上传。首期支持 .xlsx，不自动导入亲属关系与照片。</p>
      <div class="jp-detail-actions">
        <button class="jp-primary" @click="downloadTemplate">下载 Excel 模板</button>
        <button @click="chooseFile">选择 .xlsx 文件</button>
      </div>
      <ul class="jp-excel-tips">
        <li>姓名必填，性别、世代、支系和日期会逐行校验。</li>
        <li>农历日期请同时选择“农历”，系统会转换为公历保存。</li>
        <li>疑似重复成员默认逐行确认；错误行不会导入。</li>
      </ul>
    </section>

    <template v-else>
      <section class="jp-panel jp-excel-file">
        <div>
          <strong>{{ fileInfo?.name }}</strong>
          <div class="jp-muted">已选择文件，导入前会再次核对文件内容，防止文件被替换。</div>
        </div>
        <button :disabled="busy" @click="chooseFile">重新选择</button>
      </section>

      <section v-if="stage === 'mapping'" class="jp-panel">
        <div class="jp-panel-title">字段映射与导入规则</div>
        <p class="jp-muted" style="margin-bottom:10px">系统已按表头自动匹配，请确认“姓名”及日期、支系等字段。</p>
        <div class="jp-table-wrap jp-excel-map-wrap">
          <table class="jp-table jp-excel-map">
            <thead><tr><th>软件字段</th><th>Excel 列</th><th>说明</th></tr></thead>
            <tbody>
              <tr v-for="f in EXCEL_FIELDS" :key="f.key">
                <td>{{ f.label }} <span v-if="f.required" class="jp-badge jp-badge-accent">必填</span></td>
                <td>
                  <select v-model="mapping[f.key]" :aria-label="`${f.label}对应列`">
                    <option value="">不导入</option>
                    <option v-for="h in preview?.headers ?? []" :key="h" :value="h">{{ h }}</option>
                  </select>
                </td>
                <td class="jp-muted">{{ f.aliases.length ? `也可识别：${f.aliases.join(' / ')}` : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="jp-form-row jp-excel-options">
          <label class="jp-field"><span>重复成员</span>
            <select v-model="duplicateMode">
              <option value="ask">逐行确认</option><option value="skip">全部跳过</option><option value="import">全部作为新成员导入</option>
            </select>
          </label>
          <label class="jp-field"><span>不存在的支系</span>
            <select v-model="branchMode">
              <option value="error">标记错误</option><option value="keep-empty">留空并警告</option><option value="create">自动创建支系</option>
            </select>
          </label>
          <label class="jp-field"><span>空白世代的默认值</span>
            <input v-model.number="defaultGeneration" type="number" min="1" max="9999" aria-label="默认世代">
          </label>
        </div>
        <div v-if="preview" class="jp-stat-grid jp-excel-stats">
          <div class="jp-stat"><div class="jp-stat-value">{{ preview.totalRows }}</div><div class="jp-stat-label">总行数</div></div>
          <div class="jp-stat"><div class="jp-stat-value">{{ preview.validRows }}</div><div class="jp-stat-label">当前可导入</div></div>
          <div class="jp-stat"><div class="jp-stat-value">{{ preview.errorRows }}</div><div class="jp-stat-label">错误行</div></div>
          <div class="jp-stat"><div class="jp-stat-value">{{ preview.duplicateRows }}</div><div class="jp-stat-label">疑似重复</div></div>
        </div>
        <div class="jp-detail-actions">
          <button :disabled="busy || !mapping.name" class="jp-primary" @click="analyze(true)">{{ busy ? '正在校验…' : '重新校验并预览' }}</button>
          <button :disabled="busy" @click="reset">取消</button>
        </div>
      </section>

      <section v-else-if="stage === 'preview' && preview" class="jp-panel">
        <div class="jp-panel-title">校验结果与导入预览</div>
        <div class="jp-stat-grid jp-excel-stats">
          <div class="jp-stat"><div class="jp-stat-value">{{ preview.totalRows }}</div><div class="jp-stat-label">总行数</div></div>
          <div class="jp-stat"><div class="jp-stat-value">{{ preview.validRows }}</div><div class="jp-stat-label">成功导入</div></div>
          <div class="jp-stat"><div class="jp-stat-value">{{ skippedPreview }}</div><div class="jp-stat-label">跳过</div></div>
          <div class="jp-stat"><div class="jp-stat-value">{{ preview.errorRows }}</div><div class="jp-stat-label">失败行</div></div>
          <div class="jp-stat"><div class="jp-stat-value">{{ errors.length }}</div><div class="jp-stat-label">错误</div></div>
          <div class="jp-stat"><div class="jp-stat-value">{{ warnings.length }}</div><div class="jp-stat-label">警告</div></div>
        </div>
        <div v-if="preview.blankGenerationRows" class="jp-confirm">
          <span>{{ preview.blankGenerationRows }} 行未填写世代，将按第 {{ preview.defaultGeneration }} 世导入。</span>
          <button @click="stage = 'mapping'">修改默认世代</button>
        </div>
        <div v-if="preview.missingBranches.length" class="jp-confirm">
          <span>发现 {{ preview.missingBranches.length }} 个不存在的支系：{{ preview.missingBranches.join('、') }}</span>
          <button @click="stage = 'mapping'">调整处理方式</button>
        </div>

        <div v-if="duplicateMode === 'ask' && duplicateIssues.length" class="jp-excel-dups">
          <h4>逐行确认重复成员</h4>
          <p class="jp-muted">默认跳过；选择“作为新成员导入”后，请重新校验以更新数量。</p>
          <div class="jp-table-wrap">
            <table class="jp-table">
              <thead><tr><th>Excel 行</th><th>姓名</th><th>处理方式</th></tr></thead>
              <tbody>
                <tr v-for="d in duplicateIssues" :key="d.rowNumber">
                  <td>{{ d.rowNumber }}</td><td>{{ d.value }}</td>
                  <td>
                    <select v-model="duplicateDecisions[d.rowNumber]" :aria-label="`第${d.rowNumber}行重复处理`" @change="analyze(false)">
                      <option value="skip">跳过</option><option value="import">作为新成员导入</option>
                    </select>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <h4 class="jp-excel-subtitle">数据样例（前 {{ preview.sample.length }} 行）</h4>
        <div class="jp-table-wrap">
          <table class="jp-table jp-excel-preview">
            <thead><tr><th>行</th><th>姓名</th><th>性别</th><th>世代</th><th>支系</th><th>出生日期</th><th>校验</th></tr></thead>
            <tbody>
              <tr v-for="r in preview.sample" :key="r.rowNumber">
                <td>{{ r.rowNumber }}</td><td>{{ r.name }}</td><td>{{ r.gender }}</td>
                <td>{{ r.generation ?? `默认 ${preview.defaultGeneration}` }}</td><td>{{ r.branchName || '—' }}</td>
                <td>{{ r.birthDate ? `${r.birthDate}${r.birthLunar ? '（农历）' : ''}` : '—' }}</td>
                <td>
                  <span v-if="r.errorCount" class="jp-badge jp-badge-accent">{{ r.errorCount }} 错误</span>
                  <span v-else-if="r.duplicate" class="jp-badge jp-badge-gold">重复</span>
                  <span v-else class="jp-badge jp-badge-green">可导入</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="jp-excel-issues-head">
          <h4 class="jp-excel-subtitle">问题清单</h4>
          <div class="jp-tabs">
            <button :aria-pressed="issueFilter === 'all'" @click="issueFilter = 'all'">全部 {{ preview.issues.length }}</button>
            <button :aria-pressed="issueFilter === 'error'" @click="issueFilter = 'error'">错误 {{ errors.length }}</button>
            <button :aria-pressed="issueFilter === 'warning'" @click="issueFilter = 'warning'">警告 {{ warnings.length }}</button>
          </div>
        </div>
        <div class="jp-table-wrap jp-excel-issues">
          <table class="jp-table">
            <thead><tr><th>行</th><th>级别</th><th>字段</th><th>原始值</th><th>原因 / 建议</th></tr></thead>
            <tbody>
              <tr v-if="!shownIssues.length"><td colspan="5" class="jp-muted">当前筛选下没有问题</td></tr>
              <tr v-for="(i, idx) in shownIssues" :key="`${i.rowNumber}-${idx}`">
                <td>{{ i.rowNumber || '全局' }}</td>
                <td><span :class="i.level === 'error' ? 'jp-badge jp-badge-accent' : 'jp-badge jp-badge-gold'">{{ i.level === 'error' ? '错误' : '警告' }}</span></td>
                <td>{{ i.field || '—' }}</td><td>{{ i.value || '—' }}</td><td>{{ i.message }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="jp-detail-actions">
          <button @click="stage = 'mapping'">返回映射</button>
          <button :disabled="busy || !preview.issues.length" @click="savePreviewReport">导出问题报告</button>
          <button class="jp-primary" :disabled="busy || !preview.validRows" @click="confirmImport = true">确认导入 {{ preview.validRows }} 人</button>
        </div>
      </section>

      <section v-else-if="stage === 'done' && result" class="jp-panel jp-excel-done">
        <div class="jp-excel-done-seal">成</div>
        <h3>导入完成</h3>
        <p>成功导入 <strong>{{ result.successCount }}</strong> 人，跳过 {{ result.skippedCount }} 行，失败 {{ result.failedCount }} 行。</p>
        <p v-if="result.failedCount" class="jp-muted">错误行未写入。可先下载问题报告，在原 Excel 中修正后重新导入。</p>
        <div class="jp-detail-actions">
          <button v-if="result.failedCount" class="jp-primary" @click="saveResultReport">下载问题报告</button>
          <button class="jp-primary" @click="emit('viewMembers')">查看成员</button>
          <button @click="reset">继续导入</button>
        </div>
      </section>
    </template>

    <section class="jp-panel jp-excel-batches">
      <div class="jp-panel-title">最近导入批次</div>
      <div v-if="!batches.length" class="jp-muted">暂无导入记录。</div>
      <div v-else class="jp-table-wrap">
        <table class="jp-table">
          <thead><tr><th>来源文件</th><th>时间</th><th>结果</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="b in batches" :key="b.id">
              <td>{{ b.sourceName }}</td><td>{{ fmtTime(b.createdAt) }}</td>
              <td>成功 {{ b.successCount }} · 跳过 {{ b.skippedCount }} · 失败 {{ b.failedCount }}</td>
              <td><span :class="b.status === 'done' ? 'jp-badge jp-badge-green' : 'jp-badge'">{{ b.status === 'done' ? '已导入' : '已撤销' }}</span></td>
              <td>
                <div class="jp-toolbar" style="margin:0">
                  <button v-if="b.failedCount || b.skippedCount" @click="saveBatchReport(b)">报告</button>
                  <button v-if="b.status === 'done'" class="jp-danger" :disabled="busy" @click="undoTarget = b">撤销批次</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <Modal v-if="confirmImport" title="确认导入成员" confirm-text="开始导入"
      :message="`将导入 ${preview?.validRows ?? 0} 位成员。错误行不会写入，导入后可在“最近导入批次”中整批撤销。`"
      @confirm="doImport" @cancel="confirmImport = false" />
    <Modal v-if="undoTarget" title="撤销导入批次" danger confirm-text="确认撤销"
      :message="`将撤销「${undoTarget.sourceName}」导入的 ${undoTarget.successCount} 位成员及其后续关系。此操作不会删除手动新增的成员。`"
      @confirm="undoBatch" @cancel="undoTarget = null" />
  </div>
</template>
