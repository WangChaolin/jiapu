<script setup lang="ts">
import { onMounted } from 'vue'
import { state, init, dismissToast } from './store'
import HomeView from './views/HomeView.vue'
import ShellView from './views/ShellView.vue'

onMounted(() => { init().catch((e) => console.error(e)) })
</script>

<template>
  <div v-if="!state.ready" style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center">
    <div class="jp-seal" style="margin-bottom:16px">家谱</div>
    <p class="jp-muted">正在载入…</p>
  </div>
  <HomeView v-else-if="!state.current" />
  <ShellView v-else />
  <div class="jp-toast-wrap" aria-live="polite">
    <div v-for="t in state.toasts" :key="t.id" class="jp-toast" :class="{ 'jp-toast-err': t.type === 'err' }" role="status">
      <span>{{ t.msg }}</span>
      <button v-if="t.action" @click="t.action.fn(); dismissToast(t.id)">{{ t.action.label }}</button>
      <button v-else aria-label="关闭提示" @click="dismissToast(t.id)">✕</button>
    </div>
  </div>
</template>