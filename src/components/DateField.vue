<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { solarToLunarParts, lunarPartsToSolar, describeDate, isValidSolar } from '@shared/lunar'

const props = defineProps<{ modelValue: string; lunar: boolean; label: string }>()
const emit = defineEmits<{ 'update:modelValue': [string]; 'update:lunar': [boolean] }>()

const ly = ref(''), lm = ref(''), ld = ref(''), leap = ref(false)

function syncFromSolar(): void {
  const p = solarToLunarParts(props.modelValue)
  if (p) { ly.value = String(p.year); lm.value = String(p.month); ld.value = String(p.day); leap.value = p.leap }
  else { ly.value = ''; lm.value = ''; ld.value = ''; leap.value = false }
}
watch(() => props.modelValue, () => { if (props.lunar) syncFromSolar() }, { immediate: true })
watch(() => props.lunar, (v) => { if (v) syncFromSolar() })

function emitLunar(): void {
  const y = parseInt(ly.value, 10), m = parseInt(lm.value, 10), d = parseInt(ld.value, 10)
  if (y && m && d) {
    const s = lunarPartsToSolar(y, m, d, leap.value)
    if (s) emit('update:modelValue', s)
  } else if (!ly.value && !lm.value && !ld.value) {
    emit('update:modelValue', '')
  }
}
const hint = computed(() => describeDate(props.modelValue, props.lunar))
const invalid = computed(() => !!props.modelValue && !isValidSolar(props.modelValue))
</script>

<template>
  <div class="jp-field">
    <span>{{ label }}</span>
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      <input v-if="!lunar" type="date" :value="modelValue" :aria-label="label + '公历'"
        @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)">
      <template v-else>
        <input v-model="ly" type="number" placeholder="年" style="width:72px" :aria-label="label + '农历年'" @input="emitLunar">
        <input v-model="lm" type="number" min="1" max="12" placeholder="月" style="width:56px" :aria-label="label + '农历月'" @input="emitLunar">
        <input v-model="ld" type="number" min="1" max="30" placeholder="日" style="width:56px" :aria-label="label + '农历日'" @input="emitLunar">
        <label class="jp-muted"><input type="checkbox" v-model="leap" @change="emitLunar">闰月</label>
      </template>
      <select :value="lunar ? '农历' : '公历'" style="width:78px" :aria-label="label + '历法'"
        @change="emit('update:lunar', ($event.target as HTMLSelectElement).value === '农历')">
        <option>公历</option><option>农历</option>
      </select>
    </div>
    <div class="jp-date-hint" :class="{ 'jp-warn': invalid }">{{ invalid ? '日期无效，请检查' : hint.secondary }}</div>
  </div>
</template>