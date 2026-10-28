<script setup lang="ts">
/**
 * 扩展项渲染错误边界
 *
 * 壳只提供容器；状态栏扩展 component 是第三方代码。渲染阶段抛错若直接冒泡，
 * 会落到 main.ts 全局 errorHandler——弹通用「发生了未知错误」且每次重渲染反复触发
 * （全局处理器无法定位具体扩展项）。这里把渲染错误就地隔离：单个扩展渲染失败
 * → 记一条日志并回退为空，状态栏其余条目不受影响。
 */
import { onErrorCaptured, ref } from 'vue'
import { logger } from '@/utils/frontendLogger'

const failed = ref(false)

onErrorCaptured((error, _instance, info) => {
  logger.error(`[Shell] status bar extension render failed (${info})`, error)
  failed.value = true
  // 就地吞掉：不再向父级 / 全局 errorHandler 冒泡
  return false
})
</script>

<template>
  <slot v-if="!failed" />
</template>