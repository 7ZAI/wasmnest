<template>
  <Transition name="shell-panel">
    <div
      v-if="open"
      class="qs-panel shell-quick-root"
      role="dialog"
      :aria-label="t('shell.quickSettings.title')"
    >
      <!-- 面板头 -->
      <div class="panel-h">
        <span class="t">{{ t('shell.quickSettings.title') }}</span>
        <span class="grow"></span>
        <button
          class="shell-mini"
          :aria-label="t('shell.quickSettings.close')"
          @click="close"
        >
          <ShellIcon name="x" :size="12" />
        </button>
      </div>

      <!-- 快捷开关 2×2（主题 / 动画 / 链路加密 / 防休眠）。
           2026-10-19 自通知中心拆分：通知面板只保留通知内容，这里单独成面。 -->
      <div class="panel-in">
        <div class="tiles">
          <button class="tile" :class="{ on: isDark }" @click="toggleTheme">
            <!-- 深浅色切换图标加大一号（用户要求）：区别于其余快捷开关的 15px -->
            <ShellIcon name="theme" :size="20" />
            <span class="tt">
              <b>{{ t('shell.quickSettings.tileTheme') }}</b>
              <span>{{ isDark ? t('shell.quickSettings.on') : t('shell.quickSettings.off') }}</span>
            </span>
          </button>
          <button class="tile" :class="{ on: animationsEnabled }" @click="toggleAnimations">
            <ShellIcon name="bolt" :size="15" />
            <span class="tt">
              <b>{{ t('shell.quickSettings.tileAnim') }}</b>
              <span>{{ animationsEnabled ? t('shell.quickSettings.on') : t('shell.quickSettings.off') }}</span>
            </span>
          </button>
          <button class="tile" :class="{ on: cryptoEnabled }" @click="toggleCrypto">
            <ShellIcon name="lock" :size="15" />
            <span class="tt">
              <b>{{ t('shell.quickSettings.tileCrypto') }}</b>
              <span>{{ cryptoEnabled ? t('shell.quickSettings.on') : t('shell.quickSettings.off') }}</span>
            </span>
          </button>
          <button class="tile" :class="{ on: preventSleep }" @click="togglePreventSleep">
            <ShellIcon name="sleep" :size="15" />
            <span class="tt">
              <b>{{ t('shell.quickSettings.tileSleep') }}</b>
              <span>{{ preventSleep ? t('shell.quickSettings.on') : t('shell.quickSettings.off') }}</span>
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
 * 快捷开关 2×2：深色主题 / 动画 / 链路加密 / 防止休眠——即改即存（settings store
 * 整表回传，useTheme 即时应用）。原本混在通知中心顶部，拆成独立浏览面，由工具栏
 * 独立图标（sliders）开合，与通知 / 多任务互斥（互斥收口在 useShellState）。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/settings'
import { useLinkCryptoConfig } from '@/shell/settings/useLinkCrypto'
import { useTheme } from '@/composables/useTheme'
import { useShellState } from '../composables/useShellState'
import ShellIcon from './ShellIcon.vue'

const { t } = useI18n()
const state = useShellState()
const settingsStore = useSettingsStore()
const { isSystemDark } = useTheme()
const { config: cryptoConfig, loadLinkCryptoConfig, saveLinkCryptoConfig } = useLinkCryptoConfig()

const open = computed(() => state.quickSettingsOpen.value)

const isDark = computed(() =>
  settingsStore.settings.ui.theme === 'dark'
    ? true
    : settingsStore.settings.ui.theme === 'light'
      ? false
      : isSystemDark.value,
)
const animationsEnabled = computed(() => settingsStore.settings.ui.animations_enabled !== false)
const cryptoEnabled = computed(() => cryptoConfig.value?.enabled ?? false)
const preventSleep = computed(() => settingsStore.settings.network.prevent_sleep ?? false)

function toggleTheme() {
  settingsStore.settings.ui.theme = isDark.value ? 'light' : 'dark'
  void settingsStore.saveSettings({ ui: settingsStore.settings.ui })
}
function toggleAnimations() {
  settingsStore.settings.ui.animations_enabled = !animationsEnabled.value
  void settingsStore.saveSettings({ ui: settingsStore.settings.ui })
}
async function toggleCrypto() {
  const cur = cryptoConfig.value
  if (!cur) await loadLinkCryptoConfig()
  if (cryptoConfig.value) {
    await saveLinkCryptoConfig({ ...cryptoConfig.value, enabled: !cryptoConfig.value.enabled })
  }
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
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sheet);
  box-shadow: var(--shadow-card-hover);
  overflow: hidden;
}
.panel-h {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px 0;
}
.panel-h .t {
  font-size: calc(13px * var(--ui-scale));
  font-weight: 600;
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
.tile {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border-radius: var(--radius-button);
  background: var(--bg-sidebar);
  border: 1px solid var(--border);
  text-align: left;
  cursor: pointer;
  transition:
    background-color 0.15s,
    border-color 0.15s;
}
.tile:hover {
  border-color: var(--border-strong);
}
.tile.on {
  background: var(--color-primary-light);
  border-color: color-mix(in srgb, var(--color-primary) 30%, transparent);
}
.tile .tt {
  min-width: 0;
}
.tile .tt b {
  display: block;
  font-size: calc(12px * var(--ui-scale));
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
}
.tile .tt span {
  display: block;
  font-size: calc(11px * var(--ui-scale));
  color: var(--text-tertiary);
  white-space: nowrap;
}
.shell-panel-enter-active,
.shell-panel-leave-active {
  transition: opacity 0.15s ease;
}
.shell-panel-enter-from,
.shell-panel-leave-to {
  opacity: 0;
}
</style>
