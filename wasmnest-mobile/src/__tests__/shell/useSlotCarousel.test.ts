/**
 * 首页快捷卡片轮播
 *
 * 钉住行为：多张自动步进并回卷、单张不动、用户触摸临时停表后恢复、
 * 减少动效时不自动播放、卸载即停表。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, defineComponent, h, ref } from 'vue'
import {
  SLOT_AUTOPLAY_INTERVAL_MS,
  SLOT_AUTOPLAY_RESUME_MS,
  useSlotCarousel,
} from '@/shell/composables/useSlotCarousel'

const Harness = defineComponent({
  props: {
    count: { type: Number, required: true },
  },
  setup(props, { expose }) {
    const track = ref<HTMLElement | null>(null)
    const carousel = useSlotCarousel(track, computed(() => props.count))
    expose({ carousel, track })
    return () =>
      h(
        'div',
        { ref: track, class: 'track' },
        Array.from({ length: props.count }, (_, index) =>
          h('div', { class: 'item', key: index }, String(index)),
        ),
      )
  },
})

function mountHarness(count: number): {
  wrapper: ReturnType<typeof mount>
  track: HTMLElement
  scrollTo: ReturnType<typeof vi.fn>
  carousel: ReturnType<typeof useSlotCarousel>
} {
  const wrapper = mount(Harness, { props: { count } })
  const track = wrapper.find('.track').element as HTMLElement
  const scrollTo = vi.fn()
  track.scrollTo = scrollTo as unknown as HTMLElement['scrollTo']
  const carousel = (wrapper.vm as unknown as { carousel: ReturnType<typeof useSlotCarousel> })
    .carousel
  return { wrapper, track, scrollTo, carousel }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('快捷卡片轮播', () => {
  it('should_advanceAndWrap_when_multipleCards', () => {
    const { wrapper, scrollTo, carousel } = mountHarness(3)

    expect(carousel.activeIndex.value).toBe(0)

    vi.advanceTimersByTime(SLOT_AUTOPLAY_INTERVAL_MS)
    expect(carousel.activeIndex.value).toBe(1)
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo.mock.calls[0][0]).toMatchObject({ behavior: 'smooth' })

    vi.advanceTimersByTime(SLOT_AUTOPLAY_INTERVAL_MS * 2)
    expect(carousel.activeIndex.value).toBe(0)
    expect(scrollTo).toHaveBeenCalledTimes(3)

    wrapper.unmount()
  })

  it('should_stayStill_when_singleCard', () => {
    const { wrapper, scrollTo } = mountHarness(1)

    vi.advanceTimersByTime(SLOT_AUTOPLAY_INTERVAL_MS * 3)

    expect(scrollTo).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('should_pauseThenResume_when_userTouchesTrack', () => {
    const { wrapper, track, carousel } = mountHarness(2)

    track.dispatchEvent(new Event('pointerdown'))
    vi.advanceTimersByTime(SLOT_AUTOPLAY_INTERVAL_MS)
    expect(carousel.activeIndex.value, '触摸期间不得自动前进').toBe(0)

    // 停手等待结束（恢复计时；首页一张拍一屏，下一拍即步进）
    vi.advanceTimersByTime(SLOT_AUTOPLAY_RESUME_MS)
    expect(carousel.activeIndex.value, '停手后恢复轮播').toBe(1)

    wrapper.unmount()
  })

  it('should_stopEntirely_when_reducedMotion', () => {
    vi.stubGlobal(
      'matchMedia',
      (query: string) =>
        ({
          matches: query === '(prefers-reduced-motion: reduce)',
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        }) as MediaQueryList,
    )

    const { wrapper, scrollTo, carousel } = mountHarness(3)

    expect(carousel.reducedMotion.value).toBe(true)
    expect(carousel.playing.value, '减少动效默认不播放').toBe(false)

    carousel.toggle()
    expect(carousel.playing.value, '减少动效下不提供播放').toBe(false)

    vi.advanceTimersByTime(SLOT_AUTOPLAY_INTERVAL_MS * 2)
    expect(scrollTo).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('should_stopTimer_when_unmounted', () => {
    const { wrapper, scrollTo } = mountHarness(2)

    wrapper.unmount()
    vi.advanceTimersByTime(SLOT_AUTOPLAY_INTERVAL_MS * 2)

    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('should_togglePlaying_when_userControlsCarousel', () => {
    const { wrapper, scrollTo, carousel } = mountHarness(2)

    expect(carousel.playing.value).toBe(true)
    carousel.toggle()
    expect(carousel.playing.value).toBe(false)

    vi.advanceTimersByTime(SLOT_AUTOPLAY_INTERVAL_MS * 2)
    expect(scrollTo, '暂停后不再自动前进').not.toHaveBeenCalled()

    carousel.toggle()
    vi.advanceTimersByTime(SLOT_AUTOPLAY_INTERVAL_MS)
    expect(scrollTo, '恢复后继续轮播').toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })
})