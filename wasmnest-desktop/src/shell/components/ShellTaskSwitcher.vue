<template>
  <!-- 全屏多任务层（安卓 recents 形态）：背景是虚化底，前景是运行中应用的大卡片。
       前台实例会被搬进自己的卡（缩略区展示真实页面），背景只剩壳的壁纸层。
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

          <!-- 卡片带：卡片数决定卡片尺寸（2026-10-23 用户裁决，修正上一版反方向）。
               1 张 = 带内最大卡居中；越多越小，最小只缩到「3 列 × 2 行」的格子；
               第 7 张起不再缩小，改为纵向滚动（解算见 composables/recentsLayout.ts）。
               缩略区 = **真实实例的当前页面**（2026-10-30 用户裁决）：宿主把保活实例
               搬进卡片、按整幅尺寸等比缩放（不重排 / 终端不 resize / 滚动与输入原样），
               不是截图 / 不是 DOM 克隆 / 不是应用自绘预览面；卡片里的实例 inert，
               多任务层收起后回后台（脱离文档不渲染）。系统页卡没有实例，保持品牌卡。 -->
          <div
            ref="bandEl"
            class="ts-cards"
            :class="{
              'is-empty': !state.cards.value.length,
              'is-scrolling': scrolls,
            }"
            :style="bandStyle"
            role="list"
          >
            <article
              v-for="(key, i) in state.cards.value"
              :key="key"
              class="ts-card"
              :class="{ active: key === state.activeCard.value }"
              :style="cardStyle(i)"
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
                <!-- app 卡：保活实例本身（宿主搬进卡片并等比缩放；实例缺失 → 品牌卡 fallback） -->
                <AppSurfaceTile
                  v-if="kindOf(key) === 'app'"
                  :app-id="idOf(key)"
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
                  kindOf(key) === 'app'
                    ? t('shell.recents.stopInstance')
                    : t('shell.recents.closePage')
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
 * 全屏层里呈现：背景是**虚化**底（前景实例会被搬走，背景只剩壳的壁纸层），前景是
 * 每个应用一张大卡片（卡片数决定尺寸：少卡大、多卡小，见 `recentsLayout`），点卡片
 * 切回（应用续接离开时那一页），卡片顶部信息条（图标 + 名称）右端 ✕ 关闭单个实例，
 * 头部「全部关闭」一键清场；点空白 / ✕ / Esc 收起。
 *
 * 缩略区（2026-10-30 用户裁决）：app 卡展示**真实实例的当前页面**——`AppSurfaceTile`
 * 请求挂载层把保活实例搬进卡片、按整幅尺寸等比缩放；系统页卡没有实例，保持品牌
 * 渐变 + 36px glyph。代价：多任务层打开期间所有运行中应用都会重新渲染（收起即回
 * 后台不渲染）；竖版窗口下真实画面按比例留边。
 *
 * 收货：普通收起（Esc / 点空白 / 切回同一张卡）时，前台实例必须送回挂载槽——
 * 搬运发生在卡片里，不送回去应用就“消失”了。切到别的应用由 `AppMountSlot` 的
 * appId watcher 接管（本层不抢）。
 *
 * 归属（AGENTS §5.1）：纯注册表投影 + 动作机械转发；卡清单与关闭语义唯一实现在
 * `useShellState`（activateCard 带页面续接、closeCard = 真停用），本组件不复制编排。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { SYS_PAGES, chipMetaOf, type AppTone } from '../composables/state'
import { useShellState } from '../composables/useShellState'
import { useShellApps } from '../composables/useShellApps'
import {
  RECENTS_MAX_COLS,
  RECENTS_MAX_VISIBLE_ROWS,
  recentsCardHeight,
  recentsCardPlacement,
  recentsCardWidth,
  recentsTrackCount,
  type RecentsBand,
} from '../composables/recentsLayout'
import ShellIcon from './ShellIcon.vue'
import ShellAppTile from './ShellAppTile.vue'
import AppSurfaceTile from '../mount/AppSurfaceTile.vue'
import { returnAppSurfaceToSlot } from '../mount/useAppMount'
import type { CardKey } from '../types'
import type { ShellAppEntry } from '../composables/useShellApps'

const { t } = useI18n()
const state = useShellState()
const appsStore = useShellApps()

const open = computed(() => state.recentsOpen.value)
const rootEl = ref<HTMLElement | null>(null)
const bandEl = ref<HTMLElement | null>(null)

/**
 * 卡片带可用尺寸（实测）。卡片宽度 = 数量 + 带尺寸的函数（`recentsLayout`），
 * 所以窗口缩放 / 卡片增减 / 滚动条出现都只需重算一次 computed。
 */
const band = ref<RecentsBand>({ width: 0, height: 0, gap: 0 })
/** 单卡宽度；0 = 还没量到带尺寸 → 交给 CSS 兜底（三等分） */
const cardWidth = computed(() => recentsCardWidth(state.cards.value.length, band.value))
/** 行高（卡高）：显式喂给 grid-auto-rows，避免引擎把溢出的行压扁 */
const cardHeight = computed(() => recentsCardHeight(cardWidth.value))
/** 超过可视 2 行 → 改滚动：必须置顶对齐，否则居中的首行会被滚出可视区 */
const scrolls = computed(
  () =>
    state.cards.value.length > 0 &&
    Math.ceil(state.cards.value.length / RECENTS_MAX_COLS) > RECENTS_MAX_VISIBLE_ROWS,
)
/** 注入 `--ts-card-w` / `--ts-card-h` / `--ts-tracks`：CSS 不重复尺寸算术 */
const bandStyle = computed<Record<string, string>>(() => {
  const style: Record<string, string> = {}
  if (cardWidth.value > 0) {
    style['--ts-card-w'] = `${cardWidth.value}px`
    style['--ts-card-h'] = `${cardHeight.value}px`
    style['--ts-tracks'] = String(recentsTrackCount(state.cards.value.length))
  }
  return style
})

/**
 * 单卡样式：入场错峰序号 + 末行不满时的显式居中位置
 *
 * 网格是 6 个半列轨道、每张卡跨 2 轨；末行不满 3 张时由 `recentsCardPlacement`
 * 给出行列（末行 2 张各让半卡、1 张落在正中）。行号显式给，避免自动排布把
 * 位置漂到上一行有空格的地方。
 */
function cardStyle(index: number): Record<string, string | number> {
  const style: Record<string, string | number> = { '--i': index }
  const placement = recentsCardPlacement(index, state.cards.value.length)
  if (placement) {
    style.gridRow = placement.row
    style.gridColumn = `${placement.columnStart} / span 2`
  }
  return style
}

function px(value: string): number {
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * 量卡片带可用尺寸
 *
 * `clientWidth` / `clientHeight` 已扣滚动条，再扣自身内边距才是卡片真正能用的盒子
 * （内边距留给悬停抬升与焦点环，不能让卡宽把它算进去）。gap 直接读计算值，避免
 * 间距在 CSS / TS 两处各写一份。
 *
 * **不能**改成纯 CSS 的容器查询：WebKitGTK 下 `container-type: size` 的高度解析为 0，
 * 卡片 flex-basis 归零、整层只剩标题（2026-10-23 实测，recentsWiring 锁同条）。
 */
function measureBand(): void {
  const el = bandEl.value
  if (!el) return
  const cs = getComputedStyle(el)
  band.value = {
    width: el.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight),
    height: el.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom),
    gap: px(cs.columnGap) || px(cs.rowGap),
  }
}

/** 老 WebView 没有 ResizeObserver 时靠 window resize 兜底 */
let bandObserver: ResizeObserver | null = null

function observeBand(): void {
  unobserveBand()
  const el = bandEl.value
  if (!el || typeof ResizeObserver === 'undefined') return
  bandObserver = new ResizeObserver(() => measureBand())
  bandObserver.observe(el)
}

function unobserveBand(): void {
  bandObserver?.disconnect()
  bandObserver = null
}

/**
 * 系统页卡缩略区品牌渐变底：tone 固定 system 的语义色（与 tone-system 类同源）。
 * app 卡的品牌渐变 fallback 由 `AppSurfaceTile` 自绘（同一条公式，单一实现）。
 */
function thumbStyle(): Record<string, string> {
  const accent = 'var(--color-info)'
  return {
    background: `linear-gradient(160deg, ${accent} 0%, color-mix(in srgb, ${accent} 14%, var(--bg-sidebar)) 55%, var(--bg-sidebar) 100%)`,
  }
}

/**
 * 打开即量卡片带并跟踪尺寸变化，关闭即断开；顺便把焦点收进全屏层
 * （否则 Tab 还会走背后的工具栏 / 应用内容——全屏层是模态的）。
 */
function syncBandAndFocus(): void {
  if (!open.value) {
    unobserveBand()
    restoreOriginAfterClose()
    return
  }
  slotOriginAppId = activeAppCardId()
  switchedTo = null
  measureBand()
  observeBand()
  rootEl.value?.focus()
}

/**
 * 打开时处于前台的卡片（实例正在挂载槽里，会被 `AppSurfaceTile` 搬进卡片）。
 *
 * 只认「有卡的 app」：服务型应用不入卡，实例留在槽里不动；系统页没有实例。
 */
let slotOriginAppId: string | null = null
/**
 * 本次收起是否由「点卡片切换」触发。null = Esc / 点空白 / 关闭键等普通收起。
 * 切到别的应用时实例去向由 AppMountSlot 的 appId watcher 接管，本层不抢。
 */
let switchedTo: CardKey | null = null

function activeAppCardId(): string | null {
  const key = state.activeCard.value
  if (!key || kindOf(key) !== 'app') return null
  return state.cards.value.includes(key) ? idOf(key) : null
}

/**
 * 普通收起时把前台实例送回挂载槽。
 *
 * 打开多任务把前台实例从槽里搬进了卡片；Esc / 点空白 / 切回同一张卡都不会触发
 * `AppMountSlot` 的重新 attach（appId 没变），不送回去应用就“消失”了。
 * 切到别的应用 / 关掉前台卡时 activeCard 已变（`closeCard` 内部会切 MRU 次卡或
 * 回主屏），跳过——否则会把旧实例塞回新应用正在用的槽里。
 */
function restoreOriginAfterClose(): void {
  const origin = slotOriginAppId
  const target = switchedTo
  slotOriginAppId = null
  switchedTo = null
  if (!origin) return
  if (target !== null && target !== `app:${origin}`) return
  if (state.activeCard.value !== `app:${origin}`) return
  returnAppSurfaceToSlot(origin)
}

// 开合时同步：`flush: 'post'` 保证 `v-if` 插入的元素在回调里已经存在（不用手工 nextTick）
watch(open, syncBandAndFocus, { flush: 'post' })

onMounted(() => {
  window.addEventListener('resize', measureBand)
  // 覆盖「挂载时全屏层已经打开」的形态（immediate 观感上拿不到 ref，交给挂载钩子）
  syncBandAndFocus()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', measureBand)
  unobserveBand()
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
  // 记录切换目标：收起时据此判断实例去向（切到别的面不抢挂载槽）
  switchedTo = key
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

/* 卡片带：卡片数决定卡片尺寸（与移动端 recents 同一条产品口径）。
   卡宽由卡片自身注入（`--ts-card-w`，见 composables/recentsLayout.ts）：1 张 =
   带内最大 3:4 卡、居中；越多越小，最小缩到「3 列 × 2 行」的格子；第 7 张起
   不再缩小，改为整带纵向滚动。
   网格拆成 6 个半列轨道、每张卡跨 2 轨：(卡宽 - 间距) / 2 让「跨 2 轨 + 轨间
   gap」恰好等于一张卡宽，6 轨总宽 = 3 张卡 + 2 个间距。半列的唯一目的是末行
   不满 3 张时能精确居中（2 张各让半卡、1 张落在正中，见 recentsCardPlacement）。
   注意：这里**不能**加 container-type:size 去按 cqh 收敛卡片高度——WebKitGTK
   下容器查询高度解析为 0，卡片会塌成不可见（2026-10-23 实测）。 */
.ts-cards {
  --ts-gap: 16px;
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(
    var(--ts-tracks, 6),
    calc((var(--ts-card-w, calc((100% - var(--ts-gap) * 2) / 3)) - var(--ts-gap)) / 2)
  );
  justify-content: center;
  align-items: center;
  align-content: center;
  /* 行高 = 卡高（由 --ts-card-h 显式给出）：交给 auto 时，Chromium 会在内容超过
     带高的情况下把隐式行压扁去填满容器，卡片溢出到带顶之外、首行不可见。
     2 行放得下时居中，超过 2 行（is-scrolling）必须置顶，否则首行滚不到。 */
  grid-auto-rows: var(--ts-card-h, auto);
  /* 必须显式 width:100%：.ts-inner 是列向 flex，而 margin:0 auto 会取消 stretch
     （cross-axis auto margin 优先于 align-self:stretch）→ 不带 width 时卡片带会缩成
     内容宽，卡宽再按带宽解算就成了循环依赖：单卡时带只有一张卡宽，卡越少越小。
     2026-10-24 真浏览器实测（chrome-headless）：去掉这行，单卡带 = 137px。 */
  width: 100%;
  max-width: 1320px;
  margin: 0 auto;
  gap: var(--ts-gap);
  overflow-y: auto;
  overflow-x: hidden;
  padding: 4px 2px 12px;
  scrollbar-width: thin;
}
/* 空态：卡片带里没有卡片时，空态块占满整行并居中 */
.ts-cards.is-empty {
  align-content: center;
}
/* 超过 2 行：改成从头排（可滚动），首行不能被居中裁到带顶之外 */
.ts-cards.is-scrolling {
  align-content: start;
}

/* 卡片：横版 16/10（缩略区 flex 撑满 + 顶部信息条）——桌面应用界面本来就是横向的，
   竖卡只能把真实画面缩成中间一条带；比例与 recentsLayout 的 RECENTS_CARD_ASPECT 同源。
   宽度 = 跨 2 个半列轨道（轨道宽由 `--ts-card-w` 注入，见 recentsLayout）：
   少卡大、多卡小，最小到 2 行 3 列的格，第 7 张起整带滚动；兜底（首帧测量前 /
   无 ResizeObserver）是三等分，保证未测量时也不会溢出。
   末行不满 3 张时 `cardStyle` 注入起始轨把它整组居中；其余卡片自动排布。
   box-sizing 必须 border-box：卡宽含 1px 描边，否则轨宽按内容算会多 2px。
   aspect-ratio 与 RECENTS_CARD_ASPECT 同源（改一处必须改另一处）。 */
.ts-card {
  position: relative;
  box-sizing: border-box;
  min-width: 0;
  grid-column: span 2;
  aspect-ratio: 16 / 10;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-sheet);
  background: var(--bg-card);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-card);
  overflow: hidden;
  /* 安卓 recents 观感：卡片从略小、略低处缩放上浮，逐张错峰入场 */
  animation: ts-card-in var(--motion-duration-slow) var(--motion-ease) backwards;
  animation-delay: calc(var(--i, 0) * 45ms);
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
/* 缩略区：app 卡 = 真实实例的当前页面（AppSurfaceTile 搬运 + 等比缩放）；
   系统页卡 = 品牌渐变底 + 图标居中。实例搬运 / 回退切换不改变盒子尺寸，
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
  /* 空态独占一整行（网格 6 轨全跨） */
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

@keyframes ts-card-in {
  from {
    opacity: 0;
    transform: scale(0.82) translateY(26px);
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
/* 退出：卡片随全屏层一起轻微缩回（反向的 recents 缩放），
   先关掉入场 animation，避免它盖住 leave 过渡的 transform。 */
.ts-fade-leave-active .ts-card {
  animation: none;
  transition:
    transform var(--motion-duration-fast) var(--motion-ease-in),
    opacity var(--motion-duration-fast) var(--motion-ease-in);
}
.ts-fade-leave-to .ts-card {
  transform: scale(0.92) translateY(10px);
  opacity: 0;
}

/* 多任务层 Teleport 到 body，壳根的统一 reduced-motion 规则够不到这里 */
@media (prefers-reduced-motion: reduce) {
  .ts-card {
    animation: none;
  }
  .ts-fade-enter-active,
  .ts-fade-leave-active,
  .ts-fade-leave-active .ts-card {
    transition-duration: 0.01ms;
  }
}
</style>
