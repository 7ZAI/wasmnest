import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, onMounted, onUnmounted, ref } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { useHomeSearch } from '@/shell/useHomeSearch'

/**
 * 主屏 type-to-search 输入链（2026-10-17 验证 P0-3 的回归锁）
 *
 * 被钉住的契约（就是原来的盲区——没有任何测试走过这条链）：
 * 1. **焦点在输入框** → 浏览器插入字符，本层不重复追加（一次按键 = 一个字符）；
 * 2. **焦点不在输入框**（实机里第一次键入后焦点会丢失）→ 本层自己追加，
 *    并 `preventDefault` 挡掉默认动作（不产生第二个字符），随后把焦点交回输入框；
 * 3. 退格在失焦态同样生效（原实现失焦后 Backspace 完全无效）；
 * 4. IME 合成中的按键不按字符处理（否则拼音串被拆成乱码），只把焦点交回输入框；
 * 5. 非主屏（`active() === false`）一个键都不碰。
 *
 * happy-dom 不会替我们执行按键的默认动作，所以「浏览器插入」由用例按被消费与否
 * 显式模拟——这正是要钉住的分工：`defaultPrevented` 即「本层已消费」。
 */
describe('useHomeSearch（type-to-search 输入链）', () => {
  let query = ref('')
  let active = ref(true)
  let wrapper: VueWrapper | null = null
  let inputEl: HTMLInputElement | null = null

  const Host = defineComponent({
    setup() {
      const input = ref<HTMLInputElement | null>(null)
      const { onSearchInput, handleSearchKeydown } = useHomeSearch({
        inputEl: input,
        query,
        active: () => active.value,
      })
      // 与 ShellHost 同形：window 上监听（bubble 阶段），只问一句「消费了吗」
      const onKeydown = (e: KeyboardEvent) => {
        handleSearchKeydown(e)
      }
      onMounted(() => window.addEventListener('keydown', onKeydown))
      onUnmounted(() => window.removeEventListener('keydown', onKeydown))

      return () =>
        h('input', {
          ref: (el: unknown) => {
            if (el) {
              input.value = el as HTMLInputElement
              inputEl = el as HTMLInputElement
            }
          },
          value: query.value,
          onInput: onSearchInput,
        })
    },
  })

  beforeEach(() => {
    query = ref('')
    active = ref(true)
    inputEl = null
    wrapper = mount(Host, { attachTo: document.body })
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  /** 模拟一次按键：事件发到当前焦点元素（未聚焦则 body），再按「是否被消费」 */
  function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const target: EventTarget = (document.activeElement as HTMLElement) ?? document.body
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    })
    target.dispatchEvent(event)
    // 未被本层消费 = 交给浏览器：只在输入框已获得焦点时插入字符（模拟默认动作）
    if (!event.defaultPrevented && key.length === 1 && document.activeElement === inputEl && inputEl) {
      inputEl.value += key
      inputEl.dispatchEvent(new Event('input', { bubbles: true }))
    }
    return event
  }

  function type(text: string): void {
    for (const ch of text) press(ch)
  }

  it('失焦态键入：字符不丢且不重复（chat 逐键成串）', () => {
    expect(document.activeElement).not.toBe(inputEl)
    type('chat')
    expect(query.value).toBe('chat')
    // 每次按键后焦点被交回输入框：IME 合成与后续键入都有落点
    expect(document.activeElement).toBe(inputEl)
  })

  it('已聚焦键入：完全交给浏览器，本层不追加（无重复字符）', () => {
    inputEl?.focus()
    type('hub')
    expect(query.value).toBe('hub')
  })

  it('交替失焦 / 聚焦也不丢键（实机 P0-3 的形态）', () => {
    press('c')
    inputEl?.blur()
    press('h')
    inputEl?.blur()
    type('at')
    expect(query.value).toBe('chat')
  })

  it('退格在失焦态生效（原实现完全无效）', () => {
    type('chat')
    inputEl?.blur()
    press('Backspace')
    expect(query.value).toBe('cha')
  })

  it('IME 合成中的按键不按字符追加，只承接焦点', () => {
    const event = new KeyboardEvent('keydown', { key: 'Process', bubbles: true, cancelable: true })
    // 合成中的判据是 isComposing / keyCode 229；happy-dom 对两者的默认实现不一致，
    // 两个都钉上（任一生效即走合成分支，与真实浏览器同义）
    for (const [prop, value] of [
      ['isComposing', true],
      ['keyCode', 229],
    ] as const) {
      try {
        Object.defineProperty(event, prop, { value, configurable: true })
      } catch {
        // 该属性不可覆盖：另一条判据已足够
      }
    }
    document.body.dispatchEvent(event)
    expect(query.value).toBe('') // 没有把 'Process' 当字符写进去
    expect(document.activeElement).toBe(inputEl)
  })

  it('非主屏不接管任何键（应用面键盘归应用）', () => {
    active.value = false
    const event = press('c')
    expect(query.value).toBe('')
    expect(event.defaultPrevented).toBe(false)
  })
})
