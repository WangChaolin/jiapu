<script setup lang="ts">
withDefaults(defineProps<{
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
}>(), { confirmText: '确认', cancelText: '取消', danger: false })
const emit = defineEmits<{ confirm: []; cancel: [] }>()
</script>

<template>
  <div class="jp-modal-mask" @click.self="emit('cancel')">
    <div class="jp-modal" role="dialog" aria-modal="true" :aria-label="title">
      <h3>{{ title }}</h3>
      <div class="jp-modal-body">{{ message }}</div>
      <div class="jp-modal-actions">
        <button @click="emit('cancel')">{{ cancelText }}</button>
        <button :class="danger ? 'jp-danger jp-primary' : 'jp-primary'" autofocus @click="emit('confirm')">{{ confirmText }}</button>
      </div>
    </div>
  </div>
</template>