<template>
  <div class="h-full flex flex-col items-center justify-center gap-4 bg-[var(--bg-page)]">
    <p class="text-[calc(13px*var(--ui-scale))] font-semibold text-[var(--text-primary)]">
      {{ t('desktop.notFound.title') }}
    </p>
    <p class="text-xs text-[var(--text-tertiary)]">{{ t('desktop.notFound.body') }}</p>
    <button class="wb-btn-ghost" @click="router.push('/sessions')">
      {{ t('desktop.notFound.back') }}
    </button>
  </div>
</template>

<script setup lang="ts">
/**
 * 未匹配路由兜底视图（D3 fail-visible）
 *
 * 退役面（/plugins 应用中心、/shell 设备壳、/plugin/* 插件视图路由）直接访问时
 * 落此页：显性 not-found，不白屏、不静默回落。
 */
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

const { t } = useI18n()
const router = useRouter()
</script>
