<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { api } from '../api'
import { state, genName, run, bump } from '../store'
import type { Branch, ZibeiPoem } from '@shared/types'

const PUNCT = /[\s，。、；！？,.;!?"'“”‘’（）()《》<>【\]—\-·]/g

const branches = ref<Branch[]>([])
const poems = ref<ZibeiPoem[]>([])
const selected = ref('all')
const poemText = ref('')
const startGen = ref(1)
const newChar = ref('')
const saving = ref(false)

const scopeId = computed<string | null>(() => (selected.value === 'all' ? null : selected.value))
const previewEntries = computed(() =>
  [...poemText.value.replace(PUNCT, '')].map((char, i) => ({ char, generation: startGen.value + i })))
const overrideCount = computed(() => poems.value.filter((p) => p.branchId && p.entries.length).length)

function loadEditor(): void {
  const p = poems.value.find((x) => (x.branchId ?? 'all') === selected.value)
  poemText.value = p?.poem ?? ''
  startGen.value = p?.entries.length ? p.entries[0].generation : 1
}

async function load(): Promise<void> {
  if (!state.current) return
  branches.value = await api.branch.list()
  poems.value = await api.zibei.list()
  loadEditor()
}

async function save(): Promise<void> {
  saving.value = true
  const r = await run(() => api.zibei.setPoem(scopeId.value, poemText.value, startGen.value), '字辈已保存')
  saving.value = false
  if (r) { poems.value = r; bump() }
}
function append(): void {
  const c = newChar.value.trim()
  if (!c) return
  poemText.value += c
  newChar.value = ''
  save()
}
function deleteLast(): void {
  const chars = [...poemText.value.replace(PUNCT, '')]
  if (!chars.length) return
  chars.pop()
  poemText.value = chars.join('')
  save()
}

watch(selected, loadEditor)
watch(() => state.tick, load)
onMounted(load)
</script>

<template>
  <div>
    <div class="jp-page-head">
      <h2 class="jp-page-title jp-serif-c">字辈管理</h2>
      <span class="jp-muted">字辈诗逐字对应世代，录入时自动推荐用字</span>
    </div>
    <div class="jp-panel">
      <div class="jp-toolbar">
        <label>适用范围
          <select v-model="selected" aria-label="字辈适用范围">
            <option value="all">全谱通用</option>
            <option v-for="b in branches" :key="b.id" :value="b.id">{{ b.name }}</option>
          </select>
        </label>
        <label>起始世代
          <input v-model.number="startGen" type="number" min="1" max="50" style="width:72px" aria-label="起始世代">
        </label>
        <span style="flex:1"></span>
        <input v-model="newChar" type="text" maxlength="1" placeholder="新增一字" style="width:90px" aria-label="新增字辈用字" @keydown.enter="append">
        <button @click="append">追加字辈</button>
        <button class="jp-danger" :disabled="!previewEntries.length" @click="deleteLast">删除末字</button>
      </div>
      <div class="jp-field">
        <span>字辈诗（标点仅作分隔，不参与世代）</span>
        <input v-model="poemText" type="text" placeholder="如：国正天心顺，官清民自安"
          style="width:100%;font-family:var(--jp-serif);font-size:15px;letter-spacing:3px" aria-label="字辈诗" @keydown.enter="save">
      </div>
      <div class="jp-toolbar" style="margin-top:10px">
        <button class="jp-primary" :disabled="saving" @click="save">保存字辈</button>
        <span class="jp-muted">共 {{ previewEntries.length }} 字 · {{ selected === 'all' ? '全谱通用' : branches.find(b => b.id === selected)?.name }}</span>
      </div>
      <div v-if="previewEntries.length" class="jp-zibei-grid" aria-live="polite">
        <div v-for="e in previewEntries" :key="e.generation" class="jp-zibei-cell">
          <div class="jp-zibei-char">{{ e.char }}</div>
          <div class="jp-zibei-gen">{{ genName(e.generation) }}</div>
        </div>
      </div>
      <div v-else class="jp-empty"><div class="jp-empty-seal">辈</div>尚未设置字辈，输入字辈诗后保存</div>
      <p class="jp-muted" style="margin-top:10px">
        子支系未单独设置时继承上级 / 全谱字辈；当前已有 {{ overrideCount }} 个支系单独设置。
        姓名与字辈不符时录入页将给出提示（可忽略）；母系外姓成员不校验。
      </p>
    </div>
  </div>
</template>
