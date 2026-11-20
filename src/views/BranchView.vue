<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { api } from '../api'
import { state, run, bump, refreshStats, toast } from '../store'
import { buildBranchTree } from '../utils'
import type { Branch, Member } from '@shared/types'
import MemberPicker from '../components/MemberPicker.vue'
import Modal from '../components/Modal.vue'

const branches = ref<Branch[]>([])
const members = ref<Member[]>([])
const selectedId = ref<string | null>(null)
const creating = ref(false)
const delTarget = ref<Branch | null>(null)
const form = reactive({ name: '', parentId: '', founderId: null as string | null, note: '' })

interface FlatNode { branch: Branch; depth: number }
const flat = computed<FlatNode[]>(() => {
  const out: FlatNode[] = []
  const walk = (nodes: { branch: Branch; children: unknown[] }[], depth: number): void => {
    for (const n of nodes) { out.push({ branch: n.branch, depth }); walk(n.children as { branch: Branch; children: unknown[] }[], depth + 1) }
  }
  walk(buildBranchTree(branches.value), 0)
  return out
})
const selectedBranch = computed(() => branches.value.find((b) => b.id === selectedId.value) ?? null)
const showForm = computed(() => creating.value || !!selectedBranch.value)

const subtreeIds = computed<Set<string>>(() => {
  const id = creating.value ? null : selectedId.value
  const out = new Set<string>()
  if (!id) return out
  const children = new Map<string, string[]>()
  for (const b of branches.value) if (b.parentId) {
    if (!children.has(b.parentId)) children.set(b.parentId, [])
    children.get(b.parentId)!.push(b.id)
  }
  const stack = [id]
  while (stack.length) { const c = stack.pop()!; out.add(c); stack.push(...(children.get(c) ?? [])) }
  return out
})
const parentOptions = computed(() => branches.value.filter((b) => !subtreeIds.value.has(b.id)))

async function reload(): Promise<void> {
  if (!state.current) return
  branches.value = await api.branch.list()
  members.value = (await api.member.list({ limit: 100000 })).rows
}
function selectBranch(b: Branch): void {
  selectedId.value = b.id
  creating.value = false
  form.name = b.name; form.parentId = b.parentId ?? ''; form.founderId = b.founderId; form.note = b.note
}
function startCreate(): void {
  creating.value = true
  form.name = ''; form.parentId = selectedId.value ?? ''; form.founderId = null; form.note = ''
}
function cancelForm(): void {
  creating.value = false
  if (selectedBranch.value) selectBranch(selectedBranch.value)
}
async function save(): Promise<void> {
  const name = form.name.trim()
  if (!name) { toast('请填写支系名称', 'err'); return }
  const parentId = form.parentId || null
  if (creating.value) {
    const b = await run(() => api.branch.create(name, parentId, form.founderId, form.note), '支系已创建')
    if (b) { await reload(); selectBranch(b); await refreshStats(); bump() }
  } else if (selectedId.value) {
    const list = await run(() => api.branch.update(selectedId.value!, name, parentId, form.founderId, form.note), '支系已更新')
    if (list) { branches.value = list; await reload(); const nb = selectedBranch.value; if (nb) selectBranch(nb); await refreshStats(); bump() }
  }
}
async function doDelete(): Promise<void> {
  const t = delTarget.value
  delTarget.value = null
  if (!t) return
  const list = await run(() => api.branch.delete(t.id))
  if (list) {
    branches.value = list; selectedId.value = null; creating.value = false
    await reload(); await refreshStats(); bump()
    toast(`已删除支系「${t.name}」，其成员归入上级支系`)
  }
}

watch(() => state.tick, async () => { if (!state.current) return; await reload(); if (selectedBranch.value) selectBranch(selectedBranch.value) })
onMounted(async () => {
  await reload()
  if (flat.value.length) selectBranch(flat.value[0].branch)
})
</script>

<template>
  <div>
    <div class="jp-page-head">
      <h2 class="jp-page-title jp-serif-c">支系管理</h2>
      <span class="jp-muted">按房支划分 · 成员归属自动推导，可手动调整</span>
    </div>
    <div class="jp-split">
      <div class="jp-panel">
        <div class="jp-panel-title">支系树</div>
        <div v-if="!flat.length" class="jp-empty"><div class="jp-empty-seal">支</div>暂无支系，点击「新增支系」开始</div>
        <div v-else class="jp-branch-tree">
          <div v-for="n in flat" :key="n.branch.id" :style="{ marginLeft: n.depth * 16 + 'px' }">
            <button class="jp-branch-btn" :aria-pressed="!creating && selectedId === n.branch.id" @click="selectBranch(n.branch)">
              <span class="jp-serif-c">{{ n.branch.name }}</span>
              <span class="jp-muted">{{ n.branch.memberCount }} 人</span>
            </button>
          </div>
        </div>
        <div class="jp-detail-actions">
          <button class="jp-primary" @click="startCreate">＋ 新增支系</button>
        </div>
      </div>

      <div class="jp-panel">
        <div class="jp-panel-title">{{ creating ? '新增支系' : '支系详情' }}</div>
        <div v-if="!showForm" class="jp-empty"><div class="jp-empty-seal">详</div>选择左侧支系查看详情</div>
        <div v-else>
          <div v-if="selectedBranch && !creating" class="jp-detail-tags">
            <span class="jp-badge jp-badge-blue">{{ selectedBranch.memberCount }} 人</span>
            <span v-if="selectedBranch.founderName" class="jp-badge">开基祖 · {{ selectedBranch.founderName }}</span>
          </div>
          <div class="jp-field" style="margin-bottom:10px"><span>支系名称 *</span>
            <input v-model="form.name" type="text" placeholder="如：长房长支" aria-label="支系名称"></div>
          <div class="jp-field" style="margin-bottom:10px"><span>上级支系</span>
            <select v-model="form.parentId" aria-label="上级支系">
              <option value="">无（顶级支系）</option>
              <option v-for="b in parentOptions" :key="b.id" :value="b.id">{{ b.name }}</option>
            </select>
          </div>
          <div class="jp-field" style="margin-bottom:10px"><span>开基祖（可选）</span>
            <MemberPicker v-model="form.founderId" :members="members" placeholder="搜索并选择开基祖" />
          </div>
          <div class="jp-field" style="margin-bottom:10px"><span>备注</span>
            <textarea v-model="form.note" rows="3" placeholder="支系源流、迁徙、堂号等" aria-label="支系备注"></textarea>
          </div>
          <div class="jp-detail-actions">
            <button class="jp-primary" @click="save">{{ creating ? '创建支系' : '保存修改' }}</button>
            <button v-if="creating" @click="cancelForm">取消</button>
            <button v-if="selectedBranch && !creating" class="jp-danger" @click="delTarget = selectedBranch">删除支系</button>
          </div>
          <p v-if="selectedBranch && !creating" class="jp-muted" style="margin-top:10px">
            删除后该支系及其子支系的成员将归入上级支系，字辈设置一并合并。
          </p>
        </div>
      </div>
    </div>

    <Modal v-if="delTarget" title="删除支系" danger confirm-text="删除"
      :message="`确认删除支系「${delTarget.name}」？其子支系一并删除，成员归入上级支系。`"
      @confirm="doDelete" @cancel="delTarget = null" />
  </div>
</template>
