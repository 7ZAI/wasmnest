<template>
  <Transition name="shell-panel">
    <div
      v-if="open"
      class="qs-panel shell-quick-root shell-glass"
      role="dialog"
      :aria-label="t('shell.quickSettings.title')"
    >
      <!-- 面板头 -->
      <div class="panel-h">
        <span class="t">{{ t('shell.quickSettings.title') }}</span>
        <span class="grow"></span>
        <button class="shell-mini" :aria-label="t('shell.quickSettings.close')" @click="close">
          <ShellIcon name="x" :size="12" />
        </button>
      </div>

      <!-- 快捷开关（深色主题 / 动画 / 防休眠；三项占单列整行）。
           2026-10-19 自通知中心拆分：通知面板只保留通知内容，这里单独成面。
           链路加密不在此面：它属 bedcode 的业务设置（应用设置页承载），宿主快捷
           面只留壳自身的通用开关。 -->
      <div class="panel-in">
        <div class="tiles">
          <button class="tile" :class="{ on: isDark }" :aria-pressed="isDark" @click="toggleTheme">
            <!-- 深浅色切换图标加大一号（用户要求）：区别于其余快捷开关的 15px -->
            <ShellIcon name="theme" :size="20" />
            <span class="tt">
              <b>{{ t('shell.quickSettings.tileTheme') }}</b>
              <span>{{ isDark ? t('shell.quickSettings.on') : t('shell.quickSettings.off') }}</span>
            </span>
          </button>
          <button
            class="tile"
            :class="{ on: animationsEnabled }"
            :aria-pressed="animationsEnabled"
            @click="toggleAnimations"
          >
            <ShellIcon name="bolt" :size="15" />
            <span class="tt">
              <b>{{ t('shell.quickSettings.tileAnim') }}</b>
              <span>{{
                animationsEnabled ? t('shell.quickSettings.on') : t('shell.quickSettings.off')
              }}</span>
            </span>
          </button>
          <button
            class="tile"
            :class="{ on: preventSleep }"
            :aria-pressed="preventSleep"
            @click="togglePreventSleep"
          >
            <ShellIcon name="sleep" :size="15" />
            <span class="tt">
              <b>{{ t('shell.quickSettings.tileSleep') }}</b>
              <span>{{
                preventSleep ? t('shell.quickSettings.on') : t('shell.quickSettings.off')
              }}</span>
            </span>
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
/**
 * ShellQuickSettings — 快捷设置面板（工具栏锚定下拉；2026-10-19 与通知中心拆分）
 *
 * 快捷开关：深色主题 / 动画 / 防止休眠——即改即存（settings store 整表回传，
 * useTheme 即时应用）。链路加密不在此面（bedcode 业务设置，应用设置页承载）。
 * 原本混在通知中心顶部，拆成独立浏览面，由工具栏独立图标（sliders）开合，
 * 与通知 / 多任务互斥（互斥收口在 useShellState）。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/settings'
import { useTheme } from '@/composables/useTheme'
import { useShellState } from '../composables/useShellState'
import ShellIcon from './ShellIcon.vue'

const { t } = useI18n()
const state = useShellState()
const settingsStore = useSettingsStore()
const { isSystemDark } = useTheme()

const open = computed(() => state.quickSettingsOpen.value)

const isDark = computed(() =>
  settingsStore.settings.ui.theme === 'dark'
    ? true
    : settingsStore.settings.ui.theme === 'light'
      ? false
      : isSystemDark.value,
)
const animationsEnabled = computed(() => settingsStore.settings.ui.animations_enabled !== false)
const preventSleep = computed(() => settingsStore.settings.network.prevent_sleep ?? false)

function toggleTheme() {
  settingsStore.settings.ui.theme = isDark.value ? 'light' : 'dark'
  void settingsStore.saveSettings({ ui: settingsStore.settings.ui })
}
function toggleAnimations() {
  settingsStore.settings.ui.animations_enabled = !animationsEnabled.value
  void settingsStore.saveSettings({ ui: settingsStore.settings.ui })
}
function togglePreventSleep() {
  settingsStore.settings.network.prevent_sleep = !preventSleep.value
  void settingsStore.saveSettings({ network: settingsStore.settings.network })
}

function close() {
  state.quickSettingsOpen.value = false
}
</script>

<style scoped>
.qs-panel {
  position: absolute;
  top: calc(var(--toolbar-h) + 6px);
  right: 8px;
  z-index: 45;
  width: 268px;
  display: flex;
  flex-direction: column;
  /* 表面色与背景模糊由 .shell-glass 提供（浮在主屏图块 / 应用内容之上） */
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sheet);
  box-shadow: var(--shadow-card-hover);
  overflow: hidden;
  transform-origin: top right;
}
.panel-h {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 12px 12px 0;
}
.panel-h .t {
  font-size: calc(14px * var(--ui-scale));
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text-primary);
}
.panel-h .grow {
  flex: 1;
}
.panel-in {
  padding: 12px;
}
.tiles {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
}
/* 奇数项时最后一块占整行（当前 3 项：主题 / 动画 / 防休眠） */
.tiles > :last-child:nth-child(odd) {
  grid-column: span 2;
}
.tile {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px;
  border-radius: var(--radius-button);
  background: var(--bg-sidebar);
  border: 1px solid var(--border);
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--motion-duration-fast) var(--motion-ease),
    border-color var(--motion-duration-fast) var(--motion-ease);
}
.tile svg {
  color: var(--text-secondary);
  transition: color var(--motion-duration-fast) var(--motion-ease);
}
.tile:hover {
  border-color: var(--border-strong);
  background: var(--bg-hover);
}
/* 「开」的档位：固定黑底 + 反白图文（不随明暗主题反转），
   不画深色描边；颜色不是唯一线索——副标题写着「开 / 关」并由 aria-pressed 宣布。 */
.tile.on {
  background: var(--selection-solid);
  /* 透明边框让黑底铺到边，不再出现一圈主色描边 */
  border-color: transparent;
}
.tile.on svg,
.tile.on .tt b,
.tile.on .tt span {
  color: var(--selection-solid-ink);
}
.tile .tt {
  min-width: 0;
}
.tile .tt b {
  display: block;
  font-size: calc(12.5px * var(--ui-scale));
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  letter-spacing: -0.005em;
}
.tile .tt span {
  display: block;
  font-size: calc(11.5px * var(--ui-scale));
  color: var(--text-tertiary);
  white-space: nowrap;
}
/* 面板入场：从触发键方向轻微下压 + 放大到位（只动 transform/opacity） */
.shell-panel-enter-active,
.shell-panel-leave-active {
  transition:
    opacity var(--motion-duration-fast) var(--motion-ease),
    transform var(--motion-duration-fast) var(--motion-ease);
}
.shell-panel-enter-from,
.shell-panel-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.98);
}
</style>
