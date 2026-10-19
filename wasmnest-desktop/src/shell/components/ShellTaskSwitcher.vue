<template>
  <!-- 全屏多任务层（安卓 recents 形态）：背景是当前界面的虚化快照，前景是运行中应用的大卡片。
       Teleport 到 body：壳根是 overflow:hidden 的定高 flex，且应用内容自带层叠上下文，
       留在里面会被裁掉 / 被应用弹层压住；全屏层必须独立于这两者。 -->
  <Teleport to="body">
    <Transition name="ts-fade">
      <div
        v-if="open"
        ref="rootEl"
        class="ts-root"
        role="dialog"
        aria-modal="true"
        :aria-label="t('shell.recents.title')"
        tabindex="-1"
        @keydown.esc.stop="close"
        @click="onBackdropClick"
      >
        <!-- 虚化背景（纯视觉层；点击退出统一由根节点的 onBackdropClick 判定） -->
        <div class="ts-scrim"></div>

        <div class="ts-inner">
          <header class="ts-head" data-ts-keep>
            <h2 class="ts-title">{{ t('shell.recents.title') }}</h2>
            <span class="ts-count"
              >{{ state.cards.value.length }} {{ t('shell.recents.countUnit') }}</span
            >
            <span class="grow"></span>
            <button v-if="state.cards.value.length" class="shell-mini danger" @click="closeAll">
              <ShellIcon name="trash" :size="12" /> {{ t('shell.recents.closeAll') }}
            </button>
            <button class="ts-close" :aria-label="t('shell.recents.close')" @click="close">
              <ShellIcon name="x" :size="16" />
            </button>
          </header>

          <!-- 卡片带：自适应多行网格（2026-10-19 优化）。
               卡片列宽随窗口自适应（minmax 200–260px，宽度不够自动换行），
               卡片过多时超出高度滚动查看；缩略区 = 品牌渐变底 + 应用真实图标
               （安卓 recents 形态；真实界面快照受跨 Vue 实例 / canvas 内容 / DOM 卸载限制不可行） -->
          <div class="ts-cards" role="list">
            <article
              v-for="(key, i) in state.cards.value"
              :key="key"
              class="ts-card"
              :class="{ active: key === state.activeCard.value }"
              :style="{ '--i': i }"
              role="listitem"
              data-ts-keep
            >
              <button
                class="ts-card-main"
                :aria-label="t('shell.recents.open', { name: state.cardTitleOf(key) })"
                @click="switchTo(key)"
              >
                <span
                  class="ts-thumb"
                  :class="kindOf(key) === 'app' ? 'tone-' + toneOf(key) : 'tone-system'"
                  :style="thumbStyle(key)"
                >
                  <ShellAppTile
                    v-if="kindOf(key) === 'app'"
                    :icon="entryOf(key)?.icon ?? 'grid'"
                    :plugin-id="idOf(key)"
                    :icon-file="entryOf(key)?.iconFile"
                    :tone="toneOf(key)"
                    :size="92"
                  />
                  <span v-else class="glyph-box tone-system ts-sys-glyph">
                    <ShellIcon :name="sysIconOf(key)" :size="36" :stroke-width="1.5" />
                  </span>
                </span>
                <span class="ts-meta">
                  <span class="ts-nm truncate">{{ state.cardTitleOf(key) }}</span>
                  <span class="shell-chip" :class="chipOf(key)">{{ chipTextOf(key) }}</span>
                </span>
              </button>
              <!-- 单关：只移除这一张，全屏层留在原处继续处理下一张 -->
              <button
                class="ts-card-x"
                :title="
                  kindOf(key) === 'app' ? t('shell.recents.stopInstance') : t('shell.recents.closePage')
                "
                :aria-label="t('shell.recents.closeOne', { name: state.cardTitleOf(key) })"
                @click="closeCard(key)"
              >
                <ShellIcon name="x" :size="13" />
              </button>
            </article>

            <p v-if="!state.cards.value.length" class="ts-empty">{{ t('shell.recents.empty') }}</p>
          </div>

          <footer class="ts-foot">
            {{ t('shell.recents.resumedHint') }}
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * ShellTaskSwitcher — 全屏多任务（安卓 recents 形态）
 *
 * 主屏不铺「正在运行」区（用户裁决 2026-10-17），打开过 / 后台运行的面统一在这个
 * 全屏层里呈现：背景是当前界面的**虚化**快照（backdrop blur），前景是每个应用一张
 * 大卡片（横向 scroll-snap），点卡片切回（应用续接离开时那一页），卡片角上 ✕ 关闭
 * 单个实例，头部「全部关闭」一键清场；点空白 / ✕ / Esc 收起。
 *
 * 归属（AGENTS §5.1）：纯注册表投影 + 动作机械转发；卡清单与关闭语义唯一实现在
 * `useShellState`（activateCard 带页面续接、closeCard = 真停用），本组件不复制编排。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { SYS_PAGES, chipMetaOf, type AppTone } from '../composables/state'
import { useShellState } from '../composables/useShellState'
import { useShellApps } from '../composables/useShellApps'
import ShellIcon from './ShellIcon.vue'
import ShellAppTile from './ShellAppTile.vue'
import type { CardKey } from '../types'
import type { ShellAppEntry } from '../composables/useShellApps'

const { t } = useI18n()
const state = useShellState()
const appsStore = useShellApps()

const open = computed(() => state.recentsOpen.value)
const rootEl = ref<HTMLElement | null>(null)

/** 缩略区品牌渐变底：tone 档 → 语义色 token（与 tone-* 类同源） */
const TONE_ACCENTS: Record<AppTone | 'system', string> = {
  primary: 'var(--color-primary)',
  info: 'var(--color-info)',
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
  mix: 'var(--color-info)',
  system: 'var(--color-info)',
}

/**
 * 缩略图区背景：该应用品牌色的对角渐变（模拟安卓 recents 卡片的「界面快照」观感；
 * 真实快照不可行——挂载槽只在当前面实例化、canvas 内容不可克隆）。
 */
function thumbStyle(key: CardKey): Record<string, string> {
  const accent = TONE_ACCENTS[kindOf(key) === 'app' ? toneOf(key) : 'system']
  return {
    background: `linear-gradient(160deg, ${accent} 0%, color-mix(in srgb, ${accent} 14%, var(--bg-sidebar)) 55%, var(--bg-sidebar) 100%)`,
  }
}

// 打开即把焦点收进全屏层：否则 Tab 还会走背后的工具栏 / 应用内容（全屏层是模态的）
watch(open, async (isOpen) => {
  if (!isOpen) return
  await nextTick()
  rootEl.value?.focus()
})

// ---- 卡片 key 解析（面 key = 'app:<pluginId>' / 'sys:<pageId>'） ----
function kindOf(key: CardKey): 'app' | 'sys' {
  return key.startsWith('app:') ? 'app' : 'sys'
}
function idOf(key: CardKey): string {
  return key.slice(key.indexOf(':') + 1)
}
function sysIconOf(key: CardKey): string {
  return SYS_PAGES.find((s) => s.id === idOf(key))?.icon ?? 'grid'
}
function entryOf(key: CardKey): ShellAppEntry | undefined {
  return kindOf(key) === 'app' ? appsStore.appOf(idOf(key)) : undefined
}
function toneOf(key: CardKey): AppTone | 'system' {
  return appsStore.tones.value[idOf(key)] ?? 'system'
}

/** 状态 chip（应用取真实 PluginState 归并档；系统页无运行态） */
function chipTextOf(key: CardKey): string {
  if (kindOf(key) !== 'app') return t('shell.recents.sysPage')
  const meta = chipMetaOf(appsStore.displayStates.value[idOf(key)] ?? '')
  return meta ? t(meta.textKey) : ''
}
function chipOf(key: CardKey): string {
  if (kindOf(key) !== 'app') return ''
  return chipMetaOf(appsStore.displayStates.value[idOf(key)] ?? '')?.cls ?? ''
}

/**
 * 点空白退出（安卓多任务同款）：只有点在「卡片 / 顶部操作条」之外才收起全屏层。
 *
 * 用根节点一次事件委托判定，而不是给 scrim / 卡片带各挂 `@click.self`：`.ts-inner`
 * 盖住了 `.ts-scrim`，且卡片带是可横向滚动的容器——分散挂会在「卡片之间的空隙」
 * 整片失效（那正是用户最常点的空白区）。
 */
function onBackdropClick(e: MouseEvent): void {
  const target = e.target as Element | null
  if (target?.closest('[data-ts-keep]')) return
  close()
}

function switchTo(key: CardKey): void {
  state.activateCard(key)
}
function closeCard(key: CardKey): void {
  void state.closeCard(key)
}
function closeAll(): void {
  void state.stopAllCards()
}
function close(): void {
  state.recentsOpen.value = false
}
</script>

<style scoped>
.ts-root {
  position: fixed;
  inset: 0;
  /* 层序：盖住工具栏（30）与应用内容，但让模态对话框（50）、启动屏（100）与
     授权闸门（9999）压在上面——多任务是"浏览"，不该挡住必须应答的安全弹窗 */
  z-index: 44;
  display: flex;
  flex-direction: column;
  outline: none;
}

/* 虚化背景：半透明底 + 背景模糊（安卓 recents 的观感）。
   底色的透明度保证不支持 backdrop-filter 的 WebView 也还能压住下层内容。 */
.ts-scrim {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--bg-page) 58%, transparent);
  -webkit-backdrop-filter: blur(20px) saturate(120%);
  backdrop-filter: blur(20px) saturate(120%);
}

.ts-inner {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 16px 22px 14px;
}

.ts-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  padding: 2px 2px 10px;
}
.ts-title {
  font-size: calc(15px * var(--ui-scale));
  font-weight: 600;
  color: var(--text-primary);
}
.ts-count {
  font-size: calc(11px * var(--ui-scale));
  color: var(--text-secondary);
}
.ts-head .grow {
  flex: 1;
}
.ts-close {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  cursor: pointer;
  transition:
    background-color 0.15s,
    color 0.15s;
}
.ts-close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* 卡片带：自适应多行网格。列宽随窗口自适应（minmax 200–260px），放不下自动换行；
   卡片过多 → 纵向滚动查看（flex 容器内 grid 由 .ts-inner 决定高度，溢出滚动） */
.ts-cards {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 260px));
  justify-content: center;
  gap: 14px;
  align-content: start;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 4px 2px 12px;
  scrollbar-width: thin;
}

/* 卡片：高度由内容决定（缩略区 16/10 + 信息条），宽度随网格列自适应 */
.ts-card {
  position: relative;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-sheet);
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow-card-hover);
  overflow: hidden;
  animation: ts-card-in 0.22s cubic-bezier(0.2, 0.8, 0.3, 1) backwards;
  animation-delay: calc(var(--i, 0) * 35ms);
  transition:
    transform 0.18s,
    border-color 0.18s;
}
.ts-card:hover {
  transform: translateY(-3px);
  border-color: var(--color-primary);
}
.ts-card.active {
  border-color: var(--color-primary);
  box-shadow: var(--shadow-input-focus);
}

.ts-card-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  cursor: pointer;
  text-align: left;
}
/* 缩略区：固定 16/10（应用窗口比例），品牌渐变底 + 应用真实图标居中 */
.ts-thumb {
  aspect-ratio: 16 / 10;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}
.ts-sys-glyph {
  width: 72px;
  height: 72px;
  border-radius: var(--radius-sheet);
}
.ts-meta {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--border);
  background: var(--bg-card);
}
.ts-nm {
  flex: 1;
  min-width: 0;
  font-size: calc(12.5px * var(--ui-scale));
  font-weight: 600;
  color: var(--text-primary);
}

.ts-card-x {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--bg-card) 82%, transparent);
  border: 1px solid var(--border);
  cursor: pointer;
  transition:
    background-color 0.15s,
    color 0.15s;
}
.ts-card-x:hover {
  background: var(--color-danger);
  border-color: var(--color-danger);
  color: var(--color-primary-contrast);
}

.ts-empty {
  flex: 1;
  text-align: center;
  font-size: calc(12px * var(--ui-scale));
  color: var(--text-secondary);
}

.ts-foot {
  flex-shrink: 0;
  padding: 6px 2px 0;
  font-size: calc(11px * var(--ui-scale));
  color: var(--text-secondary);
  text-align: center;
}

@keyframes ts-card-in {
  from {
    opacity: 0;
    transform: scale(0.96) translateY(10px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.ts-fade-enter-active,
.ts-fade-leave-active {
  transition: opacity 0.16s ease;
}
.ts-fade-enter-from,
.ts-fade-leave-to {
  opacity: 0;
}
</style>
