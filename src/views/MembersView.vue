<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, nextTick } from 'vue'
import { api } from '../api'
import { state, editMember, locateInGraph, toast, run, genName, refreshStats, bump } from '../store'
import { branchName, makeZibeiResolver, zibeiMatch } from '../utils'
import { describeDate } from '@shared/lunar'
import type { Branch, DuplicateMemberGroup, Member, MemberDetail, MergeField, ZibeiPoem } from '@shared/types'
import Modal from '../components/Modal.vue'

const rows = ref<Member[]>([])
const details = ref<Map<string, MemberDetail>>(new Map())
const total = ref(0)
const page = ref(0)
const pageSize = 100
const keyword = ref('')
const fBranch = ref('')
const fGen = ref('')
const fGender = ref('')
const aliveOnly = ref(false)
const branches = ref<Branch[]>([])
const poems = ref<ZibeiPoem[]>([])
const focusId = ref<string | null>(null)
const delTarget = ref<Member | null>(null)
const loading = ref(false)
const bioExpanded = ref<Set<string>>(new Set())
const showDuplicates = ref(false)
const scanning = ref(false)
const duplicateGroups = ref<DuplicateMemberGroup[]>([])
const selectedGroupId = ref('')
const merging = ref(false)
const confirmMerge = ref(false)
const mergeTextFields = ref(true)
const fieldSources = reactive<Record<string, string>>({})

const mergeFields: { key: MergeField; label: string }[] = [
  { key: 'name', label: '姓名' }, { key: 'gender', label: '性别' },
  { key: 'generation', label: '世代' }, { key: 'branchId', label: '支系' },
  { key: 'birthDate', label: '出生日期' }, { key: 'deathDate', label: '逝世日期' },
  { key: 'courtesyName', label: '字 / 号' }, { key: 'title', label: '称谓' },
  { key: 'occupation', label: '职业' }, { key: 'residence', label: '居所' },
  { key: 'burial', label: '葬地' }, { key: 'biography', label: '生平' },
  { key: 'remark', label: '备注' }, { key: 'photoPath', label: '照片' },
]
const selectedGroup = computed(() => duplicateGroups.value.find((g) => g.id === selectedGroupId.value) ?? null)

const resolver = computed(() => makeZibeiResolver(poems.value, branches.value))
const allGens = ref<number[]>([])
const surname = computed(() => state.current?.surname ?? '')
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))

async function loadMeta(): Promise<void> {
  if (!state.current) return
  branches.value = await api.branch.list()
  poems.value = await api.zibei.list()
  allGens.value = await api.member.generations()
}
let loadToken = 0
let jumpGuard = false
let kwTimer: ReturnType<typeof setTimeout> | undefined
async function load(): Promise<void> {
  if (!state.current) return
  const token = ++loadToken
  loading.value = true
  const r = await api.member.list({
    keyword: keyword.value.trim() || undefined,
    branchId: fBranch.value || undefined,
    generation: fGen.value ? parseInt(fGen.value, 10) : undefined,
    gender: fGender.value || undefined,
    aliveOnly: aliveOnly.value || undefined,
    limit: pageSize, offset: page.value * pageSize,
  })
  if (token !== loadToken) return
  rows.value = r.rows
  total.value = r.total
  const ds = await api.member.getMany(r.rows.map((m) => m.id))
  if (token !== loadToken) return
  details.value = new Map(ds.map((d) => [d.id, d]))
  loading.value = false
}
function dOf(id: string): MemberDetail | undefined { return details.value.get(id) }
function zibeiOf(m: Member): { char: string | null; status: string } {
  const char = resolver.value(m.generation, m.branchId)
  return { char, status: zibeiMatch(m.name, surname.value, char) }
}
async function focusMember(id: string, scroll = true): Promise<void> {
  focusId.value = id
  if (scroll) {
    await nextTick()
    document.getElementById('jp-member-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
}
async function jumpTo(id: string): Promise<void> {
  if (rows.value.some((m) => m.id === id)) { await focusMember(id); return }
  jumpGuard = true
  clearTimeout(kwTimer)
  keyword.value = ''; fBranch.value = ''; fGen.value = ''; fGender.value = ''; aliveOnly.value = false
  const all = await api.member.list({ limit: 1000000, offset: 0 })
  const i = all.rows.findIndex((m) => m.id === id)
  jumpGuard = false
  if (i < 0) { toast('该成员不在当前家谱中', 'err'); return }
  page.value = Math.floor(i / pageSize)
  await load()
  await focusMember(id)
}
function toggleBio(id: string): void {
  const s = new Set(bioExpanded.value)
  if (s.has(id)) s.delete(id); else s.add(id)
  bioExpanded.value = s
}
async function scanDuplicates(): Promise<void> {
  if (!state.current) return
  scanning.value = true
  const groups = await run(() => api.member.duplicates())
  if (groups) {
    duplicateGroups.value = groups
    selectedGroupId.value = groups[0]?.id ?? ''
    selectDuplicateGroup()
  }
  scanning.value = false
}
async function toggleDuplicates(): Promise<void> {
  showDuplicates.value = !showDuplicates.value
  if (showDuplicates.value) await scanDuplicates()
}
function selectDuplicateGroup(): void {
  const g = selectedGroup.value
  for (const key of Object.keys(fieldSources)) delete fieldSources[key]
  if (!g) return
  for (const m of g.members) fieldSources[m.id] = m.id
  mergeTextFields.value = true
}
function fieldValue(m: MemberDetail, key: MergeField): string {
  const v = m[key]
  if (key === 'generation') return genName(m.generation)
  if (key === 'branchId') return branchName(branches.value, m.branchId)
  if (key === 'birthDate') return describeDate(m.birthDate, m.birthLunar).primary
  if (key === 'deathDate') return describeDate(m.deathDate, m.deathLunar).primary
  if (key === 'photoPath') return m.photoPath ? '有照片' : '无照片'
  if (typeof v === 'boolean') return v ? '是' : '否'
  return v == null || v === '' ? '—' : String(v)
}
async function mergeSelected(): Promise<void> {
  const g = selectedGroup.value
  if (!g || merging.value) return
  merging.value = true
  const target = g.members[0]
  const sources = Object.fromEntries(
    mergeFields.map(({ key }) => [key, fieldSources[key] ?? target.id]),
  ) as Partial<Record<MergeField, string>>
  if (sources.birthDate) sources.birthLunar = sources.birthDate
  if (sources.deathDate) sources.deathLunar = sources.deathDate
  const r = await run(() => api.member.merge({
    targetId: target.id,
    sourceIds: g.members.slice(1).map((m) => m.id),
    fieldSources: sources,
    mergeTextFields: mergeTextFields.value,
  }))
  merging.value = false
  confirmMerge.value = false
  if (!r) return
  await scanDuplicates()
  await load(); await refreshStats(); bump()
  toast(`已合并 ${g.members.length} 条成员记录，关系已归并`, 'info', {
    label: '撤销',
    fn: async () => {
      const ok = await run(() => api.operation.undo(r.operationId))
      if (ok) { await scanDuplicates(); await load(); await refreshStats(); bump(); toast('成员合并已撤销') }
    },
  })
}
async function doDelete(): Promise<void> {
  const m = delTarget.value
  delTarget.value = null
  if (!m) return
  const r = await run(() => api.member.delete(m.id))
  if (r) {
    if (focusId.value === m.id) focusId.value = null
    await load(); await refreshStats(); bump()
    toast(`已删除「${m.name}」`, 'info', {
      label: '撤销',
      fn: async () => { await api.member.restore(m.id); await load(); await refreshStats(); bump(); toast(`已恢复「${m.name}」`) },
    })
  }
}
watch(keyword, () => { if (jumpGuard) return; clearTimeout(kwTimer); kwTimer = setTimeout(() => { page.value = 0; load() }, 250) })
watch([fBranch, fGen, fGender, aliveOnly], () => { if (jumpGuard) return; page.value = 0; load() })
watch(page, () => { if (jumpGuard) return; load() })
watch(() => state.tick, async () => { if (!state.current) return; await loadMeta(); await load() })

onMounted(async () => {
  await loadMeta()
  await load()
  if (state.memberFocusId) { const id = state.memberFocusId; state.memberFocusId = null; await jumpTo(id) }
  else if (rows.value.length) focusMember(rows.value[0].id, false)
})
</script>

<template>
  <div>
    <div class="jp-page-head">
      <div>
        <h2 class="jp-page-title jp-serif-c">成员管理</h2>
        <span class="jp-muted">共 {{ total }} 人 · 男女平等录入，女性可延续世系</span>
      </div>
      <div class="jp-head-actions">
        <button @click="toggleDuplicates">{{ showDuplicates ? '返回成员列表' : '查重与合并' }}</button>
        <button class="jp-primary" @click="editMember(null)">＋ 录入成员</button>
      </div>
    </div>

    <section v-if="showDuplicates" class="proto-duplicates" aria-label="成员查重">
      <div class="proto-head-actions">
        <div>
          <h3 class="jp-serif-c">成员查重</h3>
          <p class="jp-muted">仅按姓名完全一致筛选，并结合出生日期、父母、配偶等信息提示；合并前请逐字段确认，操作可撤销。</p>
        </div>
        <button class="jp-primary" :disabled="scanning" @click="scanDuplicates">{{ scanning ? '扫描中…' : '重新扫描' }}</button>
      </div>
      <div class="proto-mini-stats">
        <div><strong>{{ duplicateGroups.length }}</strong><span>疑似重复组</span></div>
        <div><strong>{{ duplicateGroups.reduce((n, g) => n + g.members.length, 0) }}</strong><span>涉及成员</span></div>
        <div><strong>{{ duplicateGroups.filter((g) => g.score >= 85).length }}</strong><span>高置信度</span></div>
      </div>
      <div v-if="!duplicateGroups.length && !scanning" class="jp-empty">
        <div class="jp-empty-seal">清</div>未发现疑似重复成员
      </div>
      <div v-else class="proto-duplicate-grid">
        <aside class="proto-group-list" aria-label="重复组">
          <button v-for="g in duplicateGroups" :key="g.id" class="proto-group"
            :class="{ active: g.id === selectedGroupId }" @click="selectedGroupId = g.id; selectDuplicateGroup()">
            <span class="proto-score">{{ Math.round(g.score) }}</span>
            <span><strong>{{ g.members.map((m) => m.name).join(' / ') }}</strong><small>{{ g.reasons.join(' · ') }}</small></span>
          </button>
        </aside>
        <div v-if="selectedGroup" class="proto-compare-panel">
          <div class="proto-compare-head">
            <div><h4 class="jp-serif-c">{{ selectedGroup.members.map((m) => m.name).join(' · ') }}</h4><p class="jp-muted">首条记录保留，其余记录转为撤销快照</p></div>
            <span class="jp-badge jp-badge-gold">相似度 {{ Math.round(selectedGroup.score) }}%</span>
          </div>
          <div class="proto-person-cards" :style="{ gridTemplateColumns: `repeat(${selectedGroup.members.length}, minmax(0, 1fr))` }">
            <article v-for="(m, i) in selectedGroup.members" :key="m.id" class="proto-person-card">
              <span class="jp-badge" :class="i === 0 ? 'jp-badge-accent' : ''">{{ i === 0 ? '保留' : '合并' }}</span>
              <img v-if="m.photoPath" :src="`jpimg://${state.current?.id}/${m.photoPath}`" alt="">
              <div v-else class="proto-person-avatar">{{ m.name.slice(0, 1) }}</div>
              <strong>{{ m.name }}</strong>
              <span class="jp-muted">{{ genName(m.generation) }} · {{ m.gender }} · {{ branchName(branches, m.branchId) }}</span>
              <small>{{ describeDate(m.birthDate, m.birthLunar).primary }} — {{ describeDate(m.deathDate, m.deathLunar).primary }}</small>
              <small>{{ m.parents.map((p) => p.subtype + ' ' + p.otherName).join('；') || '父母未详' }}</small>
            </article>
          </div>
          <div class="proto-choice-table">
            <div v-for="f in mergeFields" :key="f.key" class="proto-choice-row">
              <strong>{{ f.label }}</strong>
              <div class="proto-choice-values" :style="{ gridTemplateColumns: `repeat(${selectedGroup.members.length}, minmax(0, 1fr))` }">
                <label v-for="m in selectedGroup.members" :key="m.id" class="proto-choice">
                  <input type="radio" :name="`merge-${f.key}`" :value="m.id" v-model="fieldSources[f.key]">
                  <span>{{ fieldValue(m, f.key) }}</span>
                </label>
              </div>
            </div>
          </div>
          <div class="proto-merge-footer">
            <label class="jp-muted"><input type="checkbox" v-model="mergeTextFields">生平与备注取并集并去除重复段落</label>
            <button class="jp-primary" :disabled="merging || selectedGroup.members.length < 2" @click="confirmMerge = true">确认合并 {{ selectedGroup.members.length }} 条记录</button>
          </div>
        </div>
      </div>
    </section>

    <template v-else>
    <div class="jp-toolbar">
      <input v-model="keyword" type="search" placeholder="姓名 / 字号 / 称谓" aria-label="搜索成员" style="width:180px">
      <select v-model="fBranch" aria-label="按支系筛选">
        <option value="">全部支系</option>
        <option v-for="b in branches" :key="b.id" :value="b.id">{{ b.name }}</option>
      </select>
      <select v-model="fGen" aria-label="按世代筛选">
        <option value="">全部世代</option>
        <option v-for="g in allGens" :key="g" :value="String(g)">{{ genName(g) }}</option>
      </select>
      <select v-model="fGender" aria-label="按性别筛选">
        <option value="">全部性别</option><option>男</option><option>女</option><option>其他</option>
      </select>
      <label class="jp-muted"><input type="checkbox" v-model="aliveOnly">仅在世</label>
      <span style="flex:1"></span>
    </div>

    <div v-if="!rows.length && !loading" class="jp-empty"><div class="jp-empty-seal">谱</div>暂无成员，点击「录入成员」开始</div>

    <div class="jp-member-list" aria-label="成员列表">
      <article v-for="m in rows" :key="m.id" :id="'jp-member-' + m.id"
        class="jp-member-card" :class="{ 'jp-focused': focusId === m.id }" @click="focusMember(m.id, false)">
        <div class="jp-mc-head">
          <div class="jp-mc-seal" :class="{ 'jp-female': m.gender === '女' }" aria-hidden="true">{{ genName(m.generation) }}</div>
          <img v-if="m.photoPath" class="jp-mc-photo" :src="`jpimg://${state.current?.id}/${m.photoPath}`" alt="">
          <div class="jp-mc-id">
            <div class="jp-mc-name">
              <span>{{ m.name }}</span>
              <span v-if="m.courtesyName" class="jp-muted">{{ m.courtesyName }}</span>
              <span :class="m.gender === '女' ? 'jp-badge jp-badge-blue' : 'jp-badge'">{{ m.gender }}</span>
            </div>
            <div class="jp-mc-tags">
              <span class="jp-badge jp-badge-accent">{{ genName(m.generation) }}</span>
              <span v-if="zibeiOf(m).char" :class="zibeiOf(m).status === 'mismatch' ? 'jp-badge jp-badge-gold' : 'jp-badge'">字辈 {{ zibeiOf(m).char }}</span>
              <span class="jp-badge">{{ branchName(branches, m.branchId) }}</span>
              <span v-if="m.title" class="jp-badge">{{ m.title }}</span>
              <span :class="m.alive ? 'jp-badge jp-badge-green' : 'jp-badge'">{{ m.alive ? '在世' : '已故' }}</span>
            </div>
          </div>
          <div class="jp-mc-actions" @click.stop>
            <button class="jp-primary" @click="editMember(m.id)">编辑</button>
            <button @click="locateInGraph(m.id)">图谱定位</button>
            <button class="jp-danger" @click="delTarget = m">删除</button>
          </div>
        </div>
        <div class="jp-mc-body">
          <section class="jp-mc-sec">
            <h4>生卒</h4>
            <p v-if="m.birthDate"><span class="jp-mc-k">生</span>{{ describeDate(m.birthDate, m.birthLunar).primary }}<span class="jp-muted"> · {{ describeDate(m.birthDate, m.birthLunar).secondary }}</span></p>
            <p v-if="m.deathDate"><span class="jp-mc-k">卒</span>{{ describeDate(m.deathDate, m.deathLunar).primary }}<span class="jp-muted"> · {{ describeDate(m.deathDate, m.deathLunar).secondary }}</span></p>
            <p v-if="!m.birthDate && !m.deathDate" class="jp-muted">生卒未详</p>
          </section>
          <section v-if="dOf(m.id)?.parents.length" class="jp-mc-sec">
            <h4>父母</h4>
            <div class="jp-mc-rels">
              <span v-for="p in dOf(m.id)?.parents ?? []" :key="p.id" class="jp-mc-rel">
                <span class="jp-badge" :class="p.subtype.includes('兼祧') || p.subtype.includes('嗣') ? 'jp-badge-gold' : ''">{{ p.subtype }}</span>
                <button class="jp-link-name" @click.stop="jumpTo(p.otherId)">{{ p.otherName }}</button>
                <span v-if="p.subtype.includes('兼祧') && !p.isPrimary" class="jp-muted">（兼祧）</span>
              </span>
            </div>
          </section>
          <section v-if="dOf(m.id)?.spouses.length" class="jp-mc-sec">
            <h4>配偶</h4>
            <div class="jp-mc-rels">
              <span v-for="s in dOf(m.id)?.spouses ?? []" :key="s.id" class="jp-mc-rel">
                <span class="jp-badge">{{ s.subtype }}</span>
                <button class="jp-link-name" @click.stop="jumpTo(s.otherId)">{{ s.otherName }}</button>
              </span>
            </div>
          </section>
          <section v-if="dOf(m.id)?.children.length" class="jp-mc-sec">
            <h4>子女</h4>
            <div class="jp-mc-rels">
              <span v-for="c in dOf(m.id)?.children ?? []" :key="c.id" class="jp-mc-rel">
                <span class="jp-badge" :class="c.subtype.includes('兼祧') || c.subtype.includes('嗣') ? 'jp-badge-gold' : ''" :title="c.subtype">{{ c.otherGender === '女' ? '女' : c.otherGender === '男' ? '子' : '子女' }}</span>
                <button class="jp-link-name" @click.stop="jumpTo(c.otherId)">{{ c.otherName }}</button>
              </span>
            </div>
          </section>
          <section v-if="m.occupation || m.residence || m.burial" class="jp-mc-sec">
            <h4>其他</h4>
            <p class="jp-muted">{{ [m.occupation, m.residence, m.burial ? '葬 ' + m.burial : ''].filter(Boolean).join(' · ') }}</p>
          </section>
          <section v-if="m.biography" class="jp-mc-sec jp-mc-wide">
            <h4>生平</h4>
            <p class="jp-mc-bio" :class="{ 'jp-clamp': !bioExpanded.has(m.id) }">{{ m.biography }}</p>
            <button v-if="m.biography.length > 60" class="jp-link jp-mc-bio-toggle" @click.stop="toggleBio(m.id)">{{ bioExpanded.has(m.id) ? '收起' : '展开' }}</button>
          </section>
          <section v-if="m.remark" class="jp-mc-sec jp-mc-wide">
            <h4>备注</h4>
            <p class="jp-mc-bio">{{ m.remark }}</p>
          </section>
        </div>
      </article>
    </div>

    <div v-if="pageCount > 1" class="jp-toolbar" style="margin-top:12px;justify-content:center">
      <button :disabled="page === 0" @click="page--">上一页</button>
      <span class="jp-muted">第 {{ page + 1 }} / {{ pageCount }} 页</span>
      <button :disabled="page >= pageCount - 1" @click="page++">下一页</button>
    </div>

    </template>

    <Modal v-if="confirmMerge" title="确认成员合并" danger confirm-text="确认合并"
      :message="`将把「${selectedGroup?.members.slice(1).map((m) => m.name).join('、') || ''}」合并到「${selectedGroup?.members[0]?.name || ''}」？成员关系会归并去重，并保留撤销快照。`"
      @confirm="mergeSelected" @cancel="confirmMerge = false" />
    <Modal v-if="delTarget" title="删除成员" danger confirm-text="删除"
      :message="`确认删除「${delTarget.name}」？其亲属关系将一并移除，可在提示条中撤销。`"
      @confirm="doDelete" @cancel="delTarget = null" />
  </div>
</template>