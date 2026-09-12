<script setup lang="ts">
/**
 * Small labelled switch. v-model'd boolean, disabled while an action runs.
 *
 * `label` is optional so the same control can be used bare (no caption) inside
 * a table row, where the row itself already says what is being switched.
 */
defineProps<{
  modelValue: boolean;
  label?: string;
  hint?: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{ (e: "update:modelValue", value: boolean): void }>();
</script>

<template>
  <div class="flex items-start justify-between gap-4">
    <div v-if="label">
      <div class="text-[12.5px] font-medium">{{ label }}</div>
      <div v-if="hint" class="text-[11.5px]" :style="{ color: 'var(--wb-muted)' }">
        {{ hint }}
      </div>
    </div>
    <button
      type="button"
      role="switch"
      :aria-checked="modelValue"
      :disabled="disabled"
      class="relative mt-0.5 h-[18px] w-[32px] shrink-0 rounded-full border transition-colors"
      :style="{
        background: modelValue ? 'var(--wb-accent)' : 'var(--wb-panel-2)',
        borderColor: modelValue ? 'var(--wb-accent)' : 'var(--wb-border)',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }"
      @click="emit('update:modelValue', !modelValue)"
    >
      <span
        class="absolute top-[2px] h-[12px] w-[12px] rounded-full bg-white transition-all"
        :style="{ left: modelValue ? '17px' : '2px' }"
      />
    </button>
  </div>
</template>
