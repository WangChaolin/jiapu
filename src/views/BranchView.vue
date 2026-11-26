<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { api } from '../api'
import { state, run, bump, refreshStats, toast } from '../store'
import { buildBranchTree } from '../utils'
import type { Branch, BranchOperation, BranchOperationPreview, Member } from '@shared/types'
import MemberPicker from '../components/MemberPicker.vue'
import Modal from '../components/Modal.vue'

const branches = ref<Branch[]>([])
const members = ref<Member[]>([])
const selectedId = ref<string | null>(null)
const creating = ref(false)
const delTarget = ref<Branch | null>(null)
const form = reactive({ name: '', parentId: '', founderId: null as string | null, note: '' })
type OperationKind = 'merge' | 'split' | 'migrate'
const operation = ref<OperationKind | null>(null)
const opForm = reactive({ sourceIds: [] as string[], targetId: '', founderId: null as string | null, name: '', memberIds: [] as string[], migrateTargetId: '' })
const preview = ref<BranchOperationPreview | null>(null)
const confirmOperation = ref(false)
const busy = ref(false)

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
const selectedMemberCount = computed(() => members.value.filter((m) => m.branchId === selectedId.value).length)
const directChildCount = computed(() => branches.value.filter((b) => b.parentId === selectedId.value).length)
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
const mergeSourceOptions = computed(() => branches.value)
const targetOptions = computed(() => branches.value.filter((b) => !opForm.sourceIds.includes(b.id)))
const selectedSubtreeMembers = computed(() => members.value.filter((m) => m.branchId && subtreeIds.value.has(m.branchId)))
const sameNameWarning = computed(() => {
  if (operation.value !== 'merge' || !opForm.targetId) return ''
  const target = branches.value.find((b) => b.id === opForm.targetId)
  return target && opForm.sourceIds.some((id) => branches.value.find((b) => b.id === id)?.name === target.name) ? '存在同名支系，合并后将只保留目标支系名称。' : ''
})

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

function openOperation(kind: OperationKind): void {
  operation.value = kind
  preview.value = null
  opForm.sourceIds = []
  opForm.targetId = kind === 'merge' ? (selectedId.value ?? '') : ''
  opForm.founderId = selectedBranch.value?.founderId ?? null
  opForm.name = selectedBranch.value ? `${selectedBranch.value.name}拆分支系` : ''
  opForm.memberIds = []
  opForm.migrateTargetId = ''
}
function closeOperation(): void {
  operation.value = null
  preview.value = null
  confirmOperation.value = false
}
function currentRequest(): BranchOperation | null {
  if (operation.value === 'merge') {
    if (!opForm.targetId || opForm.sourceIds.length < 2) { toast('请选择目标支系和至少两个来源支系', 'err'); return null }
    return { kind: 'merge', sourceIds: [...opForm.sourceIds], targetId: opForm.targetId }
  }
  if (operation.value === 'split') {
    if (!selectedId.value || !opForm.founderId || !opForm.name.trim()) { toast('请填写新支系名称并选择开基祖', 'err'); return null }
    return { kind: 'split', branchId: selectedId.value, founderId: opForm.founderId, name: opForm.name }
  }
  if (!opForm.memberIds.length) { toast('请至少选择一位成员', 'err'); return null }
  return { kind: 'migrate', memberIds: [...opForm.memberIds], targetBranchId: opForm.migrateTargetId || null }
}
async function showPreview(): Promise<void> {
  const request = currentRequest()
  if (!request) return
  preview.value = await run(() => api.branch.preview(request))
}
async function executeOperation(): Promise<void> {
  const request = currentRequest()
  confirmOperation.value = false
  if (!request || busy.value) return
  busy.value = true
  const r = await run(() => api.branch.operate(request))
  busy.value = false
  if (!r) return
  const label = request.kind === 'merge' ? '支系合并' : request.kind === 'split' ? '支系拆分' : '成员迁移'
  operation.value = null
  preview.value = null
  branches.value = r.branches
  if (request.kind === 'merge') selectedId.value = request.targetId
  else if (request.kind === 'split' && r.branchId) selectedId.value = r.branchId
  await reload()
  if (selectedBranch.value) selectBranch(selectedBranch.value)
  await refreshStats(); bump()
  toast(`${label}完成，可撤销`, 'info', { label: '撤销', fn: async () => {
    const ok = await run(() => api.operation.undo(r.operationId))
    if (ok) { await reload(); if (selectedBranch.value) selectBranch(selectedBranch.value); await refreshStats(); bump(); toast(`${label}已撤销`) }
  } })
}
const operationTitle = computed(() => operation.value === 'merge' ? '合并支系' : operation.value === 'split' ? '拆分支系' : '迁移成员')
const operationMessage = computed(() => {
  if (!preview.value) return ''
  return `将影响 ${preview.value.memberCount} 位成员、${preview.value.childBranchCount} 个下级支系和 ${preview.value.relationCount} 条关系。此操作在事务中执行，失败自动回滚，完成后可撤销。`
})

watch(() => opForm.targetId, (id) => { opForm.sourceIds = opForm.sourceIds.filter((sourceId) => sourceId !== id) })
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
      <span class="jp-muted">合并 / 拆分 / 迁移 · 操作前预览影响 · 事务执行 · 支持撤销</span>
      <div class="proto-head-actions">
        <button @click="openOperation('merge')">合并支系</button>
        <button @click="openOperation('split')">拆分支系</button>
        <button @click="openOperation('migrate')">迁移成员</button>
        <button class="jp-primary" @click="startCreate">＋ 新增支系</button>
      </div>
    </div>
    <div class="proto-kpis">
      <div class="proto-kpi"><strong>{{ branches.length }}</strong><span>支系总数</span></div>
      <div class="proto-kpi"><strong>{{ members.length }}</strong><span>成员总数</span></div>
      <div class="proto-kpi"><strong>{{ selectedMemberCount }}</strong><span>当前支系成员</span></div>
      <div class="proto-kpi"><strong>{{ directChildCount }}</strong><span>下级支系</span></div>
    </div>
    <div class="proto-branch-grid">
      <div class="jp-panel">
        <div class="jp-panel-title">支系树</div>
        <div v-if="!flat.length" class="jp-empty"><div class="jp-empty-seal">支</div>暂无支系，点击「新增支系」开始</div>
        <div v-else class="proto-tree">
          <button v-for="n in flat" :key="n.branch.id" class="proto-tree-row" :aria-pressed="!creating && selectedId === n.branch.id" :style="{ marginLeft: n.depth * 16 + 'px' }" @click="selectBranch(n.branch)">
            <span class="jp-serif-c">{{ n.branch.name }}</span><small>{{ n.branch.memberCount }} 人</small>
          </button>
        </div>
        <div class="proto-warning">同名支系会提示但允许保留；禁止把支系合并到自己的后代支系。</div>
      </div>
      <div class="jp-panel">
        <div class="jp-panel-title">{{ creating ? '新增支系' : '支系详情' }}</div>
        <div v-if="!showForm" class="jp-empty"><div class="jp-empty-seal">详</div>选择左侧支系查看详情</div>
        <div v-else>
          <div v-if="selectedBranch && !creating" class="jp-detail-tags">
            <span class="jp-badge jp-badge-blue">{{ selectedBranch.memberCount }} 人</span>
            <span v-if="selectedBranch.founderName" class="jp-badge jp-badge-gold">开基祖 · {{ selectedBranch.founderName }}</span>
          </div>
          <div class="jp-form-row">
            <label class="jp-field"><span>支系名称</span><input v-model="form.name" type="text" aria-label="支系名称"></label>
            <label class="jp-field"><span>上级支系</span><select v-model="form.parentId" aria-label="上级支系"><option value="">无（顶级支系）</option><option v-for="b in parentOptions" :key="b.id" :value="b.id">{{ b.name }}</option></select></label>
          </div>
          <label class="jp-field" style="margin-bottom:10px"><span>开基祖（可选）</span><MemberPicker v-model="form.founderId" :members="members" placeholder="搜索并选择开基祖" /></label>
          <label class="jp-field" style="margin-bottom:10px"><span>简介</span><textarea v-model="form.note" rows="2" aria-label="支系简介"></textarea></label>
          <div class="proto-impact">
            <div><strong>{{ selectedMemberCount }}</strong><span>直接成员</span></div><div><strong>{{ directChildCount }}</strong><span>子支系</span></div>
            <div><strong>{{ selectedBranch?.founderName || '—' }}</strong><span>开基祖</span></div><div><strong>{{ selectedBranch?.note ? '有' : '—' }}</strong><span>支系简介</span></div>
          </div>
          <div class="jp-panel-title">成员归属预览</div>
          <div class="jp-table-wrap">
            <table class="jp-table"><thead><tr><th>姓名</th><th>世代</th><th>当前支系</th><th>操作</th></tr></thead><tbody>
              <tr v-for="m in members.filter((x) => x.branchId === selectedId).slice(0, 8)" :key="m.id"><td>{{ m.name }}</td><td>{{ m.generation }} 世</td><td>{{ branches.find((b) => b.id === m.branchId)?.name ?? '—' }}</td><td><button @click="openOperation('migrate')">迁移</button></td></tr>
              <tr v-if="!selectedMemberCount"><td colspan="4" class="jp-muted">当前支系暂无直接成员</td></tr>
            </tbody></table>
          </div>
          <div class="jp-detail-actions"><button class="jp-primary" @click="save">{{ creating ? '创建支系' : '保存修改' }}</button><button v-if="creating" @click="cancelForm">取消</button><button v-if="selectedBranch && !creating" class="jp-danger" @click="delTarget = selectedBranch">删除支系</button></div>
          <p v-if="selectedBranch && !creating" class="jp-muted" style="margin-top:10px">删除后该支系及其子支系的成员将归入上级支系，字辈设置一并合并。</p>
        </div>
      </div>
    </div>

    <div v-if="operation" class="jp-modal-mask" @click.self="closeOperation">
      <div class="jp-op-dialog" role="dialog" aria-modal="true" :aria-label="operationTitle">
        <div class="proto-dialog-head"><h3>{{ operationTitle }}</h3><button aria-label="关闭" @click="closeOperation">×</button></div>
        <template v-if="operation === 'merge'">
          <p class="jp-muted">将所选支系及其下级支系合并到目标支系，保留全部成员与关系。</p>
          <div class="jp-form-row" style="margin-top:14px">
            <label class="jp-field" style="flex:1"><span>待合并支系（至少两个）</span>
              <div class="proto-check-box"><label v-for="b in mergeSourceOptions" :key="b.id"><input v-model="opForm.sourceIds" type="checkbox" :value="b.id">{{ b.name }} · {{ b.memberCount }} 人</label></div>
            </label>
            <label class="jp-field" style="width:210px"><span>合并到</span><select v-model="opForm.targetId" aria-label="合并目标支系"><option value="">请选择</option><option v-for="b in targetOptions" :key="b.id" :value="b.id">{{ b.name }}</option></select></label>
          </div>
          <p v-if="sameNameWarning" class="jp-warning">{{ sameNameWarning }}</p>
        </template>
        <template v-else-if="operation === 'split'">
          <p class="jp-muted">以指定成员为新开基祖，将其所属子孙拆分为新支系，不改变亲属关系。</p>
          <label class="jp-field" style="margin-top:14px"><span>当前支系</span><input :value="selectedBranch?.name" readonly></label>
          <label class="jp-field" style="margin-top:10px"><span>新开基祖</span><MemberPicker v-model="opForm.founderId" :members="selectedSubtreeMembers" placeholder="搜索并选择新开基祖" /></label>
          <label class="jp-field" style="margin-top:10px"><span>新支系名称</span><input v-model="opForm.name" aria-label="新支系名称"></label>
        </template>
        <template v-else>
          <p class="jp-muted">支持单个或批量调整成员所属支系，亲属关系保持不变。</p>
          <div class="jp-form-row" style="margin-top:14px"><label class="jp-field"><span>目标支系</span><select v-model="opForm.migrateTargetId" aria-label="迁移目标支系"><option value="">无支系</option><option v-for="b in branches" :key="b.id" :value="b.id">{{ b.name }}</option></select></label></div>
          <div class="proto-check-box" style="max-height:240px;overflow:auto"><label v-for="m in selectedSubtreeMembers" :key="m.id"><input v-model="opForm.memberIds" type="checkbox" :value="m.id">{{ m.name }} · {{ m.generation }} 世 · {{ branches.find((b) => b.id === m.branchId)?.name ?? '无支系' }}</label></div>
        </template>
        <div v-if="preview" class="proto-impact">
          <div><strong>{{ preview.memberCount }}</strong><span>迁移成员</span></div><div><strong>{{ preview.childBranchCount }}</strong><span>子支系</span></div>
          <div><strong>{{ preview.relationCount }}</strong><span>关系记录</span></div><div><strong>{{ preview.founderNames.join('、') || '—' }}</strong><span>涉及开基祖</span></div>
        </div>
        <div class="proto-warning">操作在事务中执行，异常自动回滚；成功后可在提示条中撤销。兼祧关系不会被删除。</div>
        <div class="proto-dialog-actions"><button @click="closeOperation">取消</button><button v-if="!preview" class="jp-primary" :disabled="busy" @click="showPreview">预览影响</button><button v-else class="jp-primary" :disabled="busy" @click="confirmOperation = true">确认执行</button></div>
      </div>
    </div>

    <Modal v-if="confirmOperation" :title="operationTitle" danger confirm-text="确认执行" :message="operationMessage" @confirm="executeOperation" @cancel="confirmOperation = false" />
    <Modal v-if="delTarget" title="删除支系" danger confirm-text="删除" :message="`确认删除支系「${delTarget.name}」？其子支系一并删除，成员归入上级支系。`" @confirm="doDelete" @cancel="delTarget = null" />
  </div>
</template>
