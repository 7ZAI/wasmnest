<template>
  <div class="flex flex-col flex-1 min-h-0 desktop-ui bg-page text-[var(--text-primary)]">
    <!-- 键盘导航跳过链接（ui-ux-pro-max --domain ux：nav-heavy 页需 skip link） -->
    <a
      href="#shell-main"
      class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[9999] focus:px-3 focus:py-1.5 focus:rounded-btn focus:bg-card focus:border focus:border-[var(--border-strong)] focus:text-[var(--text-primary)]"
    >
      {{ t('shell.skipToContent') }}
    </a>

    <!-- 顶部工具栏（主屏 chrome：品牌 · 当前位置 · 导航 · 全局入口 · 窗口控制） -->
    <ShellToolbar />

    <!-- 舞台：主屏（home）。全屏面（应用界面 / 系统页）由 ShellHost 分流渲染 -->
    <main id="shell-main" class="stage">
      <ShellHome />
    </main>
  </div>
</template>

<script setup lang="ts">
/**
 * ShellView — 壳主屏（方案 C：主屏 = 应用网格 + 系统网格 + type-to-search）
 *
 * 2026-10-17 壳恢复后收窄为主屏专用：全局覆层（多任务 / 通知 / 右键 / 弹窗 /
 * 启动屏）与键盘处理提升到 ShellHost（任何面可用）；路由 '/' 挂载本组件。
 * 主题 / 字号由 ShellHost 全局 setup（本组件不再重复挂卸载）。
 */
import { useI18n } from 'vue-i18n'
import ShellToolbar from './components/ShellToolbar.vue'
import ShellHome from './components/ShellHome.vue'

const { t } = useI18n()
</script>

<style scoped>
.stage {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
}
</style>
