<template>
  <!-- 主屏：应用网格 + 系统网格；壁纸由 ShellHost 壳根统一铺（所有宿主面共用），
       主屏自身保持透明。打开过 / 后台运行的面不在这里铺开（见工具栏「多任务」面板）。 -->
  <section class="home-scroll" :aria-label="t('shell.home.aria')">
    <h1 class="sr-only">{{ t('shell.home.aria') }}</h1>
    <!-- type-to-search 提示（spec-c 已知边界：IME 合成中的 CJK 非本路径，由隐藏 input 承接）。
         悬在主屏顶部居中（与图块列无关，只是搜索态的高位提示）。 -->
    <div v-if="q.trim() !== ''" class="qhint shell-fade-in" role="status" aria-live="polite">
      <ShellIcon name="search" :size="13" />
      <span class="q font-semibold">{{ q }}</span>
      <span class="n"
        >{{ filterApps.length + matchedSys.length }} {{ t('shell.home.matches') }}</span
      >
      <kbd class="k">Enter</kbd>
    </div>

    <div class="home-col">
      <!-- 这里不再有「正在运行」卡片带：打开过 / 后台运行的应用统一收进工具栏的
           多任务全屏层（ShellTaskSwitcher），主屏只留应用与系统网格。 -->

      <!-- ======== 应用网格 ======== -->
      <section class="home-sec">
        <div class="sec-h">
          <h2 class="t">{{ t('shell.home.appsTitle') }}</h2>
          <span class="n">{{ apps.length }}</span>
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
                :size="64"
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
          <span class="n">{{ matchedSys.length }}</span>
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
              <span class="glyph-box tone-system icon-hover" style="width: 64px; height: 64px">
                <ShellIcon :name="sys.icon" :size="28" :stroke-width="1.55" />
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
import ShellIcon from './ShellIcon.vue'
import ShellAppTile from './ShellAppTile.vue'
import type { ShellAppEntry } from '../composables/useShellApps'

const { t } = useI18n()
const state = useShellState()
const appsStore = useShellApps()

const q = computed(() => state.homeQ.value)
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
/* 主屏构图：内容贴顶、左对齐（用户 2026-10-19 裁决：主屏不要垂直/水平居中，
   还原为「920px 一栏、从左上角铺起」的桌面形态）。容器只做宽度上限，不再用
   `margin: auto` 把整块推到屏幕正中。 */
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
/* 分区标题取显示级字号（15px × ui-scale）：与 12.5px 的图块名拉开 1.2 档，
   标题才像标题。计数跟在标题后、按基线对齐，数字用等宽数位（tabular-nums）。 */
.sec-h .t {
  font-size: var(--font-size-h2);
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: -0.01em;
  color: var(--text-primary);
}
.sec-h .n {
  font-size: calc(11.5px * var(--ui-scale));
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}
.sec-h .grow {
  flex: 1;
}

/* 图标网格：自适应多列（auto-fill）+ 从左往右铺，行内不居中——图块从容器左端起排，
   与阅读方向一致（居中排布会让 4 个应用悬在屏幕正中）。
   最小列宽 104px（原 88px）：图块已放大到 64px、名称 13px × ui-scale，
   88px 轨道在 ui-scale > 1 时会把「File Transfer」截成省略号。 */
.appgrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: 8px 4px;
  align-content: start;
}
.appicon {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 12px 6px 11px;
  border-radius: 12px;
  cursor: pointer;
  position: relative;
  background: none;
  transition:
    background-color var(--motion-duration-fast) var(--motion-ease),
    transform var(--motion-duration-fast) var(--motion-ease);
  /* 入场：图块自下浮起 + 淡入，逐个错 30ms（只定义 from，填充模式 backwards——
     动画结束后 transform 回到元素自身，:active 的按压缩放才不会被填充态压住） */
  animation: shell-tile-in var(--motion-duration-slow) var(--motion-ease) backwards;
}
.appicon:nth-child(2) {
  animation-delay: 30ms;
}
.appicon:nth-child(3) {
  animation-delay: 60ms;
}
.appicon:nth-child(4) {
  animation-delay: 90ms;
}
.appicon:nth-child(5) {
  animation-delay: 120ms;
}
.appicon:nth-child(6) {
  animation-delay: 150ms;
}
.appicon:nth-child(7) {
  animation-delay: 180ms;
}
.appicon:nth-child(8) {
  animation-delay: 210ms;
}

@keyframes shell-tile-in {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
}
.appicon:hover {
  background: var(--bg-hover);
}
.appicon:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring-color);
  outline-offset: -2px;
}
.appicon:active {
  transform: scale(0.955);
}
.appicon .glyph-wrap {
  position: relative;
}
/* 状态点 / 审批徽标压在图标右上角：外圈用半透明卡片色而不是页面色——
   主屏底下是壁纸，实色外圈会在彩色壁纸上留下一圈「贴纸」边。 */
.appicon .sdot {
  position: absolute;
  top: -1px;
  right: -1px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--bg-card) 55%, transparent);
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
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--bg-card) 55%, transparent);
}
.appicon .nm {
  font-size: calc(13px * var(--ui-scale));
  font-weight: 500;
  letter-spacing: -0.005em;
  color: var(--text-primary);
  max-width: 100%;
}
.appgrid .note {
  text-align: center;
  font-size: calc(12px * var(--ui-scale));
  color: var(--text-secondary);
}
.icon-hover {
  transition:
    transform var(--motion-duration-base) var(--motion-ease),
    box-shadow var(--motion-duration-base) var(--motion-ease);
}
.appicon:hover .icon-hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-card-hover);
}

/* type-to-search 提示 */
.qhint {
  position: absolute;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px 7px 13px;
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
.qhint .k {
  font-family: var(--font-mono);
  font-size: calc(9.5px * var(--ui-scale));
  line-height: 1;
  padding: 4px 5px;
  border-radius: 5px;
  border: 1px solid var(--border);
  background: var(--bg-sidebar);
  color: var(--text-secondary);
}
</style>
