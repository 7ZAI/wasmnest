<template>
  <Transition name="shell-panel">
    <div
      v-if="open"
      class="panel shell-notif-panel shell-glass"
      role="dialog"
      :aria-label="t('shell.notif.title')"
    >
      <!-- 面板头 -->
      <div class="panel-h">
        <span class="t">{{ t('shell.notif.title') }}</span>
        <span class="n">{{ total }} {{ t('shell.notif.countUnit') }}</span>
        <span class="grow"></span>
        <button
          v-if="state.notifs.value.some((n) => !n.sticky)"
          class="shell-mini"
          @click="clearAll"
        >
          {{ t('shell.notif.clearAll') }}
        </button>
        <button class="shell-mini" :aria-label="t('shell.notif.close')" @click="close">
          <ShellIcon name="x" :size="12" />
        </button>
      </div>

      <div class="panel-in">
        <!-- 列表流 = 分区标题与通知卡同处一个 TransitionGroup：条目（含标题）离场时
             绝对定位脱流，同组其余节点由 FLIP move 平滑收拢——否则某区清空时
             下面的分区标题会瞬跳。不设 appear：面板打开不重播整组入场。 -->
        <TransitionGroup tag="div" name="ntf-list" class="panel-flow">
          <!-- 待处理区：审批通知（动态派生；批准后走同一离场动画消失） -->
          <div v-if="approvals.length" key="pending" class="blk-t">
            {{ t('shell.notif.pending') }}<span class="line"></span>
          </div>
          <NotifCard
            v-for="n in approvals"
            :key="n.id"
            :notif="n"
            @action="() => onApprovalAction(n)"
          />

          <!-- 通知区：可清除卡携带交错 delay 变量（全部清除时自上而下逐张滑出） -->
          <div key="notifs" class="blk-t">
            {{ t('shell.notif.notifications') }}<span class="line"></span>
          </div>
          <NotifCard
            v-for="(n, idx) in state.notifs.value"
            :key="n.id"
            :notif="n"
            :style="{ '--ntf-leave-delay': leaveDelayFor(idx) }"
            @dismiss="dismissOne(n.id)"
            @action="onNotifAction(n, $event)"
          />

          <div v-if="empty" key="empty" class="empty-note">
            <ShellIcon name="bell" :size="18" />
            <span>{{ t('shell.notif.empty') }}</span>
          </div>
        </TransitionGroup>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
/**
 * ShellNotificationPanel — 通知中心（工具栏锚定下拉面板，spec-c §7）
 *
 * 审批区（待处理）+ 通知区（事件/进度/信息卡片）。快捷设置（主题 / 动画 /
 * 链路加密 / 防休眠）自 2026-10-19 拆分为独立面板（ShellQuickSettings，工具栏
 * 独立图标入口），不再与通知混在一起。宿主只承载机制面：来源 / 驻留 / 动作 /
 * 时间；文案由来源方给出。
 *
 * 2026-10-20 移除动效：单条 × 关闭 = 向关闭键方向右滑出 + 轻缩淡出（130ms）；
 * 「清除全部」= 自上而下交错滑出（35ms/条）；同组剩余标题与卡片由 FLIP move
 * 平滑收拢（200ms）。只动 transform/opacity；减弱动态由 shell.css 的
 * `.shell-root *` 全局兜底压瞬时。交错标志（bulkClearing）是本组件内的纯 UI
 * 时序态，数据源仍收口 useShellState。
 */
import { computed, nextTick, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useShellState } from '../composables/useShellState'
import ShellIcon from './ShellIcon.vue'
import NotifCard from './NotifCard.vue'
import type { HostNotif } from '../types'

const { t } = useI18n()
const state = useShellState()

const open = computed(() => state.panelOpen.value)
const approvals = computed(() => state.approvalNotifs())
const total = computed(() => approvals.value.length + state.notifs.value.length)
const empty = computed(() => !approvals.value.length && !state.notifs.value.length)

/** 全部清除的交错步长（逐张 +35ms）/ 复位余量（覆盖最慢一张的 130ms 退场） */
const CLEAR_STAGGER_MS = 35
const CLEAR_RESET_EXTRA_MS = 400

/** 交错退场标志：仅影响清除全部时的 --ntf-leave-delay 计算，不进数据面 */
const bulkClearing = ref(false)
let clearResetTimer: ReturnType<typeof setTimeout> | null = null

/** 通知区第 idx 张卡的离场 delay：全部清除时按位次交错，单条清除恒为 0ms */
function leaveDelayFor(idx: number): string {
  return bulkClearing.value ? `${idx * CLEAR_STAGGER_MS}ms` : '0ms'
}

/**
 * 清除全部：先让交错 delay 变量落进 DOM（nextTick），再真清数组——
 * TransitionGroup 离场节点不再重绑 props，各卡按清除前最后一次渲染的
 * delay 交错离场；复位用计数余量，防止标志残留误伤之后的单条退场。
 */
function clearAll(): void {
  if (bulkClearing.value) return
  bulkClearing.value = true
  nextTick(() => {
    const leaving = state.notifs.value.filter((n) => !n.sticky).length
    state.clearNotifs()
    if (clearResetTimer) clearTimeout(clearResetTimer)
    clearResetTimer = setTimeout(() => {
      bulkClearing.value = false
      clearResetTimer = null
    }, CLEAR_STAGGER_MS * leaving + CLEAR_RESET_EXTRA_MS)
  })
}

/** 单条关闭：不带交错（先复位标志，清掉复位余量窗口里可能的残留 delay） */
function dismissOne(id: string): void {
  bulkClearing.value = false
  if (clearResetTimer) {
    clearTimeout(clearResetTimer)
    clearResetTimer = null
  }
  state.dismissNotif(id)
}

onUnmounted(() => {
  if (clearResetTimer) clearTimeout(clearResetTimer)
})

function close() {
  state.panelOpen.value = false
}

/** 审批动作：去审批 = 关面板 + 开审批弹窗 */
function onApprovalAction(n: HostNotif) {
  if (!n.app) return
  state.panelOpen.value = false
  state.dialog.value = 'approval'
  state.dialogAppId.value = n.app
}

/** 事件通知动作：打开应用 / 重新打开 */
function onNotifAction(n: HostNotif, actionId: string) {
  if (actionId === 'open' && n.app) {
    state.panelOpen.value = false
    void state.openApp(n.app)
  }
}
</script>

<style scoped>
.panel {
  position: absolute;
  top: calc(var(--toolbar-h) + 6px);
  right: 8px;
  z-index: 45;
  width: 364px;
  max-height: min(480px, calc(100% - 60px));
  display: flex;
  flex-direction: column;
  /* 表面色与背景模糊由 .shell-glass 提供（背后是主屏 / 应用内容，玻璃才有意义） */
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
.panel-h .n {
  font-size: calc(11px * var(--ui-scale));
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}
.panel-h .grow {
  flex: 1;
}
.panel-in {
  overflow-y: auto;
  padding: 12px;
}
/* 列表流容器：块流布局——离场项 absolute 脱流后，其 static 位置按原行位解析
   （flex 容器会把 absolute 子项当「唯一的 flex 项」跳到顶部），必须用 block +
   相邻 margin 代替 gap；间距仍保持 10px 节奏。剩余项收拢交给 FLIP move。 */
.panel-flow {
  position: relative;
}
.panel-flow > * + * {
  margin-top: 10px;
}
/* 分区标签：句首大写的小标题（中文无大小写，靠字号 + 字重区分），
   右侧细线把标签与内容的分界拉通整行 */
.blk-t {
  font-size: calc(11px * var(--ui-scale));
  font-weight: 600;
  color: var(--text-secondary);
  letter-spacing: 0.04em;
  display: flex;
  align-items: center;
  gap: 8px;
}
.blk-t .line {
  flex: 1;
  height: 1px;
  background: var(--border);
}
/* 空态：静音铃铛 + 一行说明（图标比纯文本少一分「出错」感） */
.empty-note {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  text-align: center;
  padding: 20px 0 16px;
  font-size: calc(12px * var(--ui-scale));
  color: var(--text-secondary);
}
.empty-note svg {
  color: var(--text-tertiary);
  opacity: 0.75;
}
/* ==================== 条目移除 / 清除动效（只动 transform / opacity） ==================== */
/* 入场 = 新通知从顶部轻微滑入；面板打开不重播（TransitionGroup 未开 appear） */
.ntf-list-enter-active {
  transition:
    opacity var(--motion-duration-base) var(--motion-ease),
    transform var(--motion-duration-base) var(--motion-ease);
}
.ntf-list-enter-from {
  opacity: 0;
  transform: translateY(-6px) scale(0.98);
}
/* 离场（单条 × / 清除全部 / 审批通过）= 向关闭键方向滑出 + 轻缩 + 淡出。
   退出比收拢更快（130ms < 200ms）。absolute 脱流让收拢立即开始（不等动画走完）；
   delay 变量支持「清除全部」自上而下交错，单条离场恒为 0ms。 */
.ntf-list-leave-active {
  position: absolute;
  left: 0;
  right: 0;
  transition:
    opacity var(--motion-duration-fast) var(--motion-ease-in),
    transform var(--motion-duration-fast) var(--motion-ease-in);
  transition-delay: var(--ntf-leave-delay, 0ms);
}
.ntf-list-leave-to {
  opacity: 0;
  transform: translateX(14px) scale(0.96);
}
/* 剩余条目（含分区标题）收拢：TransitionGroup 用 FLIP 记前后位置差，只过渡 transform。
   减弱动态：shell.css 的 `.shell-root *` 兜底把 duration/delay 压成瞬时，不在此重复。 */
.ntf-list-move {
  transition: transform var(--motion-duration-base) var(--motion-ease);
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
