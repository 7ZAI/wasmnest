<template>
  <!--
    数字步进输入（token 皮肤 + reka-ui Primitive 原语）
    右侧竖排两个大按钮取代浏览器原生 spinner（原生上下箭头只有 6px 左右，点不中也不吃 token）。
  -->
  <div
    class="wb-nf"
    :class="[sizeCls, { 'wb-nf-disabled': disabled, 'wb-nf-readonly': readonly }]"
    :style="width ? { width } : undefined"
  >
    <Primitive
      as="input"
      :id="inputId"
      class="wb-nf-input"
      :class="[{ 'wb-nf-input-right': align === 'right' }, mono && 'wb-mono']"
      type="text"
      role="spinbutton"
      inputmode="numeric"
      autocomplete="off"
      spellcheck="false"
      :value="text"
      :disabled="disabled"
      :readonly="readonly"
      :aria-label="ariaLabel"
      :aria-valuenow="modelValue ?? undefined"
      :aria-valuemin="min"
      :aria-valuemax="max"
      :aria-valuetext="text || undefined"
      :data-testid="testid"
      @input="onInput"
      @keydown="onKeydown"
      @blur="onBlur"
    />
    <span class="wb-nf-steppers">
      <button
        type="button"
        class="wb-nf-btn"
        tabindex="-1"
        :aria-label="labelIncrease"
        :disabled="disabled || readonly || atMax"
        @click="stepBy(1)"
      >
        <svg viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.75"
            d="M3 7.5 6 4.5l3 3"
          />
        </svg>
      </button>
      <button
        type="button"
        class="wb-nf-btn"
        tabindex="-1"
        :aria-label="labelDecrease"
        :disabled="disabled || readonly || atMin"
        @click="stepBy(-1)"
      >
        <svg viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.75"
            d="M3 4.5 6 7.5l3-3"
          />
        </svg>
      </button>
    </span>
  </div>
</template>

<script setup lang="ts">
/**
 * NumberField — 数字输入（含步进按钮）共享组件
 *
 * 为什么取代原生 `<input type="number">`：原生 spinner 由浏览器绘制，箭头只有 6px 左右、
 * 不吃 token 也不吃 `--ui-scale`，在设置页里既点不中也难看（「原生 UI 禁令」同口径）。
 *
 * 实现路线：reka-ui 的 `Primitive` 原语（开源 headless，Radix UI 的 Vue 版，也是
 * shadcn-vue 的底层）+ 本组件的受控状态。**没有**直接用 reka-ui 的 `NumberField` 成套
 * 组件，原因是它把输入框渲染成受控 `value`，用户键入后内部 `inputValue` 与 `textValue`
 * 不同步，失焦时会把已输入的合法值回退成旧值（实测键入 600、失焦后框里变回 300）。
 * 这里只借原语的元素下发与属性转发，值、解析、钳制、提交时机全部在本组件内闭合。
 *
 * 取值口径：
 * - 手动输入不做「吸附到步进网格」（端口 8765、超时 45 这类值不该被悄悄改掉），
 *   只按 `min`/`max` 硬钳制，并按整数取整。
 * - `update:modelValue`：合法键入即时上抛（受控：调用方回写即生效）。
 * - `commit`：失焦 / 回车时上抛**钳制后**的最终值——落盘用它，不要在 `@blur` 里读事件值。
 * - 清空输入不提交（调用方保留原值），避免「清空即写 0」。
 */
import { Primitive } from 'reka-ui'
import { computed, ref, watch } from 'vue'

interface Props {
  /** 当前值；清空后以 null 回抛 */
  modelValue: number | null
  min?: number
  /** 不传 = 不设上限 */
  max?: number
  /** 每次点击 / 方向键的变化量，默认 1 */
  step?: number
  /** 框体尺寸：sm = 插件紧凑行（32px / 12px），md = 宿主表单默认（--input-height） */
  size?: 'sm' | 'md'
  /** 文本对齐：设置页右侧控件用 right，表单字段用 left */
  align?: 'left' | 'right'
  /** 宽度（CSS 长度）；不传则铺满父容器 */
  width?: string
  /** 等宽字体（端口 / 秒数这类纯数字更整齐），默认 true */
  mono?: boolean
  disabled?: boolean
  readonly?: boolean
  /** 无障碍名称（没有外置 label 时必须给） */
  ariaLabel?: string
  /** 输入框 id；与外部 `<label for>` 配对时必传（否则标签点不到输入框） */
  inputId?: string
  /** 增/减按钮的无障碍名称，默认 "增加"/"减少" */
  labelIncrease?: string
  labelDecrease?: string
  testid?: string
}

const props = withDefaults(defineProps<Props>(), {
  min: undefined,
  max: undefined,
  step: 1,
  size: 'sm',
  align: 'right',
  width: undefined,
  mono: true,
  disabled: false,
  readonly: false,
  ariaLabel: undefined,
  inputId: undefined,
  labelIncrease: '增加',
  labelDecrease: '减少',
  testid: undefined,
})

const emit = defineEmits<{
  /** 合法键入 / 步进后的值；清空为 null */
  (e: 'update:modelValue', value: number | null): void
  /** 输入结束，携带钳制后的最终值——落盘时机 */
  (e: 'commit', value: number): void
}>()

/** 用户正在编辑的原始文本；非编辑态跟随 modelValue 格式化回显 */
const draft = ref<string>(props.modelValue === null ? '' : String(props.modelValue))
const editing = ref(false)

watch(
  () => props.modelValue,
  (next) => {
    // 编辑中不打断用户键入（受控回写由文本本身体现）；非编辑态同步外部改动
    if (editing.value) return
    draft.value = next === null ? '' : String(next)
  },
)

const text = computed(() => draft.value)

/** 收敛到 [min, max] 并取整 */
function clampValue(value: number): number {
  let next = Math.round(value)
  if (props.min !== undefined) next = Math.max(props.min, next)
  if (props.max !== undefined) next = Math.min(props.max, next)
  return next
}

/** 解析文本框内容：空 / 非数字返回 null */
function parseDraft(): number | null {
  const raw = draft.value.trim()
  if (raw === '') return null
  // 只接受可选负号 + 数字，避免 "12abc" / "1e5" 这类被 Number 宽松接受
  if (!/^-?\d+$/.test(raw)) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

const atMin = computed(() => props.min !== undefined && (props.modelValue ?? 0) <= props.min)
const atMax = computed(() => props.max !== undefined && (props.modelValue ?? 0) >= props.max)

function onInput(e: Event) {
  const el = e.target as HTMLInputElement
  editing.value = true
  // 过滤掉数字与负号以外的键入，光标位置不受影响（只挡非法字符，不改合法输入）
  const cleaned = el.value.replace(/[^\d-]/g, '')
  if (cleaned !== el.value) el.value = cleaned
  draft.value = cleaned
  const parsed = parseDraft()
  emit('update:modelValue', parsed)
}

/** 按 step 增减：以当前生效值（文本框解析值优先）为基准 */
function stepBy(direction: 1 | -1) {
  if (props.disabled || props.readonly) return
  const base = parseDraft() ?? props.modelValue ?? props.min ?? 0
  const next = clampValue(base + direction * props.step)
  editing.value = false
  draft.value = String(next)
  emit('update:modelValue', next)
  emit('commit', next)
}

function onKeydown(e: KeyboardEvent) {
  if (e.isComposing) return
  // 方向键单步；PageUp/PageDown 十倍步进（与原生 number 一致）
  const multiplier = e.key === 'PageUp' || e.key === 'PageDown' ? 10 : 1
  if (e.key === 'ArrowUp' || e.key === 'PageUp') {
    e.preventDefault()
    stepTimes(multiplier)
  } else if (e.key === 'ArrowDown' || e.key === 'PageDown') {
    e.preventDefault()
    stepTimes(-multiplier)
  } else if (e.key === 'Home' && props.min !== undefined) {
    e.preventDefault()
    setValue(props.min)
  } else if (e.key === 'End' && props.max !== undefined) {
    e.preventDefault()
    setValue(props.max)
  } else if (e.key === 'Enter') {
    // 回车：与失焦同口径（原生 number 输入也是回车即提交）
    e.preventDefault()
    commitInput()
    ;(e.target as HTMLInputElement).blur()
  }
}

function stepTimes(multiplier: number) {
  if (props.disabled || props.readonly) return
  const base = parseDraft() ?? props.modelValue ?? props.min ?? 0
  const next = clampValue(base + Math.sign(multiplier) * props.step * Math.abs(multiplier))
  editing.value = false
  draft.value = String(next)
  emit('update:modelValue', next)
  emit('commit', next)
}

function setValue(value: number) {
  editing.value = false
  draft.value = String(value)
  emit('update:modelValue', value)
  emit('commit', value)
}

/**
 * 失焦：把键入值收敛后落盘，并把框内文本改成收敛结果。
 * 收敛在本组件里算，不依赖任何三方库的回写时序。
 */
function commitInput() {
  const parsed = parseDraft()
  editing.value = false
  if (parsed === null) {
    // 非法 / 清空：回到当前受控值，不提交
    draft.value = props.modelValue === null ? '' : String(props.modelValue)
    return
  }
  const next = clampValue(parsed)
  draft.value = String(next)
  if (next !== props.modelValue) emit('update:modelValue', next)
  emit('commit', next)
}

function onBlur() {
  commitInput()
}
</script>

<style>
/**
 * 样式刻意不加 scoped：Tailwind 由宿主 / 各插件 app 自编译，SDK 组件的 class 也要在
 * 全局样式表里生效；副作用面由 `wb-nf` 前缀收敛。颜色全部绑定 token，随主题与
 * `--ui-scale` 一起变。
 */
.wb-nf {
  display: inline-flex;
  align-items: stretch;
  box-sizing: border-box;
  overflow: hidden;
  border: 1px solid var(--border-input);
  border-radius: var(--radius-input, 8px);
  background: var(--bg-input);
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

/* 焦点环挂在容器上（真正聚焦的是里面的 input） */
.wb-nf:focus-within {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary) 18%, transparent);
}

.wb-nf-disabled,
.wb-nf-readonly {
  opacity: 0.5;
}

/* 尺寸：sm = 插件设置页紧凑行（与既有 h-8 / 12px 控件同高） */
.wb-nf-sm {
  height: 32px;
}

.wb-nf-sm .wb-nf-input {
  font-size: 12px;
}

/* md = 宿主表单默认高度，字号与 Select(md) 对齐 */
.wb-nf-md {
  height: var(--input-height, 36px);
}

.wb-nf-md .wb-nf-input {
  padding: 0 12px;
  font-size: 14px;
}

.wb-nf-md .wb-nf-steppers {
  width: 24px;
}

.wb-nf-input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0 8px;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  line-height: 1.2;
}

.wb-nf-input-right {
  text-align: right;
}

/* 右侧竖排步进按钮：各占半高，可点区域远大于原生 spinner 的 6px 小箭头 */
.wb-nf-steppers {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  width: 20px;
  border-left: 1px solid var(--border-input);
}

.wb-nf-btn {
  display: flex;
  flex: 1 1 0;
  align-items: center;
  justify-content: center;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  transition:
    background-color 0.12s ease,
    color 0.12s ease;
}

.wb-nf-btn svg {
  width: 10px;
  height: 10px;
}

.wb-nf-btn:hover:not(:disabled) {
  background: var(--color-primary-light);
  color: var(--color-primary);
}

.wb-nf-btn:disabled {
  cursor: not-allowed;
  opacity: 0.3;
}

/* 上下两格之间的细分隔线，视觉上分成两个可点区域 */
.wb-nf-btn + .wb-nf-btn {
  border-top: 1px solid var(--border-input);
}
</style>
