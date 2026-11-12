/**
 * 壳内深浅色（壳自足面）
 *
 * 真源 = `<html>` 上的 `.dark` 类：宿主 `applyTheme` 写的那一份，壳与应用共用同一
 * 个明暗事实；壳内本来就按这个类取样式（`SplashLoading` 的 `html.dark` 分支）。
 *
 * 为什么壳内不复制一份「读设置 + 监听系统偏好」：
 * - 那会让壳多一个媒体查询监听与一份可能与应用层漂移的副本；
 * - L7 锁（壳内自足）也明确禁止壳依赖 `@/composables/**`——旧机制目录退役时壳不能
 *   跟着断链。深浅色是**壳自己 DOM 上的事实**，直接读它最省依赖。
 *
 * 响应式：类名变化用 MutationObserver 捕获（`class` 属性也承载 platform-linux /
 * anim-disabled 等其它类，故每次重读整串而不是比对增量）。
 */
import { computed, getCurrentScope, onScopeDispose, ref } from 'vue'

export function useShellDark() {
  const isDark = ref(document.documentElement.classList.contains('dark'))

  const observer = new MutationObserver(() => {
    isDark.value = document.documentElement.classList.contains('dark')
  })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  // 组件卸载时停观察；无作用域（模块级调用）时不注销——观察器与文档同生命周期。
  if (getCurrentScope()) onScopeDispose(() => observer.disconnect())

  return computed(() => isDark.value)
}
