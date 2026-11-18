/**
 * 首页快捷卡片轮播
 * -----------------------------------------------------------------------------
 * 轨道本身是原生 scroll-snap（一张一拍屏），本组合式只负责「自动往前走」：
 * - 间隔 5s 推进一张，到末尾回到第一张；
 * - 用户触摸 / 滚轮 / 键盘聚焦时停表，停手 8s 后恢复（不改变用户显式暂停）；
 * - 系统「减少动效」开启时默认不自动播放，且不渲染暂停 / 播放控件
 *   （否则就是一个点了没反应的按钮）；
 * - 页面不可见（切后台 / 打开其它应用）时停表。
 *
 * 动效判据：ui-ux-pro-max `--domain ux / Auto-Rotating Content Controls`——
 * 自动轮播必须给用户暂停控制，并在 reduced motion 下停走；滚动定位在
 * reduced motion 下降级为瞬时跳转。
 */
import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

/** 自动轮播步进间隔 */
export const SLOT_AUTOPLAY_INTERVAL_MS = 5000
/** 用户操作后恢复自动轮播的空闲等待 */
export const SLOT_AUTOPLAY_RESUME_MS = 8000

/** 系统是否要求减少动效（真机 / dev-shell 统一口径；取不到按不需要处理） */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** 首页快捷卡片轮播句柄 */
export interface SlotCarousel {
  /** 当前定格卡序号（0 起；用户滑动时随滚动同步） */
  activeIndex: Ref<number>
  /** 用户是否开启自动轮播（暂停按钮状态；临时触摸暂停不改变它） */
  playing: Ref<boolean>
  /** 系统要求减少动效时为 true，此时不自动播放也不提供播放控件 */
  reducedMotion: Ref<boolean>
  /** 暂停 / 恢复自动轮播 */
  toggle(): void
}

/**
 * @param track 横向轨道元素（子元素 = 卡片 item，顺序与卡片一致）
 * @param count 当前卡片数（清单异步到达时自动起表 / 停表）
 */
export function useSlotCarousel(
  track: Ref<HTMLElement | null>,
  count: Ref<number>,
): SlotCarousel {
  const activeIndex = ref(0)
  const reducedMotion = ref(prefersReducedMotion())
  const playing = ref(!reducedMotion.value)
  /** 触摸 / 聚焦期间的临时停表（不写回 playing） */
  let holding = false

  let timer: ReturnType<typeof setInterval> | null = null
  let resumeTimer: ReturnType<typeof setTimeout> | null = null
  let scrollFrame = 0
  let media: MediaQueryList | null = null

  function total(): number {
    return Math.max(0, count.value)
  }

  function stopTimer(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  function canPlay(): boolean {
    return (
      playing.value &&
      !holding &&
      !reducedMotion.value &&
      total() > 1 &&
      !(typeof document !== 'undefined' && document.hidden)
    )
  }

  function startTimer(): void {
    stopTimer()
    if (canPlay()) timer = setInterval(advance, SLOT_AUTOPLAY_INTERVAL_MS)
  }

  function cardElement(index: number): HTMLElement | null {
    const el = track.value
    const child = el?.children[index]
    return child instanceof HTMLElement ? child : null
  }

  function paddingStart(el: HTMLElement): number {
    const value = parseFloat(getComputedStyle(el).paddingInlineStart)
    return Number.isFinite(value) ? value : 0
  }

  /** 定位到某张卡：对齐 scroll-snap 的 start 锚点（扣除轨道起始内边距） */
  function goTo(index: number): void {
    const limit = total()
    if (limit === 0) return
    const next = Math.min(Math.max(index, 0), limit - 1)
    activeIndex.value = next

    const el = track.value
    const item = cardElement(next)
    if (!el || !item) return
    const left = Math.max(
      0,
      item.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft - paddingStart(el),
    )
    const behavior: ScrollBehavior = reducedMotion.value ? 'auto' : 'smooth'
    if (typeof el.scrollTo === 'function') el.scrollTo({ left, behavior })
    else el.scrollLeft = left
  }

  function advance(): void {
    const limit = total()
    if (limit <= 1) return
    goTo((activeIndex.value + 1) % limit)
  }

  /** 用户滑动后把序号对齐到最近一张（自动轮播从可见卡继续） */
  function syncActiveIndex(): void {
    const el = track.value
    if (!el || el.children.length === 0) return
    const base = el.getBoundingClientRect().left + paddingStart(el)
    let nearest = 0
    let best = Number.POSITIVE_INFINITY
    for (let i = 0; i < el.children.length; i += 1) {
      const child = el.children[i]
      if (!(child instanceof HTMLElement)) continue
      const distance = Math.abs(child.getBoundingClientRect().left - base)
      if (distance < best) {
        best = distance
        nearest = i
      }
    }
    if (nearest !== activeIndex.value) activeIndex.value = nearest
  }

  function onScroll(): void {
    if (scrollFrame) return
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0
      syncActiveIndex()
    })
  }

  /** 用户开始操作：临时停表，停手一段时间后自动恢复 */
  function holdTemporarily(): void {
    holding = true
    stopTimer()
    if (resumeTimer !== null) clearTimeout(resumeTimer)
    resumeTimer = setTimeout(() => {
      resumeTimer = null
      holding = false
      startTimer()
    }, SLOT_AUTOPLAY_RESUME_MS)
  }

  /** 焦点离开轨道：立刻恢复（键盘用户不该等空闲计时） */
  function releaseHold(): void {
    if (resumeTimer !== null) {
      clearTimeout(resumeTimer)
      resumeTimer = null
    }
    holding = false
    startTimer()
  }

  function toggle(): void {
    if (reducedMotion.value) return
    playing.value = !playing.value
    if (playing.value) startTimer()
    else stopTimer()
  }

  function onVisibilityChange(): void {
    if (document.hidden) stopTimer()
    else startTimer()
  }

  function onMotionPreferenceChange(event: MediaQueryListEvent): void {
    reducedMotion.value = event.matches
    if (event.matches) stopTimer()
    else startTimer()
  }

  watch(count, () => {
    const last = Math.max(0, total() - 1)
    if (activeIndex.value > last) activeIndex.value = last
    startTimer()
  })

  onMounted(() => {
    const el = track.value
    el?.addEventListener('pointerdown', holdTemporarily, { passive: true })
    el?.addEventListener('wheel', holdTemporarily, { passive: true })
    el?.addEventListener('focusin', holdTemporarily)
    el?.addEventListener('focusout', releaseHold)
    el?.addEventListener('scroll', onScroll, { passive: true })
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange)
    }
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      media = window.matchMedia('(prefers-reduced-motion: reduce)')
      media.addEventListener?.('change', onMotionPreferenceChange)
    }
    startTimer()
  })

  onBeforeUnmount(() => {
    stopTimer()
    if (resumeTimer !== null) {
      clearTimeout(resumeTimer)
      resumeTimer = null
    }
    if (scrollFrame) {
      cancelAnimationFrame(scrollFrame)
      scrollFrame = 0
    }
    const el = track.value
    el?.removeEventListener('pointerdown', holdTemporarily)
    el?.removeEventListener('wheel', holdTemporarily)
    el?.removeEventListener('focusin', holdTemporarily)
    el?.removeEventListener('focusout', releaseHold)
    el?.removeEventListener('scroll', onScroll)
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
    media?.removeEventListener?.('change', onMotionPreferenceChange)
    media = null
  })

  return { activeIndex, playing, reducedMotion, toggle }
}