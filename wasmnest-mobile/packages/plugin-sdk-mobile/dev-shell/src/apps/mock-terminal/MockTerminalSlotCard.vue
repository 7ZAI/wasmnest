<script setup lang="ts">
/**
 * 会话状态磁贴（内置应用贡献给平台首页的快捷卡片）
 *
 * 用来在预览环境里真实跑通 `registerSlot` 这条路径：壳的首页会渲染应用注册的卡片
 * 组件，插件开发者在这里能确认自己的 slot 组件在壳的布局里表现如何（而不是自己
 * 搭一个假首页去验）。
 *
 * 外观用 SDK 公共 QuickCard（`src/ui/QuickCard.vue`；dev-shell 不装自己的 npm 包，
 * 故以内联源码路径引用）。点击与跳转归宿主壳——整张卡由壳包成按钮并打开本应用，
 * 卡片内不再放按钮 / 交互。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import QuickCard from '../../../../src/ui/QuickCard.vue'
import { sessions } from '../../mock/session'

/** 壳透传的应用上下文（本卡不消费，留着是为了与 slot 契约一致） */
defineProps<{ app?: { id: string; name: string } }>()

const ICON = ['M4 5h16v14H4z', 'M8 10l3 2.5-3 2.5', 'M13.5 15H16']

const running = ref(0)

function refresh(): void {
  running.value = sessions.value.filter((s) => s.status === 'running').length
}

const timer = setInterval(refresh, 1000)
onMounted(refresh)
onUnmounted(() => clearInterval(timer))

const hint = computed(() => `mock · ${running.value} running`)
</script>

<template>
  <QuickCard
    label="mock-terminal"
    :value="running"
    :hint="hint"
    :tone="running > 0 ? 'success' : 'neutral'"
    :icon-path="ICON"
  />
</template>