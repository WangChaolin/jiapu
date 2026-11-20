<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { api } from '../api'
import { state, editMember, setPage, showMember, toast, run, genName, refreshStats, bump } from '../store'
import { makeZibeiResolver, zibeiMatch, branchName } from '../utils'
import { isValidSolar } from '@shared/lunar'
import { PARENT_SUBTYPES, SPOUSE_SUBTYPES, type Branch, Member, MemberDetail, ParentSubtype, SpouseSubtype, ZibeiPoem } from '@shared/types'
import DateField from '../components/DateField.vue'
import MemberPicker from '../components/MemberPicker.vue'

interface ParentRow { otherId: string | null; subtype: ParentSubtype; isPrimary: boolean; note: string }
interface SpouseRow { otherId: string | null; subtype: SpouseSubtype; note: string }

const allMembers = ref<Member[]>([])
const branches = ref<Branch[]>([])
const poems = ref<ZibeiPoem[]>([])
const existing = ref<MemberDetail | null>(null)
const relTab = ref<'parents' | 'spouses' | 'children'>('parents')
const busy = ref(false)
const genManual = ref(false)

const form = reactive({
  name: '', gender: '男' as Member['gender'], generation: 1, branchId: '' as string,
  birthDate: '', birthLunar: false, deathDate: '', deathLunar: false, alive: true,
  birthOrder: 1, courtesyName: '', title: '', occupation: '', residence: '', burial: '', biography: '', photoPath: '',
})
const parents = ref<ParentRow[]>([])
const spouses = ref<SpouseRow[]>([])

const resolver = computed(() => makeZibeiResolver(poems.value, branches.value))
const surname = computed(() => state.current?.surname ?? '')
const expectedChar = computed(() => resolver.value(form.generation, form.branchId || null))
const zibeiStatus = computed(() => zibeiMatch(form.name, surname.value, expectedChar.value))
const isEdit = computed(() => !!state.editingId)
const suggestedGen = computed(() => {
  let max = 0
  for (const p of parents.value) {
    const m = allMembers.value.find((x) => x.id === p.otherId)
    if (m && m.generation > max) max = m.generation
  }
  return max > 0 ? max + 1 : 1
})
const zibeiHint = computed(() => {
  if (!expectedChar.value) return '该世代尚未设置字辈'
  if (zibeiStatus.value === 'exempt') return `推荐「${expectedChar.value}」· 母系外姓不校验`
  if (zibeiStatus.value === 'mismatch') return `推荐「${expectedChar.value}」· 姓名用字不符（可忽略）`
  if (zibeiStatus.value === 'match') return `推荐「${expectedChar.value}」· 与姓名相符 ✓`
  return `推荐用字「${expectedChar.value}」`
})

watch(suggestedGen, (g) => { if (!genManual.value && !isEdit.value) form.generation = g })

function addParent(): void { parents.value.push({ otherId: null, subtype: '生父', isPrimary: true, note: '' }) }
function addSpouse(): void { spouses.value.push({ otherId: null, subtype: '原配', note: '' }) }

async function uploadPhoto(): Promise<void> {
  const src = await api.member.choosePhoto()
  if (!src) return
  const rel = await run(() => api.member.savePhoto(src))
  if (rel) { form.photoPath = rel; toast('照片已上传') }
}

function validate(): string | null {
  if (!form.name.trim()) return '请填写姓名'
  if (!isValidSolar(form.birthDate)) return '出生日期无效'
  if (!isValidSolar(form.deathDate)) return '卒日期无效'
  for (const p of parents.value) if (!p.otherId) return '父母关系中存在未选择的成员'
  for (const s of spouses.value) if (!s.otherId) return '配偶关系中存在未选择的成员'
  const jt = parents.value.filter((p) => p.subtype.includes('兼祧'))
  if (jt.length && !jt.some((p) => p.isPrimary)) return '兼祧关系需至少标记一位主承'
  return null
}

function buildInput(): Parameters<typeof api.member.create>[0] {
  return {
    name: form.name.trim(), gender: form.gender, generation: form.generation,
    branchId: form.branchId || null, birthDate: form.birthDate, birthLunar: form.birthLunar,
    deathDate: form.deathDate, deathLunar: form.deathLunar, alive: form.alive, birthOrder: form.birthOrder,
    courtesyName: form.courtesyName, title: form.title, occupation: form.occupation,
    residence: form.residence, burial: form.burial, biography: form.biography, photoPath: form.photoPath,
    parents: parents.value.filter((p) => p.otherId).map((p) => ({ otherId: p.otherId!, subtype: p.subtype, isPrimary: p.isPrimary, note: p.note })),
    spouses: spouses.value.filter((s) => s.otherId).map((s) => ({ otherId: s.otherId!, subtype: s.subtype, note: s.note })),
  }
}

async function save(next: boolean): Promise<void> {
  const err = validate()
  if (err) { toast(err, 'err'); return }
  busy.value = true
  const input = buildInput()
  let saved: MemberDetail | null = null
  if (isEdit.value) saved = await run(() => api.member.update(state.editingId!, input))
  else saved = await run(() => api.member.create(input))
  busy.value = false
  if (!saved) return
  await refreshStats(); bump()
  toast(`已保存「${saved.name}」`)
  if (next) {
    const keepBranch = form.branchId, keepGen = form.generation
    resetForm()
    form.branchId = keepBranch; form.generation = keepGen + 1; genManual.value = true
    state.editingId = null
  } else {
    showMember(saved.id)
  }
}

function resetForm(): void {
  Object.assign(form, {
    name: '', gender: '男', generation: 1, branchId: '', birthDate: '', birthLunar: false,
    deathDate: '', deathLunar: false, alive: true, birthOrder: 1, courtesyName: '', title: '',
    occupation: '', residence: '', burial: '', biography: '', photoPath: '',
  })
  parents.value = []; spouses.value = []; genManual.value = false; existing.value = null
}

function addChild(): void {
  if (!isEdit.value) { toast('请先保存本成员，再录入子女', 'err'); return }
  const sub = form.gender === '女' ? '生母' : '生父'
  editMember(null, { parents: [{ otherId: state.editingId!, subtype: sub }], generation: form.generation + 1, branchId: form.branchId || null })
}

onMounted(async () => {
  if (!state.current) return
  allMembers.value = (await api.member.list({ limit: 100000 })).rows
  branches.value = await api.branch.list()
  poems.value = await api.zibei.list()
  if (state.settings?.lunarDefault) { form.birthLunar = true; form.deathLunar = true }
  if (state.editingId) {
    const d = await api.member.get(state.editingId)
    if (d) {
      existing.value = d
      Object.assign(form, {
        name: d.name, gender: d.gender, generation: d.generation, branchId: d.branchId ?? '',
        birthDate: d.birthDate, birthLunar: d.birthLunar, deathDate: d.deathDate, deathLunar: d.deathLunar,
        alive: d.alive, birthOrder: d.birthOrder, courtesyName: d.courtesyName, title: d.title,
        occupation: d.occupation, residence: d.residence, burial: d.burial, biography: d.biography, photoPath: d.photoPath,
      })
      parents.value = d.parents.map((p) => ({ otherId: p.otherId, subtype: p.subtype as ParentSubtype, isPrimary: p.isPrimary, note: p.note }))
      spouses.value = d.spouses.map((s) => ({ otherId: s.otherId, subtype: s.subtype as SpouseSubtype, note: s.note }))
      genManual.value = true
    }
  } else if (state.formPrefill) {
    const pf = state.formPrefill
    if (pf.parents) parents.value = pf.parents.map((p) => ({ otherId: p.otherId, subtype: p.subtype as ParentSubtype, isPrimary: true, note: '' }))
    if (pf.generation) { form.generation = pf.generation; genManual.value = true }
    if (pf.branchId) form.branchId = pf.branchId
  }
})
</script>

<template>
  <div>
    <div class="jp-page-head">
      <h2 class="jp-page-title jp-serif-c">{{ isEdit ? '编辑成员' : '成员录入' }}</h2>
      <span class="jp-muted">男女平等录入，女性成员可延续世系 · 支持特殊关系与农历</span>
    </div>
    <div class="jp-form-grid">
      <div class="jp-panel">
        <div class="jp-panel-title">基本信息</div>
        <div class="jp-form-row">
          <div class="jp-field"><span>姓名 *</span><input v-model="form.name" type="text" aria-label="姓名" placeholder="如：张顺治"></div>
          <div class="jp-field"><span>性别</span>
            <select v-model="form.gender" aria-label="性别"><option>男</option><option>女</option><option>其他</option></select>
          </div>
          <div class="jp-field"><span>字 / 号</span><input v-model="form.courtesyName" type="text" placeholder="如：字建国" aria-label="字号"></div>
        </div>
        <div class="jp-form-row">
          <div class="jp-field"><span>世代</span>
            <select v-model.number="form.generation" aria-label="世代" @change="genManual = true">
              <option v-for="g in 20" :key="g" :value="g">{{ genName(g) }}</option>
            </select>
          </div>
          <div class="jp-field"><span>字辈推荐</span>
            <input :value="zibeiHint" type="text" readonly aria-label="字辈推荐" style="background:var(--jp-inset)" :style="{ color: zibeiStatus === 'mismatch' ? 'var(--jp-gold)' : '' }">
          </div>
          <div class="jp-field"><span>行第</span><input v-model.number="form.birthOrder" type="number" min="1" aria-label="行第" style="width:80px"></div>
        </div>
        <div class="jp-form-row">
          <DateField v-model="form.birthDate" v-model:lunar="form.birthLunar" label="出生日期" />
          <DateField v-model="form.deathDate" v-model:lunar="form.deathLunar" label="卒日期" />
        </div>
        <div class="jp-form-row">
          <div class="jp-field"><span>在世状态</span>
            <select :value="form.alive ? '在世' : '已故'" aria-label="在世状态" @change="form.alive = ($event.target as HTMLSelectElement).value === '在世'"><option>在世</option><option>已故</option></select>
          </div>
          <div class="jp-field"><span>所属支系</span>
            <select v-model="form.branchId" aria-label="所属支系">
              <option value="">未指定</option>
              <option v-for="b in branches" :key="b.id" :value="b.id">{{ b.name }}</option>
            </select>
          </div>
          <div class="jp-field"><span>照片</span>
            <div style="display:flex;gap:8px;align-items:center">
              <img v-if="form.photoPath" class="jp-photo-thumb" :src="`jpimg://${state.current?.id}/${form.photoPath}`" alt="照片">
              <button type="button" @click="uploadPhoto">上传照片…</button>
            </div>
          </div>
        </div>
        <div class="jp-form-row">
          <div class="jp-field"><span>称谓 / 功名</span><input v-model="form.title" type="text" placeholder="如：邑庠生" aria-label="称谓"></div>
          <div class="jp-field"><span>职业</span><input v-model="form.occupation" type="text" aria-label="职业"></div>
          <div class="jp-field"><span>居地</span><input v-model="form.residence" type="text" aria-label="居地"></div>
          <div class="jp-field"><span>葬地</span><input v-model="form.burial" type="text" aria-label="葬地"></div>
        </div>
        <div class="jp-field"><span>生平简介</span><textarea v-model="form.biography" rows="3" placeholder="生平事迹、迁徙、职业、功名等" aria-label="生平简介"></textarea></div>
      </div>

      <div class="jp-panel">
        <div class="jp-panel-title">亲属关系</div>
        <div class="jp-tabs">
          <button :aria-pressed="relTab === 'parents'" @click="relTab = 'parents'">父母</button>
          <button :aria-pressed="relTab === 'spouses'" @click="relTab = 'spouses'">配偶</button>
          <button :aria-pressed="relTab === 'children'" @click="relTab = 'children'">子女</button>
        </div>
        <div v-show="relTab === 'parents'">
          <p class="jp-muted" style="margin-bottom:8px">支持生 / 养 / 继 / 过继（嗣）/ 兼祧父母，兼祧需标记主承。</p>
          <div v-for="(p, i) in parents" :key="i" class="jp-relrow">
            <MemberPicker v-model="p.otherId" :members="allMembers" :exclude="[state.editingId].filter(Boolean) as string[]" placeholder="选择父 / 母" />
            <select v-model="p.subtype" aria-label="父母关系类型" style="width:130px;flex:none">
              <option v-for="s in PARENT_SUBTYPES" :key="s" :value="s">{{ s }}</option>
            </select>
            <label v-if="p.subtype.includes('兼祧')" class="jp-muted"><input type="checkbox" v-model="p.isPrimary">主承</label>
            <button type="button" class="jp-danger" style="flex:none" aria-label="移除" @click="parents.splice(i, 1)">✕</button>
          </div>
          <button type="button" @click="addParent">＋ 添加父母关系</button>
        </div>
        <div v-show="relTab === 'spouses'">
          <p class="jp-muted" style="margin-bottom:8px">支持多任配偶，区分原配 / 继配。</p>
          <div v-for="(s, i) in spouses" :key="i" class="jp-relrow">
            <MemberPicker v-model="s.otherId" :members="allMembers" :exclude="[state.editingId].filter(Boolean) as string[]" placeholder="选择配偶" />
            <select v-model="s.subtype" aria-label="配偶类型" style="width:90px;flex:none">
              <option v-for="t in SPOUSE_SUBTYPES" :key="t" :value="t">{{ t }}</option>
            </select>
            <button type="button" class="jp-danger" style="flex:none" aria-label="移除" @click="spouses.splice(i, 1)">✕</button>
          </div>
          <button type="button" @click="addSpouse">＋ 添加配偶</button>
        </div>
        <div v-show="relTab === 'children'">
          <p class="jp-muted" style="margin-bottom:8px">子女按行第排序，女儿同等录入并可延续世系。</p>
          <div v-if="existing?.children.length" class="jp-rel-list" style="margin-bottom:10px">
            <div v-for="c in existing.children" :key="c.id" class="jp-rel-item">
              <span class="jp-badge">{{ c.subtype }}</span>
              <button class="jp-link-name" type="button" @click="editMember(c.otherId)">{{ c.otherName }}</button>
              <span class="jp-muted">{{ genName(allMembers.find(m => m.id === c.otherId)?.generation ?? 0) }}</span>
            </div>
          </div>
          <p v-else class="jp-muted" style="margin-bottom:10px">暂无子女记录。</p>
          <button type="button" @click="addChild">＋ 录入子女</button>
        </div>
        <div class="jp-detail-actions">
          <button class="jp-primary" :disabled="busy" @click="save(false)">保存</button>
          <button :disabled="busy" @click="save(true)">保存并录下一位</button>
          <button @click="setPage('members')">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>