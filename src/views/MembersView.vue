<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { api } from '../api'
import { state, editMember, locateInGraph, toast, run, genName, refreshStats, bump } from '../store'
import { branchName, makeZibeiResolver, zibeiMatch } from '../utils'
import { describeDate } from '@shared/lunar'
import type { Branch, Member, MemberDetail, ZibeiPoem } from '@shared/types'
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
      <h2 class="jp-page-title jp-serif-c">成员管理</h2>
      <span class="jp-muted">共 {{ total }} 人 · 男女平等录入，女性可延续世系</span>
    </div>
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
      <button class="jp-primary" @click="editMember(null)">＋ 录入成员</button>
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
              <span v-if="m.courtesyName" class="jp-muted">字 {{ m.courtesyName }}</span>
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
                <span class="jp-badge" :class="c.subtype.includes('兼祧') || c.subtype.includes('嗣') ? 'jp-badge-gold' : ''">{{ c.subtype }}</span>
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
        </div>
      </article>
    </div>

    <div v-if="pageCount > 1" class="jp-toolbar" style="margin-top:12px;justify-content:center">
      <button :disabled="page === 0" @click="page--">上一页</button>
      <span class="jp-muted">第 {{ page + 1 }} / {{ pageCount }} 页</span>
      <button :disabled="page >= pageCount - 1" @click="page++">下一页</button>
    </div>

    <Modal v-if="delTarget" title="删除成员" danger confirm-text="删除"
      :message="`确认删除「${delTarget.name}」？其亲属关系将一并移除，可在提示条中撤销。`"
      @confirm="doDelete" @cancel="delTarget = null" />
  </div>
</template>