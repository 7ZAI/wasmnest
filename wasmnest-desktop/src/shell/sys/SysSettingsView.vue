<template>
  <!-- ==================== 外观入口（2026-10-28 用户裁决） ====================
       背景与所有样式调整项（明暗模式 / 语言 / 字号 / 动画 / 壁纸 / 主题预设）收进
       「外观」二级页（SysAppearanceView，/sys/settings/appearance，同一张系统页卡
       内切子路由），本页只留入口卡与功能分组。 -->
  <ShellCard :title="t('shell.settings.appearanceEntry.title')" icon="theme">
    <div class="row-sw">
      <div class="lb">
        <b>{{ t('shell.settings.appearanceEntry.desc') }}</b>
      </div>
      <button class="shell-mini" @click="state.openSys('settings', 'appearance')">
        <ShellIcon name="theme" :size="12" />
        {{ t('shell.settings.appearanceEntry.open') }}
      </button>
    </div>
  </ShellCard>

  <!-- ==================== 系统 / 日志（复用既有设置分组组件，零重写） ====================
       链路加密属终端的业务设置（加密哪些通道取决于终端数据面），已随设置归属回归
       bedcode wasm-app，宿主系统页不再承载。
       应用贡献的动态扩展设置项渲染在「系统设置」卡内（SettingsSystemSection），
       无独立「扩展设置」分组（用户 2026-10-22 裁决）。 -->
  <SettingsSystemSection />
  <SettingsLoggingSection />

  <!-- 授权管理入口（一级系统页互切，spec-c §3） -->
  <ShellCard :title="t('shell.settings.permsEntry.title')" icon="shield">
    <div class="row-sw">
      <div class="lb">
        <b>{{ t('shell.settings.permsEntry.desc') }}</b>
      </div>
      <button class="shell-mini" @click="state.openSys('perms')">
        <ShellIcon name="shield" :size="12" /> {{ t('shell.settings.permsEntry.open') }}
      </button>
    </div>
  </ShellCard>

  <!-- 恢复初始设置（破坏性操作：清授权记录 + 还原默认配置，弹窗确认） -->
  <SettingsResetSection />

  <!-- 关于固定收尾（用户 2026-10-20 裁决）：版本 / 更新等只读信息放在所有可操作
       分组之后，避免破坏性复位按钮把「关于」夹在中间。 -->
  <SettingsAboutSection />
</template>

<script setup lang="ts">
/**
 * SysSettingsView — 系统页「设置」（壳内实现）
 *
 * 2026-10-28 用户裁决：背景与所有样式调整项收进「外观」二级页（SysAppearanceView），
 * 本页顶部留「外观」入口卡（与授权入口同构：desc + 打开按钮，openSys 子路由段），
 * 之后是功能分组——系统 / 日志 / 授权入口 / 复位 / 关于（关于固定最后）。
 * 授权管理入口互切到「权限与授权」系统页卡（spec-c §3 同构卡片）。
 */
import { useI18n } from 'vue-i18n'
import SettingsSystemSection from '@/shell/settings/SettingsSystemSection.vue'
import SettingsLoggingSection from '@/shell/settings/SettingsLoggingSection.vue'
import SettingsAboutSection from '@/shell/settings/SettingsAboutSection.vue'
import SettingsResetSection from '@/shell/settings/SettingsResetSection.vue'
import { useShellState } from '../composables/useShellState'
import ShellIcon from '../components/ShellIcon.vue'
import ShellCard from '../components/ShellCard.vue'

const { t } = useI18n()
const state = useShellState()
</script>

<style scoped>
/* 行控件行（label 左 / 控件右）：外观二级页（SysAppearanceView）与本页授权入口卡
   同构（两处消费，未到 shell.css 的 3+ 组件门槛，按其规则各自 scoped 持有） */
.row-sw {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 2px;
}
.row-sw .lb {
  flex: 1;
  min-width: 0;
}
.row-sw .lb b {
  display: block;
  font-size: calc(12.5px * var(--ui-scale));
  font-weight: 600;
  letter-spacing: -0.005em;
  color: var(--text-primary);
}
</style>
