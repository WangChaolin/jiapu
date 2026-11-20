<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, nextTick } from 'vue'
import { api } from '../api'
import { state, editMember, showMember, genName, toast } from '../store'
import { computeLayout, descendantSet, ancestorSet, NODE_W, NODE_H, type LayoutNode } from '../graph/layout'
import { describeDate, yearOf } from '@shared/lunar'
import type { GraphData, MemberDetail } from '@shared/types'

const VB_W = 980, VB_H = 560
const data = ref<GraphData>({ members: [], edges: [] })
const view = ref<'all' | 'ancestors' | 'descendants'>('all')
const focusId = ref<string | null>(null)
const collapsed = reactive(new Set<string>())
const tf = reactive({ x: 0, y: 0, k: 1 })
const search = ref('')
const detail = ref<MemberDetail | null>(null)
const svgEl = ref<SVGSVGElement | null>(null)
const panning = ref(false)
let panStart = { x: 0, y: 0, tx: 0, ty: 0 }

const scope = computed<Set<string> | undefined>(() => {
  if (view.value === 'all' || !focusId.value) return undefined
  return view.value === 'descendants' ? descendantSet(data.value, focusId.value) : ancestorSet(data.value, focusId.value)
})
const layout = computed(() => computeLayout(data.value, collapsed, scope.value))
const activeId = computed(() => focusId.value)

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

watch(() => layout.value.width, () => nextTick(fit))
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
      <span style="flex:1"></span>
      <input v-model="search" type="search" placeholder="输入姓名定位" aria-label="图谱搜索定位" style="width:160px" @keydown.enter="locate">
      <button @click="locate">定位</button>
      <button aria-label="缩小" @click="zoom(0.85)">－</button>
      <button aria-label="放大" @click="zoom(1.18)">＋</button>
      <button @click="fit">适应</button>
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
  </div>
</template>