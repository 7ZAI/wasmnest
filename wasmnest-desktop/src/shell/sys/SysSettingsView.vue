<template>
  <!-- ==================== 界面（壳内实现：深浅色/语言/字号/动画/导航按钮） ====================
       主题色板属各 wasm-app 的样式主题：由应用自己设置页持有（床 desktop 的
       useAppPalette），宿主只控制壳自身的深浅色，不下发/不覆盖色板。 -->
  <ShellCard :title="t('shell.settings.ui.title')" icon="theme">
    <!-- 深浅色：三档分段控件（宿主壳唯一掌握的主题项） -->
    <div class="row-sw">
      <div class="lb">
        <b>{{ t('settings.appearance.theme') }}</b>
      </div>
      <ShellSeg
        :options="themeOptions"
        :model-value="settingsStore.settings.ui.theme"
        @update:model-value="setTheme"
      />
    </div>

    <!-- 语言 -->
    <div class="row-sw">
      <div class="lb">
        <b>{{ t('shell.settings.ui.language') }}</b>
      </div>
      <ShellSeg
        :options="languageOptions"
        :model-value="i18nLocale"
        @update:model-value="setLanguage"
      />
    </div>

    <!-- 字号 -->
    <div class="fld">
      <span class="lb"
        >{{ t('shell.settings.ui.fontSize') }} ·
        <span class="mono">{{ settingsStore.settings.ui.font_size }}px</span></span
      >
      <div class="size-row">
        <input
          type="range"
          min="10"
          max="16"
          step="1"
          :value="settingsStore.settings.ui.font_size"
          :aria-label="t('shell.settings.ui.fontSize')"
          @input="setFontSize(Number(($event.target as HTMLInputElement).value))"
        />
      </div>
    </div>

    <!-- 动画 -->
    <div class="row-sw">
      <div class="lb">
        <b>{{ t('shell.settings.ui.animations') }}</b>
      </div>
      <label class="shell-sw">
        <input
          type="checkbox"
          :checked="settingsStore.settings.ui.animations_enabled !== false"
          :aria-label="t('shell.settings.ui.animations')"
          @change="toggleAnimations"
        />
        <span class="track"></span><span class="knob"></span>
      </label>
    </div>
  </ShellCard>

  <!-- ==================== 背景（壳专属：token 派生渐变壁纸 + 遮罩强度） ==================== -->
  <ShellCard :title="t('shell.settings.background.title')" icon="layers">
    <div class="fld">
      <span class="lb">{{ t('shell.settings.background.wallLabel') }}</span>
      <div class="pal-grid">
        <button
          v-for="w in wallpapers"
          :key="w.id"
          class="pal-card"
          :class="{ on: prefs.wallpaper === w.id }"
          :aria-pressed="prefs.wallpaper === w.id"
          @click="prefs.wallpaper = w.id"
        >
          <span class="pal-sw" :class="w.id === 'none' ? '' : ['wall-swatch', 'wall-' + w.id]">
            <i v-if="w.id === 'none'" :style="{ background: 'var(--bg-page)' }"></i>
          </span>
          <!-- 选中标记：不画黑框，用一颗实心勾章落在卡片右上角 -->
          <span v-if="prefs.wallpaper === w.id" class="pal-check" aria-hidden="true">
            <ShellIcon name="check" :size="10" :stroke-width="2.8" />
          </span>
          <span class="nm">{{ t(w.nameKey) }}</span>
        </button>
        <!-- 自定义图片：已选图时显示缩略图；点击已选图只切换壁纸，不重新弹对话框 -->
        <button
          class="pal-card"
          :class="{ on: prefs.wallpaper === 'custom' }"
          :aria-pressed="prefs.wallpaper === 'custom'"
          :aria-busy="customBusy"
          @click="onCustomTile"
        >
          <span class="pal-sw pal-custom">
            <img v-if="customImageUrl" :src="customImageUrl" alt="" />
            <span v-else class="pal-custom-empty">
              <ShellIcon name="plus" :size="13" />
            </span>
          </span>
          <span v-if="prefs.wallpaper === 'custom'" class="pal-check" aria-hidden="true">
            <ShellIcon name="check" :size="10" :stroke-width="2.8" />
          </span>
          <span class="nm">{{ t('shell.settings.background.wall.custom') }}</span>
        </button>
      </div>
    </div>
    <div class="fld">
      <span class="lb">{{ t('shell.settings.background.dimLabel', { pct: prefs.wallDim }) }}</span>
      <div class="size-row">
        <input
          type="range"
          min="0"
          max="70"
          step="10"
          :value="prefs.wallDim"
          :aria-label="t('shell.settings.background.dimLabel', { pct: prefs.wallDim })"
          @input="prefs.wallDim = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ prefs.wallDim }}%</span>
      </div>
    </div>
    <div class="fld">
      <!-- 未选图时自定义图块本身就是入口（点击直接弹取图框），不再重复放“选择图片”按钮；
           已有图时才显示“更换 / 移除”两个维护动作。 -->
      <div v-if="hasCustomImage" class="custom-row">
        <button class="shell-mini" :disabled="customBusy" @click="chooseCustomWallpaper">
          <ShellIcon name="plus" :size="12" />
          {{ t('shell.settings.background.customReplace') }}
        </button>
        <button class="shell-mini" :disabled="customBusy" @click="removeCustomWallpaper">
          <ShellIcon name="trash" :size="12" /> {{ t('shell.settings.background.customRemove') }}
        </button>
      </div>
      <span class="hint">{{ t('shell.settings.background.customHint') }}</span>
    </div>
  </ShellCard>

  <!-- ==================== 系统 / 日志 / 关于（复用既有设置分组组件，零重写） ====================
       链路加密属终端的业务设置（加密哪些通道取决于终端数据面），已随设置归属回归
       bedcode wasm-app，宿主系统页不再承载。 -->
  <SettingsSystemSection />
  <SettingsLoggingSection />
  <SettingsAboutSection />

  <!-- 恢复初始设置（破坏性操作：清授权记录 + 还原默认配置，弹窗确认） -->
  <SettingsResetSection />

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
</template>

<script setup lang="ts">
/**
 * SysSettingsView — 系统页「设置」（壳内实现）
 *
 * 界面 / 背景两组是壳专属（含导航按钮显隐、壁纸，纯壳偏好落 useShellSettings）。
 * 界面组只保留壳自身的**深浅色**；主题色板归各 wasm-app（应用自己的设置页持有，
 * 宿主不下发也不覆盖）。链路加密属 bedcode 业务设置，随设置归属回归应用。
 * 系统 / 日志 / 关于直接复用既有设置分组组件（真实命令面，零重写）。
 * 授权管理入口互切到「权限与授权」系统页卡（spec-c §3 同构卡片）。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/settings'
import { useI18nStore } from '@/stores/i18n'
import { useFontSize } from '@/composables/useFontSize'
import { useToast } from '@/composables/useToast'
import { showUserError } from '@/utils/userError'
import SettingsSystemSection from '@/shell/settings/SettingsSystemSection.vue'
import SettingsLoggingSection from '@/shell/settings/SettingsLoggingSection.vue'
import SettingsAboutSection from '@/shell/settings/SettingsAboutSection.vue'
import SettingsResetSection from '@/shell/settings/SettingsResetSection.vue'
import { useShellState } from '../composables/useShellState'
import { useShellSettings } from '../composables/useShellSettings'
import { WALLPAPER_DEFAULT, WALLPAPERS } from '../composables/state'
import { useCustomWallpaper } from '../composables/customWallpaper'
import { isCustomWallpaperFile } from '../composables/wallpaperFile'
import ShellIcon from '../components/ShellIcon.vue'
import ShellCard from '../components/ShellCard.vue'
import ShellSeg from '../components/ShellSeg.vue'

const { t, locale } = useI18n()
const i18nLocale = computed(() => locale.value)
const settingsStore = useSettingsStore()
const i18nStore = useI18nStore()
const { setupFontSize } = useFontSize()
const state = useShellState()
const { prefs } = useShellSettings()
const toast = useToast()
const {
  imageUrl: customImageUrl,
  pick: pickCustomWallpaper,
  clear: clearCustomWallpaper,
} = useCustomWallpaper()

const customBusy = ref(false)
const hasCustomImage = computed(() => isCustomWallpaperFile(prefs.value.wallpaperImage))

/** 自定义图块：已有图 → 只切换壁纸；没有图 → 直接打开取图对话框 */
function onCustomTile() {
  if (hasCustomImage.value) {
    prefs.value.wallpaper = 'custom'
    return
  }
  void chooseCustomWallpaper()
}

async function chooseCustomWallpaper() {
  if (customBusy.value) return
  customBusy.value = true
  try {
    const file = await pickCustomWallpaper()
    if (!file) return // 用户取消：不改偏好、不提示成功
    prefs.value.wallpaperImage = file
    prefs.value.wallpaper = 'custom'
    toast.success(t('shell.settings.background.customSaved'))
  } catch (e) {
    showUserError(e)
  } finally {
    customBusy.value = false
  }
}

async function removeCustomWallpaper() {
  if (customBusy.value) return
  customBusy.value = true
  try {
    await clearCustomWallpaper()
    prefs.value.wallpaperImage = ''
    if (prefs.value.wallpaper === 'custom') prefs.value.wallpaper = WALLPAPER_DEFAULT
    toast.success(t('shell.settings.background.customRemoved'))
  } catch (e) {
    showUserError(e)
  } finally {
    customBusy.value = false
  }
}

const themeOptions = computed(() => [
  { value: 'light', label: t('shell.settings.ui.themeLight') },
  { value: 'dark', label: t('shell.settings.ui.themeDark') },
  { value: 'system', label: t('shell.settings.ui.themeSystem') },
])

const wallpapers = computed(() => WALLPAPERS.map((w) => ({ ...w, nameKey: w.nameKey })))

/** 语言：分段控件（不写下拉；标签不带 locale 代码括号） */
const languageOptions = computed(() => [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
])

function setTheme(v: string) {
  settingsStore.settings.ui.theme = v
  void settingsStore.saveSettings({ ui: settingsStore.settings.ui })
}
function setLanguage(v: string) {
  void i18nStore.setLanguage(v)
}
/** 拖动滑杆时只即时生效、停止拖动后再落盘（每 px 一次 IPC 会拖慢手感） */
let fontSizeSaveTimer: ReturnType<typeof setTimeout> | null = null
function setFontSize(n: number) {
  settingsStore.settings.ui.font_size = n
  setupFontSize()
  if (fontSizeSaveTimer) clearTimeout(fontSizeSaveTimer)
  fontSizeSaveTimer = setTimeout(() => {
    void settingsStore.saveSettings({ ui: settingsStore.settings.ui })
  }, 250)
}
function toggleAnimations() {
  settingsStore.settings.ui.animations_enabled = !(
    settingsStore.settings.ui.animations_enabled !== false
  )
  void settingsStore.saveSettings({ ui: settingsStore.settings.ui })
}
</script>

<style scoped>
.row-sw {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 2px;
}
.row-sw + .row-sw {
  border-top: 1px solid var(--border);
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
.row-sw .lb span {
  display: block;
  font-size: calc(11.5px * var(--ui-scale));
  color: var(--text-tertiary);
  margin-top: 2px;
  line-height: 1.45;
}
.fld {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.fld .lb {
  font-size: calc(11.5px * var(--ui-scale));
  color: var(--text-secondary);
}
.fld .hint {
  font-size: calc(11px * var(--ui-scale));
  color: var(--text-tertiary);
}
.shell-inp {
  height: 28px;
  padding: 0 9px;
  background: var(--bg-input);
  border: 1px solid var(--border-input);
  border-radius: var(--radius-input);
  color: var(--text-primary);
  outline: none;
  font-size: calc(12px * var(--ui-scale));
  transition:
    border-color var(--motion-duration-base) var(--motion-ease),
    box-shadow var(--motion-duration-base) var(--motion-ease);
}
.shell-inp:focus {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-input-focus);
}
.size-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.size-row input[type='range'] {
  accent-color: var(--color-primary);
  width: 100%;
  cursor: pointer;
}
.size-row .val {
  font-family: var(--font-mono);
  font-size: calc(11px * var(--ui-scale));
  color: var(--text-secondary);
  min-width: 34px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.pal-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: 8px;
}
.pal-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 8px;
  border-radius: var(--radius-button);
  border: 1px solid var(--border);
  background: var(--bg-card);
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--motion-duration-fast) var(--motion-ease),
    border-color var(--motion-duration-fast) var(--motion-ease),
    box-shadow var(--motion-duration-fast) var(--motion-ease);
}
/* 悬停只换表面色阶；选中态同理——边框保持中性，不再染成近黑的主色。 */
.pal-card:hover {
  background: var(--bg-hover);
}
.pal-card.on {
  background: var(--selection-tint);
  border-color: var(--border);
}
/* 选中勾章：固定黑底白勾（不随明暗反转），压在卡片右上角；
   外圈用文本色淡光晕，深色主题下也能从暗壁纸上浮出来。 */
.pal-check {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--selection-solid);
  color: var(--selection-solid-ink);
  box-shadow:
    0 0 0 2px var(--selection-halo),
    0 1px 4px color-mix(in srgb, var(--text-primary) 24%, transparent);
}
.pal-sw {
  display: flex;
  height: 24px;
  border-radius: 5px;
  overflow: hidden;
  border: 1px solid var(--border);
}
.pal-sw i {
  flex: 1;
}
.pal-sw i + i {
  border-left: 1px solid var(--border);
}
/* 自定义图片缩略图：cover 裁切，占满 24px 色块高度；未选图时显示加号占位 */
.pal-sw.pal-custom {
  background: var(--bg-hover);
}
.pal-sw.pal-custom img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.pal-custom-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
}
.custom-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.pal-card .nm {
  font-size: calc(11.5px * var(--ui-scale));
  color: var(--text-secondary);
}
.pal-card.on .nm {
  color: var(--text-primary);
  font-weight: 500;
}
.mono {
  font-family: var(--font-mono);
}
</style>
