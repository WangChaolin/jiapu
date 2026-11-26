<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, nextTick } from 'vue'
import { api } from '../api'
import { state, editMember, showMember, genName, toast, run } from '../store'
import { computeLayout, descendantSet, ancestorSet, NODE_W, NODE_H, type LayoutNode } from '../graph/layout'
import { describeDate, yearOf } from '@shared/lunar'
import type { GraphData, GraphOrientation, GraphPngOptions, MemberDetail } from '@shared/types'

const VB_W = 980, VB_H = 560
const data = ref<GraphData>({ members: [], edges: [] })
const view = ref<'all' | 'ancestors' | 'descendants'>('all')
const focusId = ref<string | null>(null)
const collapsed = reactive(new Set<string>())
const tf = reactive({ x: 0, y: 0, k: 1 })
const search = ref('')
const detail = ref<MemberDetail | null>(null)
const orientation = ref<GraphOrientation>('vertical')
const showPng = ref(false)
const pngBusy = ref(false)
const pngScope = ref<GraphPngOptions['scope']>('viewport')
const pngScale = ref<GraphPngOptions['scale']>(2)
const pngBackground = ref<GraphPngOptions['background']>('rice')
const pngLegend = ref(true)
const pngTitle = ref(true)
const pngTimestamp = ref(true)
const svgEl = ref<SVGSVGElement | null>(null)
const panning = ref(false)
let panStart = { x: 0, y: 0, tx: 0, ty: 0 }

const scope = computed<Set<string> | undefined>(() => {
  if (view.value === 'all' || !focusId.value) return undefined
  return view.value === 'descendants' ? descendantSet(data.value, focusId.value) : ancestorSet(data.value, focusId.value)
})
const layout = computed(() => computeLayout(data.value, collapsed, scope.value, orientation.value))
const activeId = computed(() => focusId.value)
const visibleIds = computed(() => layout.value.nodes.map((n) => n.id))
const pngViewBox = computed(() => ({ x: -tf.x / tf.k, y: -tf.y / tf.k, width: VB_W / tf.k, height: VB_H / tf.k }))
const pngDimensions = computed(() => {
  let width: number, height: number
  if (pngScope.value === 'viewport') {
    width = pngViewBox.value.width; height = pngViewBox.value.height
  } else if (layout.value.nodes.length) {
    const x = Math.min(...layout.value.nodes.map((n) => n.x)) - 30
    const y = Math.min(...layout.value.nodes.map((n) => n.y)) - 30
    width = Math.max(...layout.value.nodes.map((n) => n.x + n.w)) + 30 - x
    height = Math.max(...layout.value.nodes.map((n) => n.y + n.h)) + 30 - y
  } else { width = 200; height = 200 }
  return { width: Math.max(1, Math.round(width * pngScale.value)), height: Math.max(1, Math.round(height * pngScale.value)) }
})

function life(m: { birthDate: string; deathDate: string; alive: boolean }): string {
  const b = yearOf(m.birthDate), d = yearOf(m.deathDate)
  if (!b && !d) return ''
  return `${b ?? '?'}–${d ?? (m.alive ? '' : '?')}`
}
function fit(): void {
  const l = layout.value
  const k = Math.min(VB_W / l.width, VB_H / l.height, 1.4)
  tf.k = k
  tf.x = (VB_W - l.width * k) / 2
  tf.y = (VB_H - l.height * k) / 2
}
function centerOn(id: string): void {
  const n = layout.value.nodeMap.get(id)
  if (!n) return
  tf.k = Math.max(tf.k, 0.9)
  tf.x = VB_W / 2 - (n.x + NODE_W / 2) * tf.k
  tf.y = VB_H / 2 - (n.y + NODE_H / 2) * tf.k
}
async function selectNode(n: LayoutNode, dbl: boolean): Promise<void> {
  if (dbl) {
    if (collapsed.has(n.id)) collapsed.delete(n.id)
    else if (n.childCount > 0) collapsed.add(n.id)
    await nextTick()
    return
  }
  focusId.value = n.id
  detail.value = await api.member.get(n.id)
}
function setView(v: 'all' | 'ancestors' | 'descendants'): void {
  view.value = v
  if (v !== 'all' && !focusId.value && data.value.members.length) focusId.value = data.value.members[0].id
  nextTick(fit)
}
function setOrientation(value: GraphOrientation): void {
  orientation.value = value
  nextTick(fit)
}
async function exportPng(): Promise<void> {
  const current = state.current
  if (!current || pngBusy.value) return
  pngBusy.value = true
  const date = new Date().toISOString().slice(0, 10)
  const payload = {
    data: data.value,
    meta: current,
    opts: {
      orientation: orientation.value,
      scope: pngScope.value,
      scale: pngScale.value,
      background: pngBackground.value,
      legend: pngLegend.value,
      title: pngTitle.value,
      timestamp: pngTimestamp.value,
      visibleIds: visibleIds.value,
      viewBox: pngViewBox.value,
    },
  }
  const plain = JSON.parse(JSON.stringify(payload)) as typeof payload
  const file = await run(() => api.graph.savePng(plain, `${current.name}-图谱-${date}.png`))
  pngBusy.value = false
  if (file) { showPng.value = false; toast(`PNG 已导出：${file}`) }
}
function locate(): void {
  const q = search.value.trim()
  if (!q) return
  const m = data.value.members.find((x) => x.name.includes(q) || x.courtesyName.includes(q))
  if (!m) { toast(`未找到「${q}」`, 'err'); return }
  if (view.value !== 'all') view.value = 'all'
  focusId.value = m.id
  collapsed.clear()
  nextTick(() => { centerOn(m.id); api.member.get(m.id).then((d) => { detail.value = d }) })
}
function zoom(factor: number): void {
  const nk = Math.min(3, Math.max(0.1, tf.k * factor))
  const cx = VB_W / 2, cy = VB_H / 2
  tf.x = cx - (cx - tf.x) * (nk / tf.k)
  tf.y = cy - (cy - tf.y) * (nk / tf.k)
  tf.k = nk
}
function onWheel(e: WheelEvent): void {
  e.preventDefault()
  const rect = svgEl.value!.getBoundingClientRect()
  const mx = (e.clientX - rect.left) / rect.width * VB_W
  const my = (e.clientY - rect.top) / rect.height * VB_H
  const nk = Math.min(3, Math.max(0.1, tf.k * (e.deltaY < 0 ? 1.12 : 0.89)))
  tf.x = mx - (mx - tf.x) * (nk / tf.k)
  tf.y = my - (my - tf.y) * (nk / tf.k)
  tf.k = nk
}
function onDown(e: PointerEvent): void {
  panning.value = true
  panStart = { x: e.clientX, y: e.clientY, tx: tf.x, ty: tf.y }
  ;(e.target as Element).setPointerCapture?.(e.pointerId)
}
function onMove(e: PointerEvent): void {
  if (!panning.value) return
  const rect = svgEl.value!.getBoundingClientRect()
  const sx = VB_W / rect.width, sy = VB_H / rect.height
  tf.x = panStart.tx + (e.clientX - panStart.x) * sx
  tf.y = panStart.ty + (e.clientY - panStart.y) * sy
}
function onUp(): void { panning.value = false }

watch([() => layout.value.width, () => layout.value.height], () => nextTick(fit))
watch(() => state.graphFocusId, async (id) => {
  if (id) { focusId.value = id; view.value = 'all'; collapsed.clear(); await nextTick(); centerOn(id); detail.value = await api.member.get(id); state.graphFocusId = null }
})

onMounted(async () => {
  if (!state.current) return
  data.value = await api.graph.data()
  if (state.graphFocusId) { focusId.value = state.graphFocusId; state.graphFocusId = null }
  else if (data.value.members.length) focusId.value = data.value.members[0].id
  await nextTick()
  fit()
  if (focusId.value) { centerOn(focusId.value); detail.value = await api.member.get(focusId.value) }
})
</script>

<template>
  <div>
    <div class="jp-page-head">
      <h2 class="jp-page-title jp-serif-c">关系图谱</h2>
      <span class="jp-muted">点击节点查看详情 · 双击折叠 / 展开 · 虚线为过继 / 兼祧 · 滚轮缩放，拖拽平移</span>
    </div>
    <div class="jp-toolbar">
      <button :aria-pressed="view === 'all'" @click="setView('all')">全谱</button>
      <button :aria-pressed="view === 'ancestors'" @click="setView('ancestors')">祖先视图</button>
      <button :aria-pressed="view === 'descendants'" @click="setView('descendants')">后代视图</button>
      <span class="jp-toolbar-sep" aria-hidden="true"></span>
      <button :aria-pressed="orientation === 'vertical'" @click="setOrientation('vertical')">纵向树</button>
      <button :aria-pressed="orientation === 'horizontal'" @click="setOrientation('horizontal')">横向树</button>
      <span style="flex:1"></span>
      <input v-model="search" type="search" placeholder="输入姓名定位" aria-label="图谱搜索定位" style="width:160px" @keydown.enter="locate">
      <button @click="locate">定位</button>
      <button aria-label="缩小" @click="zoom(0.85)">－</button>
      <button aria-label="放大" @click="zoom(1.18)">＋</button>
      <button @click="fit">适应</button>
      <button class="jp-primary" @click="showPng = true">导出 PNG</button>
    </div>
    <div class="jp-graph-wrap">
      <svg ref="svgEl" :viewBox="`0 0 ${VB_W} ${VB_H}`" :class="{ 'jp-panning': panning }" role="img" aria-label="世系图谱"
        @wheel="onWheel" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointerleave="onUp">
        <g :transform="`translate(${tf.x} ${tf.y}) scale(${tf.k})`">
          <path v-for="e in layout.edges" :key="e.id" :d="e.path"
            :class="['jp-gedge', e.kind === 'dashed' ? 'jp-gedge-dashed' : '', e.kind === 'spouseCross' ? 'jp-gedge-dashed' : '']" />
          <g v-for="n in layout.nodes" :key="n.id"
            :class="['jp-gnode', n.member.gender === '女' ? 'jp-female' : '', n.role === 'spouse' ? 'jp-spouse' : '', activeId === n.id ? 'jp-active' : '']"
            @pointerdown.stop @click.stop="selectNode(n, false)" @dblclick.stop="selectNode(n, true)">
            <rect :x="n.x" :y="n.y" :width="n.w" :height="n.h" rx="4" />
            <text :x="n.x + n.w / 2" :y="n.y + 17" text-anchor="middle">{{ n.member.name }}</text>
            <text class="jp-gsub" :x="n.x + n.w / 2" :y="n.y + 32" text-anchor="middle">{{ life(n.member) }}</text>
            <text v-if="n.member.gender === '女'" class="jp-gtag" :x="n.x + 5" :y="n.y + 12">女</text>
            <text v-if="n.collapsed" class="jp-gcollapse" :x="n.x + n.w - 4" :y="n.y + 12" text-anchor="end">+{{ n.hiddenCount }}</text>
          </g>
        </g>
      </svg>
    </div>
    <div class="jp-legend">
      <span><i></i>血缘世系</span>
      <span><i class="jp-lg-dash"></i>过继 / 兼祧</span>
      <span><i class="jp-lg-marry"></i>配偶</span>
      <span><i class="jp-lg-female"></i>女性成员（可延续世系）</span>
      <span class="jp-muted">共 {{ layout.nodes.length }} 节点 · {{ view === 'all' ? '全谱' : view === 'ancestors' ? '祖先' : '后代' }}视图</span>
    </div>
    <div class="jp-panel" style="margin-top:12px">
      <div class="jp-panel-title">节点详情</div>
      <div v-if="!detail" class="jp-muted">点击图谱节点查看成员详情。</div>
      <div v-else aria-live="polite">
        <div class="jp-detail-name">{{ detail.name }}
          <span :class="detail.gender === '女' ? 'jp-badge jp-badge-blue' : 'jp-badge'">{{ detail.gender }}</span>
          <span class="jp-badge jp-badge-accent">{{ genName(detail.generation) }}</span>
        </div>
        <p class="jp-muted" style="margin-top:6px">{{ describeDate(detail.birthDate, detail.birthLunar).primary }}<template v-if="detail.deathDate"> · {{ describeDate(detail.deathDate, detail.deathLunar).primary }}</template></p>
        <p v-if="detail.parents.length" style="margin-top:4px"><span class="jp-muted">父母：</span>{{ detail.parents.map(p => `${p.subtype} ${p.otherName}`).join(' · ') }}</p>
        <p v-if="detail.spouses.length" style="margin-top:4px"><span class="jp-muted">配偶：</span>{{ detail.spouses.map(s => `${s.subtype} ${s.otherName}`).join(' · ') }}</p>
        <p v-if="detail.children.length" style="margin-top:4px"><span class="jp-muted">子女：</span>{{ detail.children.map(c => c.otherName).join(' · ') }}</p>
        <div class="jp-detail-actions">
          <button class="jp-primary" @click="editMember(detail.id)">编辑</button>
          <button @click="showMember(detail.id)">成员管理</button>
          <button @click="setView('descendants')">后代视图</button>
        </div>
      </div>
    </div>

    <div v-if="showPng" class="jp-modal-mask" @click.self="showPng = false">
      <div class="jp-op-dialog" role="dialog" aria-modal="true" aria-label="导出图谱 PNG">
        <div class="proto-dialog-head"><h3>导出关系图谱 PNG</h3><button aria-label="关闭" @click="showPng = false">×</button></div>
        <p class="jp-muted">导出当前{{ orientation === 'vertical' ? '纵向' : '横向' }}布局，节点与关系均为矢量绘制后栅格化。</p>
        <div class="jp-form-row" style="margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <label class="jp-field"><span>导出范围</span>
            <select v-model="pngScope"><option value="viewport">当前视口</option><option value="visible">全部可见节点</option></select>
          </label>
          <label class="jp-field"><span>导出倍率</span>
            <select v-model.number="pngScale"><option :value="1">1× 标准</option><option :value="2">2× 清晰</option><option :value="4">4× 高清</option></select>
          </label>
        </div>
        <div class="jp-field" style="margin-top:12px"><span>背景</span>
          <div class="jp-skin-cards">
            <button v-for="bg in [{value:'white',label:'纯白'},{value:'rice',label:'宣纸色'},{value:'transparent',label:'透明'}]" :key="bg.value"
              class="jp-skin-card" :aria-pressed="pngBackground === bg.value" @click="pngBackground = bg.value as GraphPngOptions['background']">
              <i class="jp-png-bg" :class="`jp-png-bg-${bg.value}`"></i><b>{{ bg.label }}</b>
            </button>
          </div>
        </div>
        <div class="jp-form-row" style="margin-top:14px;gap:16px;flex-wrap:wrap">
          <label><input v-model="pngTitle" type="checkbox">谱名标题</label>
          <label><input v-model="pngLegend" type="checkbox">关系图例</label>
          <label><input v-model="pngTimestamp" type="checkbox">导出时间</label>
        </div>
        <div class="proto-impact">
          <div><strong>{{ visibleIds.length }}</strong><span>可见节点</span></div>
          <div><strong>{{ pngScale }}×</strong><span>导出倍率</span></div>
          <div><strong>{{ pngDimensions.width.toLocaleString() }}</strong><span>宽度（像素）</span></div>
          <div><strong>{{ pngDimensions.height.toLocaleString() }}</strong><span>高度（像素）</span></div>
        </div>
        <p v-if="pngDimensions.width > 32767 || pngDimensions.height > 32767 || pngDimensions.width * pngDimensions.height > 67108864" class="jp-warning">
          当前尺寸超过 PNG 安全上限，请选择更小范围或倍率。
        </p>
        <div class="proto-warning">透明背景适合嵌入文档；宣纸色更接近传统谱牒质感。导出不会修改家谱数据。</div>
        <div class="proto-dialog-actions"><button @click="showPng = false">取消</button><button class="jp-primary" :disabled="pngBusy || pngDimensions.width > 32767 || pngDimensions.height > 32767 || pngDimensions.width * pngDimensions.height > 67108864" @click="exportPng">{{ pngBusy ? '正在生成…' : '选择位置并导出' }}</button></div>
      </div>
    </div>
  </div>
</template>