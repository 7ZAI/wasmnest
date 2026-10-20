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
               每行最多 3 张卡、整组上下左右居中，卡片过多时纵向滚动。
               缩略区 = 应用可选导出的 mountPreview 自绘只读预览面；缺失 / 失败 /
               超时回退品牌渐变 + 图标（机制 B：后台应用离开应用面即被卸载，没有 DOM
               可截图，预览只能由应用重新画；见 .scratch/2026-10-20-app-preview-contract）。 -->
          <div class="ts-cards" :class="{ 'is-empty': !state.cards.value.length }" role="list">
            <article
              v-for="(key, i) in state.cards.value"
              :key="key"
              class="ts-card"
              :class="{ active: key === state.activeCard.value }"
              :style="{ '--i': i }"
              role="listitem"
              data-ts-keep
            >
              <!-- 信息条在卡片顶部（2026-10-20 用户裁决）：图标打头 + 名称；
                   关闭键压在条右端（.ts-card-x 是 article 的兄弟，按钮不能嵌套按钮）。
                   「运行中」不再用 chip 重复——后台卡默认就是在跑，只有异常态才提示。 -->
              <div class="ts-meta">
                <ShellAppTile
                  v-if="kindOf(key) === 'app'"
                  :icon="entryOf(key)?.icon ?? 'grid'"
                  :plugin-id="idOf(key)"
                  :icon-file="entryOf(key)?.iconFile"
                  :tone="toneOf(key)"
                  :size="30"
                />
                <span v-else class="glyph-box tone-system ts-sys-mini">
                  <ShellIcon :name="sysIconOf(key)" :size="15" :stroke-width="1.7" />
                </span>
                <span class="ts-nm truncate">{{ state.cardTitleOf(key) }}</span>
                <!-- 只有降级 / 待审批 / 错误这类需要用户注意的状态才显示 -->
                <span v-if="chipTextOf(key)" class="shell-chip" :class="chipOf(key)">
                  {{ chipTextOf(key) }}
                </span>
              </div>
              <div
                class="ts-thumb"
                :class="kindOf(key) === 'app' ? undefined : 'tone-system'"
                :style="kindOf(key) === 'app' ? undefined : thumbStyle()"
              >
                <!-- app 卡：应用自绘只读预览面（未导出 / 失败 / 超时 → 品牌卡 fallback） -->
                <AppPreviewTile
                  v-if="kindOf(key) === 'app'"
                  :app-id="idOf(key)"
                  :last-route="lastRouteOf(idOf(key))"
                  :icon="entryOf(key)?.icon ?? 'grid'"
                  :icon-file="entryOf(key)?.iconFile"
                  :tone="toneOf(key)"
                />
                <!-- 系统页卡：没有 app bundle，保持品牌渐变 + 36px glyph -->
                <span v-else class="glyph-box tone-system ts-sys-glyph">
                  <ShellIcon :name="sysIconOf(key)" :size="36" :stroke-width="1.5" />
                </span>
              </div>
              <!-- 唯一打开动作：覆盖整张卡的绝对定位空按钮（视觉层 pointer-events:none）。
                   预览面可能包含应用自绘的任意 DOM，不能再嵌进 button（嵌套交互元素
                   会让键盘与读屏出错）；aria-label / aria-current 保持原语义。 -->
              <button
                class="ts-card-main"
                :aria-label="t('shell.recents.open', { name: state.cardTitleOf(key) })"
                :aria-current="key === state.activeCard.value ? 'true' : undefined"
                @click="switchTo(key)"
              ></button>
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

            <!-- 空态：图标 + 一行说明，居中于卡片带——孤零零一句文字落在左上角
                 网格格里，读起来像页面没加载完 -->
            <div v-if="!state.cards.value.length" class="ts-empty">
              <span class="ts-empty-ic">
                <ShellIcon name="recents" :size="26" :stroke-width="1.4" />
              </span>
              <p class="ts-empty-t">{{ t('shell.recents.empty') }}</p>
            </div>
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
 * 大卡片（自适应多行网格），点卡片切回（应用续接离开时那一页），卡片顶部信息条
 * （图标 + 名称）右端 ✕ 关闭单个实例，头部「全部关闭」一键清场；点空白 / ✕ / Esc 收起。
 *
 * 缩略区：app 卡交给 `AppPreviewTile`（应用可选导出 `mountPreview` 自绘只读预览面；
 * 未导出 / 失败 / 3s 超时回退品牌渐变 + 图标），系统页卡保持品牌渐变 + 36px glyph。
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
import AppPreviewTile from '../mount/AppPreviewTile.vue'
import { lastRouteOf } from '../mount/appSession'
import type { CardKey } from '../types'
import type { ShellAppEntry } from '../composables/useShellApps'

const { t } = useI18n()
const state = useShellState()
const appsStore = useShellApps()

const open = computed(() => state.recentsOpen.value)
const rootEl = ref<HTMLElement | null>(null)

/**
 * 系统页卡缩略区品牌渐变底：tone 固定 system 的语义色（与 tone-system 类同源）。
 * app 卡的品牌渐变 fallback 由 `AppPreviewTile` 自绘（同一条公式，单一实现）。
 */
function thumbStyle(): Record<string, string> {
  const accent = 'var(--color-info)'
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

/** 状态 chip（应用取真实 PluginState 归并档；系统页无运行态）
 *
 * 「运行中」不作为 chip 展示（后台应用卡默认就是在跑，重复一遍是噪声）；
 * 只保留降级 / 待审批 / 错误这类需要用户注意的状态。
 */
function chipTextOf(key: CardKey): string {
  if (kindOf(key) !== 'app') return ''
  const st = appsStore.displayStates.value[idOf(key)] ?? ''
  if (!st || st === 'running') return ''
  const meta = chipMetaOf(st)
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
/* 全屏层 Teleport 到 body，已不在 .shell-root 内——共享焦点环选择器够不到这里，
   按钮补一份同形态焦点环（键盘可达的控件必须有可见焦点） */
.ts-root button:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring-color);
  outline-offset: var(--focus-ring-offset);
}

/* 覆盖层按钮与卡边同尺寸：默认 2px 外扩的焦点环会被卡片 overflow:hidden 裁掉，
   改为内缩 3px 画在卡内（环宽 2px 完整可见，形态与上行一致）。 */
.ts-root .ts-card-main:focus-visible {
  outline-offset: -3px;
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
  font-size: var(--font-size-h2);
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: -0.01em;
  color: var(--text-primary);
}
.ts-count {
  font-size: calc(11px * var(--ui-scale));
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
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
    background-color var(--motion-duration-fast) var(--motion-ease),
    color var(--motion-duration-fast) var(--motion-ease);
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
  /* 每行最多 3 张卡；整组在卡片带里**上下左右都居中**（用户 2026-10-19）：
     轨道用固定宽 420px（= 卡片高 560 × 3/4）而不是 1fr——1fr 轨道会铺满整行，
     `justify-content: center` 居中不了任何东西，1 张卡时仍贴在左端；
     固定宽轨道下，1 张卡 = 单轨道被居中，3 张卡 = 三轨道整体居中。 */
  grid-template-columns: repeat(3, 420px);
  max-width: 1320px;
  margin: 0 auto;
  justify-content: center;
  gap: 16px;
  align-content: center;
  /* 卡片超高需要滚动时：safe 变体保证第一行不被居中裁掉（不支持的浏览器回落上一行） */
  align-content: safe center;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 4px 2px 12px;
  scrollbar-width: thin;
}
/* 空态：卡片带里没有卡片时，空态块占满整行并居中 */
.ts-cards.is-empty {
  align-content: center;
}

/* 卡片：竖版 3/4（缩略区 flex 撑满 + 底部信息条） */
.ts-card {
  position: relative;
  /* 初始版比例（3/4 竖版）放大一档：固定高 560px → 宽 ≈ 420px。
     不能用 `min(100%, 560px)`——网格项的高度百分比对着 auto 轨道解析不出来，
     会被当成 auto，aspect-ratio 随之失效，卡片缩成内容大小（2026-10-19 实测）。 */
  height: 560px;
  aspect-ratio: 3 / 4;
  justify-self: center;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-sheet);
  background: var(--bg-card);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-card);
  overflow: hidden;
  animation: ts-card-in var(--motion-duration-base) var(--motion-ease) backwards;
  animation-delay: calc(var(--i, 0) * 35ms);
  transition:
    transform var(--motion-duration-base) var(--motion-ease),
    box-shadow var(--motion-duration-base) var(--motion-ease),
    background-color var(--motion-duration-base) var(--motion-ease);
}
/* 悬停只抬升卡片，不再把边框染成主色（warm 色板下主色近黑 = 黑框）。 */
.ts-card:hover {
  transform: translateY(-3px);
  box-shadow: var(--shadow-card-hover);
}
/* 选中态：信息条用固定黑底 + 反白文字（不随明暗主题反转），
   不画描边、也不压勾章；缩略图保持完整可见。 */
.ts-card.active .ts-meta {
  background: var(--selection-solid);
  /* 透明边框让黑底铺到边，不再出现一圈主色描边 */
  border-bottom-color: transparent;
}
.ts-card.active .ts-nm {
  color: var(--selection-solid-ink);
}
/* 当前卡信息条是固定黑底：chip 改用固定反白底 + 黑字，避免半透明绿/红在黑底上糊掉。 */
.ts-card.active .ts-meta .shell-chip {
  background: var(--selection-solid-ink);
  color: var(--selection-solid);
}
.ts-card.active {
  box-shadow: 0 14px 36px color-mix(in srgb, var(--text-primary) 16%, transparent);
}

/* 唯一打开动作：绝对定位覆盖整张卡的空按钮。视觉层（信息条 + 缩略区）全部
   pointer-events:none，点击只会落在这里；预览面可能含应用自绘 DOM，不能再
   嵌进 button（嵌套交互元素 = 键盘 / 读屏错误）。层序在关闭键之下。 */
.ts-card-main {
  position: absolute;
  inset: 0;
  z-index: 1;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  text-align: left;
}
/* 视觉层不承载点击：点击穿透到覆盖层按钮（预览容器本身也 pointer-events:none） */
.ts-card .ts-meta,
.ts-card .ts-thumb {
  pointer-events: none;
}
/* 缩略区：app 卡 = 应用自绘只读预览面（AppPreviewTile，尺寸由卡片决定）；
   系统页卡 = 品牌渐变底 + 图标居中。预览挂载 / 回退切换不改变盒子尺寸，
   卡片高度与网格位置不跳动。 */
.ts-thumb {
  flex: 1;
  min-height: 0;
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
.ts-sys-mini {
  width: 30px;
  height: 30px;
}
/* 信息条（卡片顶部）：图标打头 + 名称（异常态才追加 chip）。
   右侧 44px 留给 .ts-card-x：关闭键是 article 的兄弟绝对定位，视觉上落在条内。 */
.ts-meta {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 44px 9px 12px;
  border-bottom: 1px solid var(--border);
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
  /* 垂直居中对齐顶部信息条里的 30px 图标（条高 = 30 + 9×2） */
  top: 11px;
  right: 10px;
  /* 压在覆盖层按钮（z-index:1）之上：关闭键是卡片的第二个独立动作 */
  z-index: 2;
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
    background-color var(--motion-duration-fast) var(--motion-ease),
    color var(--motion-duration-fast) var(--motion-ease);
}
/* 当前卡信息条是固定黑底：关闭键跟着反白（悬停仍走红色危险态） */
.ts-card.active .ts-card-x {
  color: var(--selection-solid-ink);
  background: color-mix(in srgb, var(--selection-solid-ink) 12%, transparent);
  border-color: color-mix(in srgb, var(--selection-solid-ink) 24%, transparent);
}
.ts-card-x:hover,
.ts-card.active .ts-card-x:hover {
  background: var(--color-danger);
  border-color: var(--color-danger);
  color: var(--color-primary-contrast);
}

.ts-empty {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 24px 0;
}
.ts-empty-ic {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-sidebar);
  border: 1px solid var(--border);
  color: var(--text-secondary);
}
.ts-empty-t {
  font-size: calc(13px * var(--ui-scale));
  color: var(--text-secondary);
  text-align: center;
}

.ts-foot {
  flex-shrink: 0;
  padding: 8px 2px 0;
  font-size: calc(11.5px * var(--ui-scale));
  color: var(--text-tertiary);
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
  transition: opacity var(--motion-duration-fast) var(--motion-ease);
}
.ts-fade-enter-from,
.ts-fade-leave-to {
  opacity: 0;
}
</style>
