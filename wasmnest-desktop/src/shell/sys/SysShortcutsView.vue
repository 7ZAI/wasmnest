<template>
  <!-- ==================== 按键绑定 ====================
       一行一动作：名称 + 说明在左（.row-sw .lb），键位控件在右。键位控件三态：
       展示（点击进入录制）/ 录制（聚焦 input 捕获 keydown）/ 恢复默认（仅与出厂
       键位不同时出现）。冲突 = 保存失败并留在录制态（fail-visible）；保留键 =
       允许保存但常驻警示。 -->
  <ShellCard :title="t('shell.shortcuts.cardTitle')" icon="bolt">
    <p class="hint">{{ t('shell.shortcuts.hint') }}</p>

    <div v-for="a in SHORTCUT_ACTIONS" :key="a.id" class="sc-item">
      <div class="row-sw">
        <div class="lb">
          <b>{{ t(a.nameKey) }}</b>
          <span class="row-desc">{{ t(a.descKey) }}</span>
        </div>
        <div class="kbd-cell">
          <!-- 录制态：readonly input 只做焦点锚点与语义载体，按键语义全在 keydown 捕获 -->
          <input
            v-if="editingAction === a.id"
            :ref="setRecorderEl"
            class="kbd-btn recording"
            readonly
            :value="t('shell.shortcuts.recording')"
            :aria-label="t('shell.shortcuts.changeBinding', { action: t(a.nameKey) })"
            :aria-describedby="msgOf(a.id) ? msgId(a.id) : undefined"
            @keydown="onRecorderKeydown($event, a.id)"
            @blur="cancelEdit"
          />
          <button
            v-else
            type="button"
            class="kbd-btn"
            :class="{ unbound: bindingOf(a.id) === '' }"
            :aria-label="t('shell.shortcuts.changeBinding', { action: t(a.nameKey) })"
            :aria-describedby="msgOf(a.id) ? msgId(a.id) : undefined"
            @click="startEdit(a.id)"
          >
            {{ bindingOf(a.id) === '' ? t('shell.shortcuts.unbound') : bindingOf(a.id) }}
          </button>
          <button
            v-if="!isEditing(a.id) && bindingOf(a.id) !== a.defaultBinding"
            type="button"
            class="shell-mini"
            @click="resetRow(a.id)"
          >
            <ShellIcon name="reset" :size="11" />
            {{ t('shell.shortcuts.resetRow') }}
          </button>
        </div>
      </div>
      <p
        v-if="msgOf(a.id)"
        :id="msgId(a.id)"
        class="row-msg"
        :class="msgOf(a.id)?.kind"
        role="alert"
      >
        {{ rowMsgText(a.id) }}
      </p>
    </div>

    <div class="reset-all">
      <button type="button" class="shell-mini" @click="resetAll">
        <ShellIcon name="reset" :size="11" />
        {{ t('shell.shortcuts.resetAll') }}
      </button>
    </div>
  </ShellCard>
</template>

<script setup lang="ts">
/**
 * SysShortcutsView — 系统页「设置 → 快捷键」二级页（壳内实现）
 *
 * 2026-10-28：桌面壳快捷键配置（ADR 0060）——九个宿主动作的单绑定录入。
 * 决策全在 shortcutsModel（纯函数）/ useShellShortcuts（装配），本组件只做
 * 录制交互与行内反馈；录制期间挂起全局 capture 抢占（suspendShortcutCapture），
 * 否则按下的新组合会先被抢占逻辑吞掉。
 *
 * UI 技能记录（docs/frontend.md §4，开发前已装载）：ui-ux-pro-max 检索
 * 「keyboard shortcut capture recorder inline validation」——行内错误贴着字段
 * （aria-describedby 关联 + role=alert）；design-taste-frontend「组件匹配周边
 * 设计系统」——复用 ShellCard / .row-sw / shell-mini / token，无新增色与字体
 * （键位展示用 --font-mono，与外观页字号数值同语汇）。
 */
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  SHORTCUT_ACTIONS,
  comboFromEvent,
  validateBinding,
  type ShortcutActionId,
} from '../composables/shortcutsModel'
import {
  resumeShortcutCapture,
  suspendShortcutCapture,
  useShellShortcuts,
} from '../composables/useShellShortcuts'
import ShellCard from '../components/ShellCard.vue'
import ShellIcon from '../components/ShellIcon.vue'

const { t } = useI18n()
const shortcuts = useShellShortcuts()

const bindings = computed(() => shortcuts.bindings.value)
function bindingOf(id: ShortcutActionId): string {
  return bindings.value[id]
}

// ==================== 录制态 ====================

const editingAction = ref<ShortcutActionId | null>(null)
const recorderEl = ref<HTMLInputElement | null>(null)
function setRecorderEl(el: unknown): void {
  recorderEl.value = (el as HTMLInputElement) ?? null
}

function isEditing(id: ShortcutActionId): boolean {
  return editingAction.value === id
}

function startEdit(id: ShortcutActionId): void {
  editingAction.value = id
  deleteMsg(id)
  suspendShortcutCapture()
  void nextTick(() => recorderEl.value?.focus())
}

/** 退出录制（唯一出口：成功保存 / 清除 / Esc / 失焦都汇到这里，保证让位标记复原） */
function finishEdit(): void {
  editingAction.value = null
  recorderEl.value = null
  resumeShortcutCapture()
}

function cancelEdit(): void {
  finishEdit()
}

function resetRow(id: ShortcutActionId): void {
  shortcuts.resetBinding(id)
  deleteMsg(id)
}

function resetAll(): void {
  shortcuts.resetAllBindings()
  rowMsg.value = {}
}

// ==================== 行内消息（错误 fail-visible / 警示常驻） ====================

interface RowMsg {
  kind: 'error' | 'warn'
  key: string
  /** conflict 文案的动作名参数 */
  action?: string
}
const rowMsg = ref<Partial<Record<ShortcutActionId, RowMsg>>>({})

function msgOf(id: ShortcutActionId): RowMsg | undefined {
  return rowMsg.value[id]
}
function msgId(id: ShortcutActionId): string {
  return `sc-msg-${id}`
}
function setMsg(id: ShortcutActionId, msg: RowMsg | undefined): void {
  if (msg) rowMsg.value[id] = msg
  else delete rowMsg.value[id]
  // 触发响应式（delete 不被 reactive 追踪的兜底——Partial 记录整体替换）
  rowMsg.value = { ...rowMsg.value }
}
function deleteMsg(id: ShortcutActionId): void {
  setMsg(id, undefined)
}
function rowMsgText(id: ShortcutActionId): string {
  const msg = msgOf(id)
  if (!msg) return ''
  return msg.action ? t(msg.key, { action: msg.action }) : t(msg.key)
}

// ==================== 录制捕获 ====================

function onRecorderKeydown(e: KeyboardEvent, id: ShortcutActionId): void {
  // 录制框是全局让位期间的唯一键盘消费者：吃掉一切按键，不冒泡到 ShellHost
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'Escape') {
    finishEdit()
    return
  }
  // 裸 Backspace = 清除绑定（组合归还应用）；带修饰键的 Backspace 按组合录入
  if (e.code === 'Backspace' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
    shortcuts.setBinding(id, '')
    finishEdit()
    return
  }
  const combo = comboFromEvent(e)
  if (!combo) return // 纯修饰键：等待主键（提示文案已在输入框里）

  const verdict = validateBinding(combo, bindings.value, id)
  if (!verdict.ok && verdict.missingModifier) {
    setMsg(id, { kind: 'error', key: 'shell.shortcuts.missingModifier' })
    return // 留在录制态，等用户换键（fail-visible）
  }
  if (!verdict.ok && verdict.conflict) {
    const other = SHORTCUT_ACTIONS.find((x) => x.id === verdict.conflict)
    setMsg(id, {
      kind: 'error',
      key: 'shell.shortcuts.conflict',
      action: other ? t(other.nameKey) : verdict.conflict,
    })
    return
  }
  shortcuts.setBinding(id, combo)
  setMsg(id, verdict.reserved ? { kind: 'warn', key: 'shell.shortcuts.reserved' } : undefined)
  finishEdit()
}
</script>

<style scoped>
/* 录制说明（卡头下一行）；行内消息贴字段（ui-ux-pro-max inline-validation 结论） */
.hint {
  font-size: calc(11px * var(--ui-scale));
  color: var(--text-tertiary);
  line-height: 1.55;
}
.row-desc {
  display: block;
  font-size: calc(11px * var(--ui-scale));
  color: var(--text-tertiary);
}
/* 动作行分隔线包在 sc-item 上（行内消息不能打断 .row-sw 的邻接判定） */
.sc-item {
  border-top: 1px solid var(--border);
}
.hint + .sc-item {
  border-top: 0;
}
.kbd-cell {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-shrink: 0;
}
/* 键位框：键帽语汇（mono + 描边框），与外观页字号数值同用 --font-mono */
.kbd-btn {
  min-width: 108px;
  height: 26px;
  padding: 0 10px;
  text-align: center;
  font-family: var(--font-mono);
  font-size: calc(11px * var(--ui-scale));
  color: var(--text-primary);
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-button);
  cursor: pointer;
  white-space: nowrap;
  transition:
    background-color var(--motion-duration-fast) var(--motion-ease),
    border-color var(--motion-duration-fast) var(--motion-ease);
}
.kbd-btn:hover {
  background: var(--bg-hover);
}
button.kbd-btn.unbound {
  color: var(--text-tertiary);
  border-style: dashed;
}
/* 录制中：主色描边表达「在听」，输入本体由全局 :focus-visible 焦点环覆盖 */
input.kbd-btn.recording {
  color: var(--text-secondary);
  border-color: var(--color-primary);
  cursor: text;
}
.row-msg {
  margin: -3px 2px 0;
  font-size: calc(11px * var(--ui-scale));
  line-height: 1.5;
}
.row-msg.error {
  color: var(--color-danger-ink);
}
.row-msg.warn {
  color: var(--color-warning-ink);
}
.reset-all {
  display: flex;
  justify-content: flex-end;
  padding-top: 4px;
}
</style>
