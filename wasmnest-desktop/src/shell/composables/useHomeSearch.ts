/**
 * 主屏 type-to-search（隐藏输入 + 全局按键接管）
 *
 * **为什么不是「按键 → focus 输入框，等浏览器插入字符」这么简单**：
 * 2026-10-17 实机验证（P0-3）里，主屏每轮获得焦点只吃得下 **1 个字符**——`chat`
 * 只落 `c`，下一轮再敲又只落一个；命令面板里真正的 `<input>` 则完全正常。也就是
 * 说焦点在第一次键入后没有稳定停留在隐藏输入上（WebKitGTK 对屏幕外 1×1 输入的
 * 焦点/默认插入时序不可靠）。纯靠 focus() 的隐式路径无法保证不丢键，因此这里做
 * 两条路并存：
 *
 * 1. **输入框已聚焦** → 字符插入 / 退格 / IME 合成全部交给浏览器（`@input` 同步回
 *    查询串），本层不抢——抢了会与浏览器默认动作重复插入一个字符；
 * 2. **输入框未聚焦** → 本层自己把字符追加进查询串（`preventDefault` 掉默认动作，
 *    避免重复），再把焦点交回输入框并**把光标放到末尾**，让紧随其后的 IME 合成 /
 *    连续键入有落点。
 *
 * 两条路对用户是同一个结果，所以焦点是否稳定不再影响输入完整性——这正是原实现
 * 缺的那一半。退格同理（原实现在焦点丢失后 Backspace 完全无效）。
 *
 * IME：合成中的按键（`isComposing` / keyCode 229）不按字符处理，只把焦点交回输入框
 * ——拼音串必须由真实输入框承接，把 `e.key` 当字符追加会得到乱码。
 */
import type { Ref } from 'vue'

export interface HomeSearchOptions {
  /** 隐藏输入元素（由组件持有：模板 `ref="searchInput"`；本 composable 只操作它） */
  inputEl: Ref<HTMLInputElement | null>
  /** 查询串真源（壳状态 `homeQ`） */
  query: Ref<string>
  /** 当前是否该接管按键（只有主屏接管；应用面 / 系统页键盘归各自的界面） */
  active: () => boolean
}

export function useHomeSearch(options: HomeSearchOptions) {
  const { query, inputEl: searchInput } = options

  /**
   * 聚焦输入框并把光标移到末尾。
   *
   * 先把 DOM 值与查询串对齐：本地追加路径下 `:value` 绑定还没 patch 到元素上，
   * 直接 focus 会让光标停在旧值位置（甚至开头），后续键入就插进了旧串中间。
   * `setSelectionRange` 在部分环境（未挂载 / 非文本控件）会抛，属预期，忽略即可。
   */
  function focusSearchInput(): void {
    const el = searchInput.value
    if (!el) return
    if (el.value !== query.value) el.value = query.value
    el.focus()
    const end = el.value.length
    try {
      el.setSelectionRange(end, end)
    } catch {
      // 选区 API 不可用时仅失去「光标在末尾」，不影响取值
    }
  }

  /** 输入框 → 查询串（合成中的中间态也同步，用户看得见已输入的拼音/中文） */
  function onSearchInput(e: Event): void {
    query.value = (e.target as HTMLInputElement).value
  }

  /** 清空查询并让出焦点（Esc / Enter 消费后调用） */
  function clearSearch(): void {
    query.value = ''
    searchInput.value?.blur()
  }

  /** 输入框是否持有焦点（分支判据只有这一处，模板不重复判断） */
  function isInputFocused(): boolean {
    return !!searchInput.value && document.activeElement === searchInput.value
  }

  /**
   * 焦点是否落在「可编辑」元素上（含主屏之外的输入框：面板里的开关不算，但
   * input/textarea/select/contenteditable 算）。命中即让键，绝不抢别人正在打的字。
   */
  function isEditableFocused(): boolean {
    const el = document.activeElement as HTMLElement | null
    if (!el) return false
    const tag = el.tagName
    return (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      el.isContentEditable === true
    )
  }

  /**
   * 全局 keydown 接管（返回 true = 本层已消费，调用方不要再处理该键）。
   *
   * 调用时机：ShellHost 的 window keydown 里、覆层与快捷键分支之后、仅主屏。
   */
  function handleSearchKeydown(e: KeyboardEvent): boolean {
    if (!options.active()) return false
    // 焦点在输入框内：插入 / 退格 / 合成 / 光标移动全归浏览器
    if (isInputFocused()) return false
    // 焦点在别的可编辑元素上（弹窗输入等）：让键，不抢正在输入的内容
    if (isEditableFocused()) return false
    // 带修饰键不是文本输入（Ctrl+A 全选 / Ctrl+V 粘贴等由浏览器处理）
    if (e.ctrlKey || e.metaKey || e.altKey) return false

    // IME 合成中：把焦点交回输入框承接拼音串，绝不把 e.key 当字符追加
    if (e.isComposing || e.keyCode === 229) {
      focusSearchInput()
      return true
    }

    // 追加/退格后**同步**把焦点与光标交回输入框：focusSearchInput 会先把元素值对齐到
    // 查询串再定位光标，不依赖 Vue 的异步 patch（等微任务时用户已经开始下一个键了）。
    if (e.key === 'Backspace') {
      e.preventDefault()
      query.value = query.value.slice(0, -1)
      focusSearchInput()
      return true
    }

    // 可打印字符（单码点；空格也算，主屏搜索允许空格）
    if (e.key.length === 1) {
      e.preventDefault()
      query.value += e.key
      focusSearchInput()
      return true
    }

    return false
  }

  return {
    onSearchInput,
    clearSearch,
    handleSearchKeydown,
    isInputFocused,
  }
}
