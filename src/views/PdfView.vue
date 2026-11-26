<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { api } from '../api'
import { state, run, toast } from '../store'
import { buildPrintHtml, ROSTER_FIELD_DEFS, type PrintOptions, type LayoutKind, type Scope, type RosterField, type RosterSort } from '../print/build'
import type { Branch, GraphData, ZibeiPoem } from '@shared/types'

const LAYOUTS: { key: LayoutKind; name: string; desc: string }[] = [
  { key: 'baota', name: '宝塔式吊线图', desc: '世系自上而下如宝塔展开，配偶并列，兼祧虚线标注' },
  { key: 'oushi', name: '欧式横表 · 五世一表', desc: '表格横排，每表五代，表间世代衔接，适合世系总览' },
  { key: 'sushi', name: '苏式垂珠体 · 竖排', desc: '竖排右起，世代为列、人名为珠，传统线装书风格' },
  { key: 'biography', name: '人物传记式', desc: '一人一篇，详载亲缘、生平与照片，长文自动续页' },
  { key: 'roster', name: '名录简表式', desc: '一行一人，字段与排序可选，跨页重复表头' },
]

const ROSTER_SORTS: { key: RosterSort; label: string }[] = [
  { key: 'generation', label: '世代' }, { key: 'birthOrder', label: '行第' },
  { key: 'name', label: '姓名' }, { key: 'branch', label: '支系' },
]

const data = ref<GraphData>({ members: [], edges: [] })
const branches = ref<Branch[]>([])
const zibei = ref<ZibeiPoem[]>([])
const allGens = ref<number[]>([])
const previewHtml = ref('')
const summary = ref('')
const exporting = ref(false)
const building = ref(false)

const opts = reactive<PrintOptions>({
  layout: 'oushi', scope: { kind: 'all' }, paper: 'A4', landscape: false,
  font: '宋体', fontSize: '小四', cover: true, toc: true, zibeiPage: true,
  rosterFields: ['name', 'gender', 'generation', 'branch', 'years'], rosterSort: 'generation',
})
const scopeMode = ref<'all' | 'branch' | 'gen' | 'members'>('all')
const scopeBranch = ref('')
const genFrom = ref(1)
const genTo = ref(5)
const selectedMemberIds = ref<string[]>([])
const memberKeyword = ref('')

const meta = computed(() => state.current)
const orient = computed({
  get: () => (opts.landscape ? 'landscape' : 'portrait'),
  set: (v: string) => { opts.landscape = v === 'landscape' },
})
const genOptions = computed(() => (allGens.value.length ? allGens.value : [1, 2, 3, 4, 5, 6, 7]))
const branchNames = computed(() => new Map(branches.value.map((b) => [b.id, b.name])))
const memberOptions = computed(() => [...data.value.members]
  .sort((a, b) => a.generation - b.generation || a.birthOrder - b.birthOrder || a.name.localeCompare(b.name, 'zh'))
  .map((m) => ({ id: m.id, label: `${m.name} · ${m.generation} 世${m.branchId ? ` · ${branchNames.value.get(m.branchId) ?? '未命名支系'}` : ''}` })))
const filteredMemberOptions = computed(() => {
  const q = memberKeyword.value.trim().toLowerCase()
  return q ? memberOptions.value.filter((m) => m.label.toLowerCase().includes(q)) : memberOptions.value
})
const canExport = computed(() => data.value.members.length > 0 && (scopeMode.value !== 'members' || selectedMemberIds.value.length > 0))

function currentScope(): Scope {
  if (scopeMode.value === 'branch' && scopeBranch.value) return { kind: 'branch', branchId: scopeBranch.value }
  if (scopeMode.value === 'gen') return { kind: 'gen', from: Math.min(genFrom.value, genTo.value), to: Math.max(genFrom.value, genTo.value) }
  if (scopeMode.value === 'members') return { kind: 'members', memberIds: [...selectedMemberIds.value] }
  return { kind: 'all' }
}
function toggleRosterField(field: RosterField): void {
  const i = opts.rosterFields.indexOf(field)
  if (i >= 0) {
    if (opts.rosterFields.length === 1) return
    opts.rosterFields.splice(i, 1)
  } else opts.rosterFields.push(field)
}
function selectVisibleMembers(): void {
  const selected = new Set(selectedMemberIds.value)
  filteredMemberOptions.value.forEach((m) => selected.add(m.id))
  selectedMemberIds.value = [...selected]
}
function rebuild(): void {
  if (!meta.value) return
  building.value = true
  const r = buildPrintHtml(data.value, meta.value, branches.value, zibei.value, { ...opts, scope: currentScope() }, true)
  previewHtml.value = r.html
  summary.value = r.summary
  building.value = false
}
let timer: ReturnType<typeof setTimeout> | undefined
function scheduleRebuild(): void { clearTimeout(timer); timer = setTimeout(rebuild, 280) }

async function exportPdf(): Promise<void> {
  if (!meta.value) return
  exporting.value = true
  const label = LAYOUTS.find((l) => l.key === opts.layout)!.name
  const dataDir = state.appInfo?.dataDir
  const photoDir = dataDir ? `${dataDir}${/[\\/]$/.test(dataDir) ? '' : '/'}${meta.value.id}` : undefined
  const payload = { data: data.value, meta: meta.value, branches: branches.value, zibei: zibei.value, photoDir, opts: { ...opts, scope: currentScope() } }
  const plain = JSON.parse(JSON.stringify(payload)) as typeof payload
  const file = await run(() => api.pdf.save(plain, `${meta.value!.name}_${label}`))
  exporting.value = false
  if (file) toast(`已导出 PDF：${file}`)
}

async function loadAll(): Promise<void> {
  if (!state.current) return
  data.value = await api.graph.data()
  branches.value = await api.branch.list()
  zibei.value = await api.zibei.list()
  allGens.value = await api.member.generations()
  const validIds = new Set(data.value.members.map((m) => m.id))
  selectedMemberIds.value = selectedMemberIds.value.filter((id) => validIds.has(id))
  if (allGens.value.length) { genFrom.value = allGens.value[0]; genTo.value = Math.min(allGens.value[0] + 4, allGens.value[allGens.value.length - 1]) }
  rebuild()
}

watch(scopeMode, (m) => { if (m === 'branch' && !scopeBranch.value && branches.value.length) scopeBranch.value = branches.value[0].id; scheduleRebuild() })
watch([scopeBranch, genFrom, genTo, selectedMemberIds], scheduleRebuild, { deep: true })
watch(opts, scheduleRebuild, { deep: true })
watch(() => state.tick, loadAll)
onMounted(loadAll)
</script>

<template>
  <div>
    <div class="jp-page-head">
      <h2 class="jp-page-title jp-serif-c">导出 PDF</h2>
      <span class="jp-muted">五种排版 · 导出前可预览 · 男女同等入谱</span>
    </div>
    <div class="jp-layout-cards">
      <button v-for="l in LAYOUTS" :key="l.key" class="jp-layout-card" :aria-pressed="opts.layout === l.key" @click="opts.layout = l.key">
        <span class="jp-layout-name jp-serif-c">{{ l.name }}</span>
        <span class="jp-layout-desc">{{ l.desc }}</span>
      </button>
    </div>
    <div class="jp-split jp-split-pdf">
      <div class="jp-panel">
        <div class="jp-panel-title">导出设置</div>
        <div class="jp-form-row">
          <div class="jp-field"><span>导出范围</span>
            <select v-model="scopeMode" aria-label="导出范围">
              <option value="all">整谱（{{ data.members.length }} 人）</option>
              <option value="branch">按支系</option>
              <option value="gen">世代区间</option>
              <option value="members">勾选成员（{{ selectedMemberIds.length }} 人）</option>
            </select>
          </div>
        </div>
        <div v-if="scopeMode === 'branch'" class="jp-form-row">
          <div class="jp-field"><span>选择支系</span>
            <select v-model="scopeBranch" aria-label="选择支系">
              <option v-for="b in branches" :key="b.id" :value="b.id">{{ b.name }}（{{ b.memberCount }} 人）</option>
            </select>
          </div>
        </div>
        <div v-if="scopeMode === 'gen'" class="jp-form-row">
          <div class="jp-field"><span>起始世代</span>
            <select v-model.number="genFrom" aria-label="起始世代"><option v-for="g in genOptions" :key="g" :value="g">{{ g }} 世</option></select>
          </div>
          <div class="jp-field"><span>结束世代</span>
            <select v-model.number="genTo" aria-label="结束世代"><option v-for="g in genOptions" :key="g" :value="g">{{ g }} 世</option></select>
          </div>
        </div>
        <div v-if="scopeMode === 'members'" class="jp-form-row">
          <div class="jp-field" style="width:100%"><span>勾选成员</span>
            <input v-model="memberKeyword" type="search" placeholder="搜索姓名或支系" aria-label="搜索待勾选成员">
            <select v-model="selectedMemberIds" multiple size="8" aria-label="勾选导出成员" style="width:100%;margin-top:6px">
              <option v-for="m in filteredMemberOptions" :key="m.id" :value="m.id">{{ m.label }}</option>
            </select>
            <div style="display:flex;gap:8px;margin-top:6px">
              <button type="button" @click="selectVisibleMembers">全选当前筛选</button>
              <button type="button" @click="selectedMemberIds = []">清空</button>
              <span class="jp-muted" style="margin-left:auto">已选 {{ selectedMemberIds.length }} 人</span>
            </div>
          </div>
        </div>
        <div v-if="opts.layout === 'roster'" class="jp-form-row">
          <div class="jp-field" style="width:100%"><span>名录字段</span>
            <div style="display:flex;flex-wrap:wrap;gap:8px 14px;margin-top:6px">
              <label v-for="f in ROSTER_FIELD_DEFS" :key="f.key">
                <input type="checkbox" :checked="opts.rosterFields.includes(f.key)" @change="toggleRosterField(f.key)">{{ f.label }}
              </label>
            </div>
          </div>
        </div>
        <div v-if="opts.layout === 'roster'" class="jp-form-row">
          <div class="jp-field"><span>排序方式</span>
            <select v-model="opts.rosterSort" aria-label="名录排序方式">
              <option v-for="s in ROSTER_SORTS" :key="s.key" :value="s.key">按{{ s.label }}</option>
            </select>
          </div>
        </div>
        <div class="jp-form-row">
          <div class="jp-field"><span>纸张</span>
            <select v-model="opts.paper" aria-label="纸张"><option>A4</option><option>A3</option><option>B5</option><option>Letter</option></select>
          </div>
          <div class="jp-field"><span>方向</span>
            <select v-model="orient" aria-label="方向"><option value="portrait">纵向</option><option value="landscape">横向</option></select>
          </div>
        </div>
        <div class="jp-form-row">
          <div class="jp-field"><span>正文字体</span>
            <select v-model="opts.font" aria-label="正文字体"><option>宋体</option><option>楷体</option><option>黑体</option></select>
          </div>
          <div class="jp-field"><span>字号</span>
            <select v-model="opts.fontSize" aria-label="字号"><option>小四</option><option>五号</option><option>小五</option></select>
          </div>
        </div>
        <div class="jp-form-row" style="gap:14px">
          <label><input v-model="opts.cover" type="checkbox">封面</label>
          <label><input v-model="opts.toc" type="checkbox">目录</label>
          <label><input v-model="opts.zibeiPage" type="checkbox">字辈对照页</label>
        </div>
        <p class="jp-muted" aria-live="polite" style="margin:10px 0">{{ summary }}</p>
        <div class="jp-detail-actions">
          <button class="jp-primary" :disabled="exporting || !canExport" @click="exportPdf">{{ exporting ? '导出中…' : '导出 PDF' }}</button>
          <button :disabled="building" @click="rebuild">刷新预览</button>
        </div>
        <p class="jp-muted" style="margin-top:10px">导出内嵌系统字体（宋体/楷体/黑体）的矢量 PDF，不依赖打印机驱动；繁体标题与竖排为传统谱书样式。</p>
      </div>
      <div>
        <div class="jp-muted" style="margin-bottom:6px">排版预览{{ building ? ' · 生成中…' : '' }}</div>
        <iframe class="jp-preview-frame" :srcdoc="previewHtml" title="排版预览" sandbox="allow-same-origin"></iframe>
      </div>
    </div>
  </div>
</template>
