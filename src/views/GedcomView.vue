<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { api } from '../api'
import { fmtTime, refreshStats, run, setPage, toast } from '../store'
import type {
  Branch, GedcomAnalyzeOptions, GedcomBatch, GedcomCommitResult, GedcomExportOptions,
  GedcomExportPreview, GedcomPreview,
} from '@shared/types'
import Modal from '../components/Modal.vue'

type Stage = 'file' | 'review' | 'confirm' | 'done'
const tab = ref<'import' | 'export'>('import')
const stage = ref<Stage>('file')
const filePath = ref<string | null>(null)
const fileName = ref('')
const preview = ref<GedcomPreview | null>(null)
const result = ref<GedcomCommitResult | null>(null)
const busy = ref(false)
const confirmImport = ref(false)
const undoTarget = ref<GedcomBatch | null>(null)
const batches = ref<GedcomBatch[]>([])
const branches = ref<Branch[]>([])
const generations = ref<number[]>([])
const options = reactive<GedcomAnalyzeOptions>({
  duplicateMode: 'ask', defaultGeneration: 1, autoDeriveGeneration: true,
  placeTarget: 'remark', photoMode: 'copy', preserveUnsupported: true,
  unsupportedActions: {}, duplicateDecisions: {},
})
const exportOptions = reactive<GedcomExportOptions>({
  scope: 'all', branchId: null, generation: null, memberIds: [],
  version: '5.5.1', encoding: 'utf-8', includePhotos: true,
  includeNotes: true, includeCompatibility: true,
})
const exportPreview = ref<GedcomExportPreview | null>(null)
const duplicateDecisions = ref<Record<string, 'skip' | 'import'>>({})

const step = computed(() => stage.value === 'file' ? 1 : stage.value === 'review' ? 2 : stage.value === 'confirm' ? 3 : 4)
const errors = computed(() => preview.value?.issues.filter((i) => i.level === 'error') ?? [])
const warnings = computed(() => preview.value?.issues.filter((i) => i.level === 'warning') ?? [])
const shownIssues = computed(() => preview.value?.issues.slice(0, 80) ?? [])

function analyzeOptions(): GedcomAnalyzeOptions {
  return JSON.parse(JSON.stringify({ ...options, duplicateDecisions: duplicateDecisions.value })) as GedcomAnalyzeOptions
}

function exportPayload(): GedcomExportOptions {
  return JSON.parse(JSON.stringify(exportOptions)) as GedcomExportOptions
}

async function loadBatches(): Promise<void> { batches.value = await api.gedcom.batches() }

async function loadExportPreview(): Promise<void> {
  const value = await run(() => api.gedcom.exportPreview(exportPayload()))
  if (value) exportPreview.value = value
}

async function chooseFile(): Promise<void> {
  const file = await api.gedcom.choose()
  if (!file) return
  filePath.value = file
  fileName.value = file.split(/[\\/]/).pop() ?? file
  preview.value = null
  result.value = null
  options.duplicateDecisions = {}
  duplicateDecisions.value = {}
  options.unsupportedActions = {}
  stage.value = 'review'
  await analyze(false)
}

async function analyze(goConfirm = true): Promise<void> {
  if (!filePath.value) return
  busy.value = true
  const response = await run(() => api.gedcom.analyze(filePath.value!, analyzeOptions()))
  busy.value = false
  if (!response) return
  preview.value = response.preview
  if (goConfirm) stage.value = 'confirm'
}

async function doImport(): Promise<void> {
  if (busy.value || !filePath.value || !preview.value) return
  busy.value = true
  const response = await run(() => api.gedcom.commit(filePath.value!, analyzeOptions(), preview.value!.fileHash))
  busy.value = false
  confirmImport.value = false
  if (!response) return
  if (!response.ok) { toast(response.message || '导入失败', 'err'); return }
  result.value = response
  stage.value = 'done'
  toast(`成功导入 ${response.successCount} 名成员`)
  await loadBatches()
  await refreshStats()
}

async function savePreviewReport(): Promise<void> {
  if (!preview.value) return
  const file = await run(() => api.gedcom.saveReport(JSON.parse(JSON.stringify(preview.value)) as GedcomPreview))
  if (file) toast('导入问题报告已导出')
}

async function saveBatchReport(batch: GedcomBatch): Promise<void> {
  const file = await run(() => api.gedcom.saveReport({ batchId: batch.id }))
  if (file) toast('批次问题报告已导出')
}

async function saveResultReport(): Promise<void> {
  const batchId = result.value?.batchId
  if (!batchId) return
  const file = await run(() => api.gedcom.saveReport({ batchId }))
  if (file) toast('导入问题报告已导出')
}

async function undoBatch(): Promise<void> {
  const batch = undoTarget.value
  undoTarget.value = null
  if (!batch) return
  const response = await run(() => api.gedcom.undo(batch.id))
  if (response?.ok) {
    toast(`已撤销该批次的 ${response.count} 名成员`)
    await loadBatches()
    await refreshStats()
  } else if (response) toast(response.message || '撤销失败', 'err')
}

async function doExport(): Promise<void> {
  if (busy.value) return
  busy.value = true
  const response = await run(() => api.gedcom.export(exportPayload()))
  busy.value = false
  if (!response) return
  toast(`GEDCOM 已导出：${response.filePath}`)
  if (response.warnings.length) toast(response.warnings[0], 'err')
}

function reset(): void {
  stage.value = 'file'
  filePath.value = null
  fileName.value = ''
  preview.value = null
  result.value = null
  options.duplicateDecisions = {}
  duplicateDecisions.value = {}
  options.unsupportedActions = {}
}

async function init(): Promise<void> {
  generations.value = await api.member.generations()
  options.defaultGeneration = Math.max(0, ...generations.value) + 1
  branches.value = await api.branch.list()
  await loadBatches()
  await loadExportPreview()
}

onMounted(init)
</script>

<template>
  <div class="jp-gedcom">
    <div class="jp-page-head">
      <h2 class="jp-page-title jp-serif-c">GEDCOM 数据交换</h2>
      <div class="jp-tabs" style="margin:0 0 0 8px">
        <button :aria-pressed="tab === 'import'" @click="tab = 'import'">导入 GEDCOM</button>
        <button :aria-pressed="tab === 'export'" @click="tab = 'export'">导出 GEDCOM</button>
      </div>
      <span class="jp-muted">标准 5.5.1 交换 · 预检优先 · 特殊关系兼容提示</span>
    </div>

    <template v-if="tab === 'import'">
      <div class="jp-gedcom-steps" aria-label="GEDCOM 导入步骤">
        <span v-for="n in 4" :key="n" :class="{ active: step === n, done: step > n }">
          <b>{{ step > n ? '✓' : n }}</b>{{ ['文件预检', '映射与查重', '兼容确认', '导入完成'][n - 1] }}
        </span>
      </div>

      <section v-if="stage === 'file'" class="jp-panel jp-gedcom-intro">
        <div class="jp-gedcom-mark" aria-hidden="true">谱</div>
        <h3>从 GEDCOM 文件导入家谱</h3>
        <p class="jp-muted">支持个人、家庭、事件、日期、地点、备注与照片。导入前会检查记录数、疑似重复、不支持标签和编码风险，不覆盖现有成员。</p>
        <div class="jp-detail-actions"><button class="jp-primary" @click="chooseFile">选择 .ged 文件</button></div>
        <ul class="jp-gedcom-tips">
          <li>首期支持 GEDCOM 5.5 / 5.5.1，自动识别 UTF-8、UTF-16 与常见中文 ANSI 编码。</li>
          <li>姓名、性别、出生日期完全一致的成员会提示重复，由你决定跳过或仍作为新成员导入。</li>
          <li>兼祧、过继等本地扩展关系无法标准表达时，会保留原文并生成兼容性报告。</li>
        </ul>
      </section>

      <template v-else>
        <section class="jp-panel jp-gedcom-file">
          <div><strong>{{ fileName }}</strong><div class="jp-muted">提交前会再次核对文件哈希，防止文件在预检后被替换。</div></div>
          <button :disabled="busy" @click="chooseFile">重新选择</button>
        </section>

        <section v-if="stage === 'review' && preview" class="jp-panel">
          <div class="jp-panel-title">文件预检与字段映射</div>
          <div class="jp-stat-grid jp-gedcom-stats">
            <div class="jp-stat"><div class="jp-stat-value">{{ preview.individualCount }}</div><div class="jp-stat-label">个人 INDI</div></div>
            <div class="jp-stat"><div class="jp-stat-value">{{ preview.familyCount }}</div><div class="jp-stat-label">家庭 FAM</div></div>
            <div class="jp-stat"><div class="jp-stat-value">{{ preview.eventCount }}</div><div class="jp-stat-label">事件记录</div></div>
            <div class="jp-stat"><div class="jp-stat-value">{{ preview.photoCount }}</div><div class="jp-stat-label">照片</div></div>
            <div class="jp-stat"><div class="jp-stat-value">{{ preview.duplicateCount }}</div><div class="jp-stat-label">疑似重复</div></div>
            <div class="jp-stat"><div class="jp-stat-value">{{ preview.unsupportedTags.length }}</div><div class="jp-stat-label">不支持标签</div></div>
          </div>
          <div class="jp-confirm"><span>版本 {{ preview.version }} · 编码 {{ preview.encoding }} · 当前可导入 {{ preview.validCount }} 人，跳过 {{ preview.skippedCount }} 人。</span></div>

          <div class="jp-gedcom-two-col">
            <div>
              <h4 class="jp-gedcom-subtitle">字段映射</h4>
              <table class="jp-table jp-gedcom-map">
                <thead><tr><th>GEDCOM 标签</th><th>软件字段</th><th>处理</th></tr></thead>
                <tbody>
                  <tr><td>INDI.NAME</td><td>姓名</td><td><span class="jp-badge jp-badge-green">已映射</span></td></tr>
                  <tr><td>INDI.SEX</td><td>性别</td><td><span class="jp-badge jp-badge-green">已映射</span></td></tr>
                  <tr><td>BIRT.DATE / DEAT.DATE</td><td>出生 / 卒日期</td><td><span class="jp-badge jp-badge-green">已映射</span></td></tr>
                  <tr><td>BIRT.PLAC / DEAT.PLAC</td><td>地点</td><td><select v-model="options.placeTarget" aria-label="地点映射" @change="analyze(false)"><option value="remark">写入备注</option><option value="residence">作为居地</option><option value="ignore">忽略</option></select></td></tr>
                  <tr><td>OCCU / RESI / BURI</td><td>职业 / 居地 / 葬地</td><td><span class="jp-badge jp-badge-green">已映射</span></td></tr>
                  <tr><td>NOTE / BIOG</td><td>备注 / 生平</td><td><span class="jp-badge jp-badge-green">已映射</span></td></tr>
                  <tr><td>OBJE.FILE</td><td>照片</td><td><select v-model="options.photoMode" aria-label="照片映射" @change="analyze(false)"><option value="copy">复制到家谱照片目录</option><option value="path">仅记录原始路径</option><option value="ignore">忽略</option></select></td></tr>
                  <tr><td>FAM.HUSB / WIFE / CHIL</td><td>配偶与父母子女</td><td><span class="jp-badge jp-badge-green">已映射</span></td></tr>
                </tbody>
              </table>
              <div class="jp-confirm"><span>世代按父母关系自动推导；GEDCOM 不包含支系，导入后支系留空。</span><label class="jp-check"><input v-model="options.autoDeriveGeneration" type="checkbox" @change="analyze(false)">自动推导世代</label></div>
            </div>
            <div>
              <h4 class="jp-gedcom-subtitle">疑似重复 · {{ preview.duplicates.length }} 组</h4>
              <div v-if="!preview.duplicates.length" class="jp-muted">未发现与现有成员完全匹配的记录。</div>
              <div v-for="dup in preview.duplicates" :key="dup.id" class="jp-gedcom-issue">
                <b>{{ dup.name }} · {{ dup.gender }} · {{ dup.birthDate }}</b>
                <span class="jp-muted">现有成员：{{ dup.existingNames.join('、') }}</span>
                <select v-model="duplicateDecisions[dup.id]" :aria-label="`${dup.name}重复处理`" @change="analyze(false)">
                  <option value="skip">跳过</option><option value="import">仍作为新成员导入</option>
                </select>
              </div>
              <h4 class="jp-gedcom-subtitle" style="margin-top:16px">不支持标签</h4>
              <div v-if="!preview.unsupportedTags.length" class="jp-muted">未发现不支持标签。</div>
              <div v-for="tag in preview.unsupportedTags" :key="tag.tag" class="jp-gedcom-tag">
                <code>{{ tag.tag }}</code><span>× {{ tag.count }}</span>
                <select v-model="options.unsupportedActions[tag.tag]" :aria-label="`${tag.tag}处理`" @change="analyze(false)"><option value="note">保留到备注</option><option value="skip">跳过</option></select>
              </div>
            </div>
          </div>

          <h4 class="jp-gedcom-subtitle">成员样例（前 {{ preview.sample.length }} 条）</h4>
          <div class="jp-table-wrap">
            <table class="jp-table">
              <thead><tr><th>GEDCOM ID</th><th>姓名</th><th>性别</th><th>世代</th><th>出生日期</th><th>校验</th></tr></thead>
              <tbody>
                <tr v-for="member in preview.sample" :key="member.id">
                  <td><code>{{ member.id }}</code></td><td>{{ member.name }}</td><td>{{ member.gender }}</td>
                  <td>{{ member.generation ?? '—' }}</td><td>{{ member.birthDate || '—' }}</td>
                  <td><span v-if="member.errorCount" class="jp-badge jp-badge-accent">{{ member.errorCount }} 错误</span><span v-else-if="member.duplicate" class="jp-badge jp-badge-gold">重复</span><span v-else class="jp-badge jp-badge-green">可导入</span></td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="jp-detail-actions"><button :disabled="busy" @click="reset">取消</button><button class="jp-primary" :disabled="busy || !preview.validCount" @click="analyze(true)">下一步：兼容确认</button></div>
        </section>

        <section v-else-if="stage === 'confirm' && preview" class="jp-panel">
          <div class="jp-panel-title">兼容性确认</div>
          <div class="jp-stat-grid jp-gedcom-stats">
            <div class="jp-stat"><div class="jp-stat-value">{{ preview.validCount }}</div><div class="jp-stat-label">将导入成员</div></div>
            <div class="jp-stat"><div class="jp-stat-value">{{ preview.skippedCount }}</div><div class="jp-stat-label">跳过</div></div>
            <div class="jp-stat"><div class="jp-stat-value">{{ preview.familyCount }}</div><div class="jp-stat-label">家庭记录</div></div>
            <div class="jp-stat"><div class="jp-stat-value">{{ preview.photoCount }}</div><div class="jp-stat-label">照片</div></div>
          </div>
          <div class="jp-gedcom-two-col">
            <div>
              <h4 class="jp-gedcom-subtitle">兼容性说明</h4>
              <ul class="jp-gedcom-compat"><li v-for="item in preview.compatibility" :key="item">{{ item }}</li></ul>
              <h4 class="jp-gedcom-subtitle">问题摘要</h4>
              <div class="jp-confirm"><span>错误 {{ errors.length }} 条 · 警告 {{ warnings.length }} 条。所有跳过或无法映射的标签都会写入导入报告。</span></div>
            </div>
            <div>
              <h4 class="jp-gedcom-subtitle">导入选项</h4>
              <div class="jp-gedcom-checks">
                <label><input v-model="options.preserveUnsupported" type="checkbox" @change="analyze(false)">将不支持标签保留到备注</label>
                <label><input v-model="options.autoDeriveGeneration" type="checkbox" @change="analyze(false)">自动推导世代</label>
                <label><input :checked="options.photoMode === 'copy'" type="checkbox" disabled>复制照片到家谱照片目录</label>
              </div>
              <div class="jp-confirm"><span>导入采用单个事务，失败整体回滚；成功后生成可撤销批次。</span></div>
            </div>
          </div>
          <h4 class="jp-gedcom-subtitle">问题清单（前 {{ shownIssues.length }} 条）</h4>
          <div class="jp-table-wrap jp-gedcom-issues">
            <table class="jp-table">
              <thead><tr><th>行</th><th>级别</th><th>字段</th><th>原始值</th><th>原因 / 建议</th></tr></thead>
              <tbody>
                <tr v-if="!shownIssues.length"><td colspan="5" class="jp-muted">没有问题</td></tr>
                <tr v-for="(issue, index) in shownIssues" :key="`${issue.rowNumber}-${index}`">
                  <td>{{ issue.rowNumber || '全局' }}</td>
                  <td><span :class="issue.level === 'error' ? 'jp-badge jp-badge-accent' : 'jp-badge jp-badge-gold'">{{ issue.level === 'error' ? '错误' : '警告' }}</span></td>
                  <td>{{ issue.field || '—' }}</td><td>{{ issue.value || '—' }}</td><td>{{ issue.message }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="jp-detail-actions"><button :disabled="busy" @click="stage = 'review'">返回映射</button><button :disabled="busy || !preview.issues.length" @click="savePreviewReport">导出问题报告</button><button class="jp-primary" :disabled="busy || !preview.validCount" @click="confirmImport = true">确认导入 {{ preview.validCount }} 人</button></div>
        </section>

        <section v-else-if="stage === 'done' && result" class="jp-panel jp-gedcom-done">
          <div class="jp-gedcom-done-seal">成</div>
          <h3>GEDCOM 导入完成</h3>
          <p>成功导入 <strong>{{ result.successCount }}</strong> 名成员、{{ result.relationCount }} 条关系与 {{ result.photoCount }} 张照片；跳过 {{ result.skippedCount }} 条，失败 {{ result.failedCount }} 条。</p>
          <div class="jp-detail-actions">
            <button v-if="result.batchId" @click="saveResultReport">导出问题报告</button>
            <button class="jp-primary" @click="setPage('members')">查看成员</button>
            <button @click="reset">继续导入</button>
          </div>
        </section>
      </template>

      <section class="jp-panel jp-gedcom-batches">
        <div class="jp-panel-title">最近 GEDCOM 导入批次</div>
        <div v-if="!batches.length" class="jp-muted">暂无 GEDCOM 导入记录。</div>
        <div v-else class="jp-table-wrap">
          <table class="jp-table">
            <thead><tr><th>来源文件</th><th>时间</th><th>结果</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="batch in batches" :key="batch.id">
                <td>{{ batch.sourceName }}</td><td>{{ fmtTime(batch.createdAt) }}</td>
                <td>成功 {{ batch.successCount }} · 跳过 {{ batch.skippedCount }} · 失败 {{ batch.failedCount }}</td>
                <td><span :class="batch.status === 'done' ? 'jp-badge jp-badge-green' : 'jp-badge'">{{ batch.status === 'done' ? '已导入' : '已撤销' }}</span></td>
                <td><div class="jp-toolbar" style="margin:0"><button v-if="batch.failedCount || batch.skippedCount" @click="saveBatchReport(batch)">报告</button><button v-if="batch.status === 'done'" class="jp-danger" :disabled="busy" @click="undoTarget = batch">撤销批次</button></div></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <section v-else class="jp-panel">
      <div class="jp-gedcom-two-col jp-gedcom-export">
        <div>
          <div class="jp-panel-title">导出设置</div>
          <label class="jp-field" style="margin:12px 0"><span>导出范围</span><select v-model="exportOptions.scope" @change="loadExportPreview"><option value="all">整谱</option><option value="branch">指定支系</option><option value="generation">指定世代</option></select></label>
          <label v-if="exportOptions.scope === 'branch'" class="jp-field" style="margin-bottom:12px"><span>支系</span><select v-model="exportOptions.branchId" @change="loadExportPreview"><option v-for="branch in branches" :key="branch.id" :value="branch.id">{{ branch.name }}</option></select></label>
          <label v-if="exportOptions.scope === 'generation'" class="jp-field" style="margin-bottom:12px"><span>世代</span><select v-model.number="exportOptions.generation" @change="loadExportPreview"><option v-for="generation in generations" :key="generation" :value="generation">第 {{ generation }} 世</option></select></label>
          <label class="jp-field" style="margin-bottom:12px"><span>GEDCOM 版本</span><select v-model="exportOptions.version" @change="loadExportPreview"><option value="5.5.1">5.5.1</option><option value="5.5">5.5</option></select></label>
          <label class="jp-field" style="margin-bottom:12px"><span>字符编码</span><select v-model="exportOptions.encoding" @change="loadExportPreview"><option value="utf-8">UTF-8（推荐）</option><option value="gbk">ANSI / GBK</option></select></label>
          <div class="jp-panel-title">包含内容</div>
          <div class="jp-gedcom-checks">
            <label><input v-model="exportOptions.includePhotos" type="checkbox" @change="loadExportPreview">照片（复制到导出目录）</label>
            <label><input v-model="exportOptions.includeNotes" type="checkbox" @change="loadExportPreview">备注与来源</label>
            <label><input v-model="exportOptions.includeCompatibility" type="checkbox" @change="loadExportPreview">兼祧 / 过继兼容性说明</label>
          </div>
          <div class="jp-confirm"><span>兼祧与过继会尽量映射到标准 PEDI / NOTE 标签，同时写入本地扩展说明，避免其他软件静默忽略。</span></div>
          <div class="jp-detail-actions" style="margin-top:14px"><button :disabled="busy" @click="loadExportPreview">刷新预览</button><button class="jp-primary" :disabled="busy || !exportPreview?.memberCount" @click="doExport">预览并导出</button></div>
        </div>
        <div>
          <div class="jp-gedcom-preview-head"><span class="jp-panel-title" style="margin:0">文件预览</span><span class="jp-muted">{{ exportPreview?.memberCount ?? 0 }} 人 · {{ exportPreview?.familyCount ?? 0 }} 家庭 · {{ exportPreview?.photoCount ?? 0 }} 照片</span></div>
          <pre class="jp-gedcom-code">{{ exportPreview?.content || '正在生成预览…' }}</pre>
          <div v-if="exportPreview?.warnings.length" class="jp-confirm"><span v-for="warning in exportPreview.warnings" :key="warning">{{ warning }}</span></div>
          <div class="jp-muted" style="margin-top:8px">预览仅展示前 40 行；导出不会修改家谱数据。</div>
        </div>
      </div>
    </section>

    <Modal v-if="confirmImport" title="确认导入 GEDCOM" confirm-text="开始导入"
      :message="`将导入 ${preview?.validCount ?? 0} 名成员及其关系。错误记录不会写入，导入后可在最近批次中整批撤销。`"
      @confirm="doImport" @cancel="confirmImport = false" />
    <Modal v-if="undoTarget" title="撤销 GEDCOM 导入批次" danger confirm-text="确认撤销"
      :message="`将撤销「${undoTarget.sourceName}」导入的 ${undoTarget.successCount} 名成员、关系与照片。此操作不会删除手动新增的成员。`"
      @confirm="undoBatch" @cancel="undoTarget = null" />
  </div>
</template>
