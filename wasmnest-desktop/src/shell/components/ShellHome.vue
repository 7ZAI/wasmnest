<template>
  <!-- 主屏：应用网格 + 系统网格；壁纸两层背景 + 可调遮罩（spec-c §5）。
       打开过 / 后台运行的面不在这里铺开（见工具栏「多任务」面板）。 -->
  <section
    class="home-scroll"
    :class="[{ 'home-wall': wallClass !== '', [`wall-${wallClass}`]: wallClass !== '' }]"
    :style="{ '--wall-dim': prefs.wallDim / 100 }"
    :aria-label="t('shell.home.aria')"
  >
    <h1 class="sr-only">{{ t('shell.home.aria') }}</h1>
    <!-- type-to-search 提示（spec-c 已知边界：IME 合成中的 CJK 非本路径，由隐藏 input 承接） -->
    <div v-if="q.trim() !== ''" class="qhint">
      <ShellIcon name="search" :size="13" />
      <span class="q font-semibold">{{ q }}</span>
      <span class="n"
        >{{ filterApps.length + matchedSys.length }} {{ t('shell.home.matches') }} · Enter</span
      >
    </div>

    <div class="home-col">
      <!-- 这里不再有「正在运行」卡片带：打开过 / 后台运行的应用统一收进工具栏的
           多任务全屏层（ShellTaskSwitcher），主屏只留应用与系统网格。 -->

      <!-- ======== 应用网格 ======== -->
      <section class="home-sec">
        <div class="sec-h">
          <h2 class="t">{{ t('shell.home.appsTitle') }}</h2>
          <span class="n">{{ apps.length }} · {{ t('shell.home.installed') }}</span>
        </div>
        <div class="appgrid" role="list" :aria-label="t('shell.home.appsTitle')">
          <div
            v-for="app in apps"
            :key="app.id"
            class="appicon"
            role="listitem"
            tabindex="0"
            :aria-label="`${app.name}，${chipMeta(appsStore.displayStates.value[app.id]).text}`"
            @click="state.openApp(app.id)"
            @keydown.enter="state.openApp(app.id)"
            @contextmenu.prevent="onCtx(app, $event)"
          >
            <span class="glyph-wrap">
              <ShellAppTile
                :icon="app.icon"
                :plugin-id="app.id"
                :icon-file="app.iconFile"
                :tone="appsStore.tones.value[app.id] ?? 'system'"
                :size="52"
                class="icon-hover"
              />
              <span v-if="appsStore.displayStates.value[app.id] === 'approval'" class="bdg-approval"
                >!</span
              >
              <span v-else class="sdot" :class="appsStore.displayStates.value[app.id]"></span>
            </span>
            <span class="nm truncate">{{ app.name }}</span>
          </div>
          <div v-if="!apps.length" class="note" style="grid-column: 1 / -1; padding: 14px 2px">
            {{ t('shell.home.noApps', { q }) }}
          </div>
        </div>
      </section>

      <!-- ======== 系统网格 ======== -->
      <section v-if="matchedSys.length" class="home-sec">
        <div class="sec-h">
          <h2 class="t">{{ t('shell.home.sysTitle') }}</h2>
          <span class="n">{{ t('shell.home.sysHint') }}</span>
        </div>
        <div class="appgrid" role="list" :aria-label="t('shell.home.sysTitle')">
          <div
            v-for="sys in matchedSys"
            :key="sys.id"
            class="appicon"
            role="listitem"
            tabindex="0"
            :aria-label="`${t(sys.nameKey)}，${t(sys.descKey)}`"
            @click="state.openSys(sys.id)"
            @keydown.enter="state.openSys(sys.id)"
          >
            <span class="glyph-wrap">
              <span class="glyph-box tone-system icon-hover" style="width: 52px; height: 52px">
                <ShellIcon :name="sys.icon" :size="23" :stroke-width="1.6" />
              </span>
            </span>
            <span class="nm truncate">{{ t(sys.nameKey) }}</span>
          </div>
        </div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
/**
 * ShellHome — 主屏（spec-c）：应用网格 + 系统网格 + type-to-search。
 *
 * 归属（AGENTS §5.1）：注册表投影的纯呈现，无业务编排；打开动作委托 useShellState
 * （dormant 即点即启 / approval 进审批屏卡）。**打开过 / 后台运行的面不在这里**：
 * 用户裁决（2026-10-17）把「正在运行」区从主屏撤掉，改由工具栏多任务全屏层承载。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { SYS_PAGES, chipMetaOf } from '../composables/state'
import { useShellState } from '../composables/useShellState'
import { useShellApps } from '../composables/useShellApps'
import { useShellSettings } from '../composables/useShellSettings'
import ShellIcon from './ShellIcon.vue'
import ShellAppTile from './ShellAppTile.vue'
import type { ShellAppEntry } from '../composables/useShellApps'

const { t } = useI18n()
const state = useShellState()
const appsStore = useShellApps()
const { prefs } = useShellSettings()

const q = computed(() => state.homeQ.value)
/** 壁纸类（none → 无类不叠加遮罩层背景） */
const wallClass = computed(() => {
  const w = prefs.value.wallpaper
  return w && w !== 'none' ? w : ''
})
/** 搜索匹配：名称 / id（均小写包含） */
const matchQ = (s: string) => s.toLowerCase().includes(q.value.toLowerCase())

const filterApps = computed(() => {
  if (!q.value) return appsStore.plugins.value
  return appsStore.plugins.value.filter((a) => matchQ(a.name) || matchQ(a.id))
})

const matchedSys = computed(() =>
  q.value ? SYS_PAGES.filter((s) => matchQ(t(s.nameKey)) || matchQ(s.id)) : SYS_PAGES,
)

const apps = filterApps

/** chip 展示（展示态 → 文案 i18n + 样式类；单表真源 = state.ts `CHIP_META`） */
function chipMeta(st: string): { text: string; cls: string } {
  const meta = chipMetaOf(st)
  return meta ? { text: t(meta.textKey), cls: meta.cls } : { text: st, cls: '' }
}

/** 右键菜单 */
function onCtx(app: ShellAppEntry, e: MouseEvent) {
  state.ctxMenu.value = { appId: app.id, x: e.clientX, y: e.clientY }
}
</script>

<style scoped>
.home-scroll {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  padding: 18px 20px 20px;
  gap: 22px;
  display: flex;
  flex-direction: column;
}
.home-col {
  width: min(920px, 100%);
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 22px;
}
.home-sec {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.sec-h {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px;
}
.sec-h .t {
  font-size: calc(13px * var(--ui-scale));
  font-weight: 600;
  color: var(--text-primary);
}
.sec-h .n {
  font-size: calc(11px * var(--ui-scale));
  color: var(--text-tertiary);
}
.sec-h .grow {
  flex: 1;
}

/* 图标网格 */
.appgrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
  gap: 8px 4px;
  align-content: start;
}
.appicon {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  padding: 10px 4px 8px;
  border-radius: var(--radius-card);
  cursor: pointer;
  position: relative;
  background: none;
  transition: background-color 0.15s;
}
.appicon:hover {
  background: var(--bg-hover);
}
.appicon:active {
  transform: scale(0.96);
}
.appicon .glyph-wrap {
  position: relative;
}
.appicon .sdot {
  position: absolute;
  top: -1px;
  right: -1px;
  box-shadow: 0 0 0 2px var(--bg-page);
}
.appicon .bdg-approval {
  position: absolute;
  top: -3px;
  right: -3px;
  min-width: 15px;
  height: 15px;
  border-radius: 8px;
  background: var(--color-danger);
  color: var(--color-primary-contrast);
  font-size: calc(9px * var(--ui-scale));
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 0 0 2px var(--bg-page);
}
.appicon .nm {
  font-size: calc(12px * var(--ui-scale));
  color: var(--text-primary);
  max-width: 100%;
}
.icon-hover {
  transition:
    transform 0.18s,
    box-shadow 0.18s;
}
.appicon:hover .icon-hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-card-hover);
}

/* type-to-search 提示 */
.qhint {
  position: absolute;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 12px;
  border-radius: 999px;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow-card-hover);
  font-size: calc(12px * var(--ui-scale));
  color: var(--text-primary);
  white-space: nowrap;
}
.qhint .n {
  color: var(--text-tertiary);
  font-size: calc(11px * var(--ui-scale));
}
</style>
