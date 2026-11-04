/**
 * NumberField 行为契约（取代原生 `<input type="number">` 的共享数字输入）
 *
 * 契约来源：原生 number 输入的既有语义（应用仓「原生 UI 禁令」下不得让浏览器自绘
 * spinner），加上本组件对外的两个出口。只断言外部行为，不测 class 与 DOM 结构。
 *
 * - C1 回显：`modelValue` 渲染进输入框；受控回写立即生效
 * - C2 步进：点右侧上/下按钮或按 ↑/↓ 各走一个 step
 * - C3 边界：到 max 后上按钮 disabled（反向同理），到底后不再改值
 * - C4 越界收敛：键入越界值在失焦时收敛到边界，`commit` 带收敛后的值
 * - C5 提交时机：合法值失焦 / 回车各提交一次；清空不提交（保留调用方原值）
 * - C6 禁用态：disabled / readonly 下按钮不可点
 * - C7 受控一致性：键入合法值后失焦，框内文本与提交值一致（不回退成旧值）
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import NumberField from '../src/ui/NumberField.vue'

function mountField(props: Record<string, unknown> = {}) {
  return mount(NumberField, {
    props: { modelValue: 300, min: 60, max: 3600, ...props },
  })
}

type Wrapper = ReturnType<typeof mountField>

/** 输入框：type=text + role=spinbutton（原生 number 的 spinner 是被替换掉的东西） */
function input(wrapper: Wrapper) {
  return wrapper.get('[role="spinbutton"]')
}

/** 右侧两个步进按钮：[0] 增，[1] 减 */
function steppers(wrapper: Wrapper) {
  return wrapper.findAll('.wb-nf-btn')
}

function inputValue(wrapper: Wrapper): string {
  return (input(wrapper).element as HTMLInputElement).value
}

describe('NumberField（共享数字输入）', () => {
  it('C1 回显：值渲染进输入框；受控回写更新显示', async () => {
    const wrapper = mountField()
    expect(inputValue(wrapper)).toBe('300')

    await wrapper.setProps({ modelValue: 600 })
    expect(inputValue(wrapper)).toBe('600')
  })

  it('C2 步进：点按钮各走一个 step，键盘 ↑/↓ 同口径', async () => {
    // 走 v-model 真实用法：父级回写后组件才「记住」上一步的值（受控组件口径）
    const wrapper = mount(
      {
        components: { NumberField },
        data: () => ({ value: 300 }),
        template: '<NumberField v-model="value" :min="60" :max="3600" :step="10" />',
      },
      { attachTo: document.body },
    )
    const host = wrapper as unknown as Wrapper
    const [up, down] = steppers(host)

    await up.trigger('click')
    expect(wrapper.vm.value).toBe(310)

    await down.trigger('click')
    expect(wrapper.vm.value).toBe(300)

    await input(host).trigger('keydown', { key: 'ArrowUp' })
    expect(wrapper.vm.value).toBe(310)

    await input(host).trigger('keydown', { key: 'ArrowDown' })
    expect(wrapper.vm.value).toBe(300)
  })

  it('C3 边界：到 max 后上按钮禁用，到 min 后下按钮禁用', () => {
    const atMax = steppers(mountField({ modelValue: 3600 }))
    expect(atMax[0].attributes('disabled')).toBeDefined()
    expect(atMax[1].attributes('disabled')).toBeUndefined()

    const atMin = steppers(mountField({ modelValue: 60 }))
    expect(atMin[0].attributes('disabled')).toBeUndefined()
    expect(atMin[1].attributes('disabled')).toBeDefined()
  })

  it('C4 越界收敛：低于 min / 高于 max 在失焦时收敛，commit 带收敛后的值', async () => {
    const low = mountField()
    await input(low).setValue('10')
    await input(low).trigger('blur')
    expect(low.emitted('commit')?.at(-1)).toEqual([60])
    expect(inputValue(low)).toBe('60')

    const high = mountField()
    await input(high).setValue('99999')
    await input(high).trigger('blur')
    expect(high.emitted('commit')?.at(-1)).toEqual([3600])
    expect(inputValue(high)).toBe('3600')
  })

  it('C5 提交时机：失焦提交、回车提交、清空不提交', async () => {
    const wrapper = mountField()

    await input(wrapper).setValue('600')
    await input(wrapper).trigger('blur')
    expect(wrapper.emitted('commit')?.at(-1)).toEqual([600])
    expect(wrapper.emitted('commit')).toHaveLength(1)

    await input(wrapper).setValue('700')
    await input(wrapper).trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('commit')?.at(-1)).toEqual([700])

    // 清空：不提交（调用方保留原值），值以 null 回抛
    const before = wrapper.emitted('commit')?.length
    await input(wrapper).setValue('')
    await input(wrapper).trigger('blur')
    expect(wrapper.emitted('commit')?.length).toBe(before)
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([null])
  })

  it('C6 禁用态：disabled / readonly 下两个按钮都不可点', () => {
    for (const flag of [{ disabled: true }, { readonly: true }]) {
      const buttons = steppers(mountField(flag))
      expect(buttons[0].attributes('disabled')).toBeDefined()
      expect(buttons[1].attributes('disabled')).toBeDefined()
    }
  })

  it('C7 受控一致性：键入合法值失焦后框内文本与提交值一致（不回退旧值）', async () => {
    const wrapper = mountField()
    await input(wrapper).setValue('600')
    await input(wrapper).trigger('blur')

    expect(wrapper.emitted('commit')?.at(-1)).toEqual([600])
    expect(inputValue(wrapper)).toBe('600')
  })

  it('过滤非法字符：字母被丢弃，纯数字留下', async () => {
    const wrapper = mountField()
    await input(wrapper).setValue('12ab34')
    expect(inputValue(wrapper)).toBe('1234')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([1234])
  })
})
