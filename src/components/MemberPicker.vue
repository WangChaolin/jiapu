<script setup lang="ts">
import { ref, computed } from 'vue'
import type { Member } from '@shared/types'

const props = withDefaults(defineProps<{
  modelValue: string | null
  members: Member[]
  placeholder?: string
  exclude?: string[]
}>(), { placeholder: '搜索并选择成员', exclude: () => [] })

const emit = defineEmits<{ 'update:modelValue': [string | null] }>()

const query = ref('')
const open = ref(false)
const selected = computed(() => props.members.find((m) => m.id === props.modelValue) ?? null)
const filtered = computed(() => {
  const ex = new Set(props.exclude)
  const q = query.value.trim()
  return props.members.filter((m) => !ex.has(m.id) && (!q || m.name.includes(q) || m.courtesyName.includes(q))).slice(0, 60)
})
function pick(m: Member): void {
  emit('update:modelValue', m.id)
  open.value = false
  query.value = ''
}
function clear(): void { emit('update:modelValue', null); query.value = '' }
function onFocus(): void { open.value = true; query.value = '' }
function onBlur(): void { setTimeout(() => { open.value = false }, 150) }
</script>

<template>
  <div style="position:relative;flex:1;min-width:120px">
    <div style="display:flex;gap:4px;align-items:center">
      <input type="text" :value="open ? query : (selected ? selected.name : '')" :placeholder="placeholder"
        style="flex:1" role="combobox" :aria-expanded="open" aria-autocomplete="list"
        @focus="onFocus" @blur="onBlur" @input="query = ($event.target as HTMLInputElement).value; open = true">
      <button v-if="selected && !open" type="button" class="jp-link" style="min-height:28px;padding:0 4px" aria-label="清除选择" @mousedown.prevent="clear">✕</button>
    </div>
    <ul v-if="open" style="position:absolute;z-index:30;left:0;right:0;top:36px;max-height:220px;overflow-y:auto;background:var(--jp-surface);border:1px solid var(--jp-line);border-radius:8px;margin:0;padding:4px;list-style:none;box-shadow:0 6px 20px rgba(0,0,0,.18)">
      <li v-if="!filtered.length" class="jp-muted" style="padding:6px 8px">无匹配成员</li>
      <li v-for="m in filtered" :key="m.id">
        <button type="button" style="width:100%;text-align:left;background:none;border:none;display:flex;justify-content:space-between;gap:8px;padding:6px 8px;min-height:30px"
          @mousedown.prevent="pick(m)">
          <span>{{ m.name }}<span v-if="m.courtesyName" class="jp-muted"> · {{ m.courtesyName }}</span></span>
          <span class="jp-muted">{{ m.gender }} · {{ m.generation }}世</span>
        </button>
      </li>
    </ul>
  </div>
</template>