<template>
  <!-- ==================== 外观（设置页二级页，2026-10-28 用户裁决） ====================
       界面 / 背景 / 主题三组样式调整收进本页：经设置页「外观」入口卡进入
       （/sys/settings/appearance，同一张系统页卡内切子路由）。
       主题色板属各 wasm-app 的样式主题：由应用自己设置页持有（床 desktop 的
       useAppPalette），宿主只控制壳自身的深浅色，不下发/不覆盖色板。 -->
  <ShellCard :title="t('shell.settings.ui.title')" icon="theme">
    <!-- 深浅色：三档分段控件（宿主壳唯一掌握的主题项） -->
    <div class="row-sw">
      <div class="lb">
        <b>{{ t('shell.settings.ui.colorMode') }}</b>
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

    <!-- 字号：五档离散滑杆（极小→超大，2026-10-28 用户裁决），不再按 px 连续取值；
         存量非档位 px 就近吸附显示（useFontSize.fontSizeLevelIndex），拖动后落盘档位 px -->
    <div class="fld">
      <span class="lb"
        >{{ t('shell.settings.ui.fontSize') }} ·
        {{ t(currentFontLevel.labelKey) }}</span
      >
      <div class="size-row">
        <input
          type="range"
          min="0"
          :max="FONT_SIZE_LEVELS.length - 1"
          step="1"
          :value="fontSizeLevel"
          :aria-valuetext="t(currentFontLevel.labelKey)"
          :aria-label="t('shell.settings.ui.fontSize')"
          @input="setFontLevel(Number(($event.target as HTMLInputElement).value))"
        />
      </div>
      <!-- 档位刻度：纯视觉标注（aria-hidden，语义由滑杆 aria-valuetext 承载，不产生重复焦点） -->
      <div class="size-ticks" aria-hidden="true">
        <span
          v-for="(lv, i) in FONT_SIZE_LEVELS"
          :key="lv.labelKey"
          :class="{ on: i === fontSizeLevel }"
          >{{ t(lv.labelKey) }}</span
        >
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

  <!-- ==================== 主题（全局外观预设：内置 4 套 + 扩展注册） ==================== -->
  <SettingsThemeSection />
</template>

<script setup lang="ts">
/**
 * SysAppearanceView — 系统页「设置 → 外观」二级页（壳内实现）
 *
 * 2026-10-28 用户裁决：设置页把背景与所有样式调整项（明暗模式 / 语言 / 字号 /
 * 动画 / 壁纸 / 主题预设）收进「外观」二级页，主设置页只留外观入口卡与功能分组
 * （系统 / 日志 / 授权 / 复位 / 关于）。本页是 /sys/settings/appearance 的页体，
 * 页头（标题 / 返回按钮）由 ShellCardScreen 按 SYS_SUB_PAGES 提供。
 * 界面 / 背景两组是壳专属（纯壳偏好落 useShellSettings）；主题色板归各 wasm-app
 * （应用自己的设置页持有，宿主不下发也不覆盖）。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/settings'
import { useI18nStore } from '@/stores/i18n'
import { useFontSize, FONT_SIZE_LEVELS, fontSizeLevelIndex } from '@/composables/useFontSize'
import { useToast } from '@/composables/useToast'
import { showUserError } from '@/utils/userError'
import SettingsThemeSection from '@/shell/settings/SettingsThemeSection.vue'
import { useShellSettings } from '../composables/useShellSettings'
import { WALLPAPER_DEFAULT, WALLPAPERS } from '../composables/state'
import { useCustomWallpaper } from '../composables/customWallpaper'
import { isCustomWallpaperFile } from '../composables/wallpaperFile'
import ShellIcon from '../components/ShellIcon.vue'
import ShellCard from '../components/ShellCard.vue'
import ShellSeg from '../components/ShellSeg.vue'

const { t, locale } = useI18n()
/** 语言分段控件的当前值（i18n locale 与设置存储双写，控件只读 locale） */
const i18nLocale = computed(() => locale.value)
const settingsStore = useSettingsStore()
const i18nStore = useI18nStore()
const { setupFontSize } = useFontSize()
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
/** 字号五档：滑杆索引 ↔ 档位（表与吸附纯函数见 useFontSize，测试同源） */
const fontSizeLevel = computed(() => fontSizeLevelIndex(settingsStore.settings.ui.font_size))
const currentFontLevel = computed(() => FONT_SIZE_LEVELS[fontSizeLevel.value])

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
/** 滑杆档位 → 落盘档位 px（索引钳到 [0, 4]，range 输入本身已保证，防御 NaN/越界事件） */
function setFontLevel(i: number) {
  const idx = Math.min(FONT_SIZE_LEVELS.length - 1, Math.max(0, i))
  if (Number.isNaN(idx)) return
  setFontSize(FONT_SIZE_LEVELS[idx].px)
}
function toggleAnimations() {
  settingsStore.settings.ui.animations_enabled = !(
    settingsStore.settings.ui.animations_enabled !== false
  )
  void settingsStore.saveSettings({ ui: settingsStore.settings.ui })
}
</script>

<style scoped>
/* 行控件行（label 左 / 控件右）：与 SysSettingsView 的授权入口卡同构（两处消费，
   未到 shell.css 的 3+ 组件门槛，按其规则各自 scoped 持有） */
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
/* 档位刻度：两端对齐（首档贴滑杆左端、末档贴右端，与滑杆拇指行程一致）；
   激活档 = 主文字色 + 加粗（不只靠颜色），非激活用三级文字色 */
.size-ticks {
  display: flex;
  justify-content: space-between;
  margin-top: 3px;
  padding: 0 2px;
}
.size-ticks span {
  font-size: calc(10px * var(--ui-scale));
  color: var(--text-tertiary);
  transition: color var(--motion-duration-base) var(--motion-ease);
}
.size-ticks span.on {
  color: var(--text-primary);
  font-weight: 600;
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
</style>
