<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { api } from '../api'
import { state, loadGenealogies, openGenealogy, toast, run, fmtTime } from '../store'
import Modal from '../components/Modal.vue'

const showForm = ref(false)
const form = ref({ name: '', surname: '', hall: '', origin: '', compiler: '', note: '' })
const busy = ref(false)
const delTarget = ref<{ id: string; name: string } | null>(null)
const dupTarget = ref<{ id: string; name: string } | null>(null)
const dupName = ref('')

onMounted(loadGenealogies)

async function create(): Promise<void> {
  if (!form.value.name.trim()) { toast('请填写谱名', 'err'); return }
  busy.value = true
  const meta = await run(() => api.genealogy.create({ ...form.value }))
  busy.value = false
  if (meta) {
    showForm.value = false
    form.value = { name: '', surname: '', hall: '', origin: '', compiler: '', note: '' }
    await openGenealogy(meta.id)
    toast(`已创建「${meta.name}」`)
  }
}

async function seed(): Promise<void> {
  busy.value = true
  const meta = await run(() => api.genealogy.seedDemo())
  busy.value = false
  if (meta) { await openGenealogy(meta.id); toast('已载入示例家谱（张氏家谱 · 百忍堂）') }
}

async function doDelete(): Promise<void> {
  const t = delTarget.value
  delTarget.value = null
  if (!t) return
  const r = await run(() => api.genealogy.delete(t.id))
  if (r) {
    await loadGenealogies()
    toast(`已删除「${t.name}」`, 'info', {
      label: '撤销',
      fn: async () => {
        const restored = await api.genealogy.undoDelete()
        await loadGenealogies()
        if (restored) toast(`已恢复「${restored.name}」`)
      },
    })
  }
}

function openDup(id: string, name: string): void { dupTarget.value = { id, name }; dupName.value = `${name}（副本）` }
async function doDup(): Promise<void> {
  const t = dupTarget.value
  dupTarget.value = null
  if (!t || !dupName.value.trim()) return
  const meta = await run(() => api.genealogy.duplicate(t.id, dupName.value.trim()))
  if (meta) { await loadGenealogies(); toast(`已复制为「${meta.name}」`) }
}
</script>

<template>
  <div class="jp-home">
    <div class="jp-home-wrap">
      <div class="jp-brand">
        <span class="jp-seal">家谱</span>
        <div>
          <h1 class="jp-brand-title">家谱管理软件</h1>
          <p class="jp-muted">数字化修谱 · 世系传承 · 数据本地存储</p>
        </div>
      </div>
      <p class="jp-home-sub">每次打开一份家谱，可随时切换 · 安装目录与数据目录均可自定义</p>

      <div v-if="showForm" class="jp-new-form">
        <div class="jp-field" style="flex:1;min-width:160px"><span>谱名 *</span><input v-model="form.name" type="text" placeholder="如：陈氏家谱" aria-label="谱名"></div>
        <div class="jp-field"><span>姓氏</span><input v-model="form.surname" type="text" placeholder="如：陈" style="width:80px" aria-label="姓氏"></div>
        <div class="jp-field"><span>堂号</span><input v-model="form.hall" type="text" placeholder="如：颍川堂" style="width:120px" aria-label="堂号"></div>
        <div class="jp-field"><span>籍贯</span><input v-model="form.origin" type="text" placeholder="如：山东清河" style="width:130px" aria-label="籍贯"></div>
        <div class="jp-field"><span>编纂者</span><input v-model="form.compiler" type="text" placeholder="修谱委员会" style="width:130px" aria-label="编纂者"></div>
        <button class="jp-primary" :disabled="busy" @click="create">创建家谱</button>
        <button @click="showForm = false">取消</button>
      </div>

      <div class="jp-gene-grid">
        <button class="jp-gene-card jp-gene-new" @click="showForm = true">
          <span style="font-size:30px;line-height:1">＋</span>
          <span>新建家谱</span>
        </button>
        <button v-if="!state.genealogies.length" class="jp-gene-card jp-gene-new" :disabled="busy" @click="seed">
          <span class="jp-serif-c" style="font-size:22px;color:var(--jp-accent)">示例</span>
          <span>载入示例家谱</span>
          <span class="jp-muted">张氏家谱 · 百忍堂 · 31 人</span>
        </button>
        <div v-for="g in state.genealogies" :key="g.id" class="jp-gene-card">
          <div class="jp-gene-name">{{ g.name }}</div>
          <div class="jp-gene-meta">
            <span v-if="g.hall" class="jp-badge jp-badge-accent">{{ g.hall }}</span>
            <span v-if="g.surname" class="jp-badge">{{ g.surname }}氏</span>
            <span class="jp-badge jp-badge-blue">{{ g.memberCount }} 人</span>
          </div>
          <p class="jp-muted">{{ g.origin || '—' }} · 最近打开 {{ fmtTime(g.lastOpenedAt) }}</p>
          <p v-if="g.note" class="jp-muted">{{ g.note }}</p>
          <div class="jp-gene-actions">
            <button class="jp-primary" @click="openGenealogy(g.id)">打开</button>
            <button @click="openDup(g.id, g.name)">复制</button>
            <button class="jp-danger" @click="delTarget = { id: g.id, name: g.name }">删除</button>
          </div>
        </div>
      </div>

      <p class="jp-muted" style="text-align:center;margin-top:24px">
        数据存储于 <code class="jp-code">{{ state.appInfo?.dataDir }}</code> · 可在「设置」中更改 · v{{ state.appInfo?.version }}
      </p>
    </div>

    <Modal v-if="delTarget" title="删除家谱" danger confirm-text="删除"
      :message="`确认删除「${delTarget.name}」？数据将移入回收站，可在提示条中撤销。`"
      @confirm="doDelete" @cancel="delTarget = null" />
    <Teleport to="body">
      <div v-if="dupTarget" class="jp-modal-mask" @click.self="dupTarget = null">
        <div class="jp-modal" role="dialog" aria-modal="true" aria-label="复制家谱">
          <h3>复制家谱</h3>
          <div class="jp-modal-body">
            <div class="jp-field"><span>副本名称</span><input v-model="dupName" type="text" aria-label="副本名称"></div>
          </div>
          <div class="jp-modal-actions">
            <button @click="dupTarget = null">取消</button>
            <button class="jp-primary" @click="doDup">复制</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>