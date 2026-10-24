/**
 * 运行面独立 Vue 应用的共享面契约锁（工单 #33，spec §4.8 / §7.2）
 *
 * 用**真实**共享运行时（@/locales 的 i18n 实例 + @/router 的 router）装进
 * 运行面独立 Vue 应用——锁的是「共享」语义本身：换承载方式不得改变应用
 * 拿到的运行时与错误边界。轻桩版本（适配器行为面）见 shellAppSurface.test.ts。
 *
 * | 契约 | 来源 | 规则 | 预期 |
 * |---|---|---|---|
 * | C-SR1 | T17 | 运行面内 useI18n() 可用 | 渲染宿主文案；共享 locale 切换后文本跟随更新 |
 * | C-SR2 | T18 | 运行面内 useRouter() | 解析到宿主同一 router 实例，既有路由可 resolve |
 * | C-SR3 | T16/§4.8 | Vue 渲染错误不映射业务终态 | 错误被该应用 errorHandler 吞掉，实例不被销毁（不停后端） |
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import i18n from '@/locales'
import router from '@/router'
import { getSurfaceAppRegistry, makeSurfaceEnsureInput } from '@/shell/surfaceRuntime'

const registry = getSurfaceAppRegistry()

beforeEach(async () => {
  for (const id of registry.list()) await registry.dispose(id)
})

afterEach(async () => {
  // locale 是全局共享状态：测试用例不得把语言留在别的档位
  i18n.global.locale.value = 'zh-CN'
  for (const id of registry.list()) await registry.dispose(id)
})

describe('C-SR1 共享 i18n（T17）', () => {
  it('should_resolveSharedI18n_and_followLocaleSwitch_when_surfaceMounted', async () => {
    const I18nSurface = defineComponent({
      name: 'I18nSurface',
      setup() {
        const { t } = useI18n()
        return () => h('p', { class: 'i18n-text' }, t('shell.run.notFound'))
      },
    })

    const record = await registry.ensure('com.test.i18n', makeSurfaceEnsureInput(I18nSurface))

    expect(
      record.container.querySelector('.i18n-text')?.textContent,
      '运行面内 useI18n 可用（宿主同一份实例）',
    ).toContain('应用不存在或已卸载')

    // 共享 locale 切换对已打开运行面生效（同一实例，响应式传播）
    i18n.global.locale.value = 'en'
    await nextTick()
    await nextTick()
    expect(record.container.querySelector('.i18n-text')?.textContent).toContain('App not found')
  })
})

describe('C-SR2 共享 router（T18）', () => {
  it('should_resolveHostRouter_when_useRouterCalledInSurface', async () => {
    let resolved: unknown = null
    const RouterSurface = defineComponent({
      name: 'RouterSurface',
      setup() {
        resolved = useRouter()
        return () => h('p', { class: 'router-ok' }, 'router-ok')
      },
    })

    const record = await registry.ensure('com.test.router', makeSurfaceEnsureInput(RouterSurface))

    expect(record.container.querySelector('.router-ok'), '运行面正常渲染').not.toBeNull()
    // 解析到的是宿主**同一份** router 实例（共享，不是每应用新 router）
    expect(resolved).toBe(router)
    // 既有路由可达（导航能力：同一实例 + 路由表即宿主路由表）
    expect(router.resolve('/mobile/shell').name).toBe('mobile-shell')
  })
})

describe('C-SR3 Vue 错误不映射业务终态（T16 / spec §4.8）', () => {
  it('should_keepInstanceAlive_when_renderErrorSwallowedByErrorHandler', async () => {
    const boom = ref(false)
    const ErrSurface = defineComponent({
      name: 'ErrSurface',
      setup() {
        return () => {
          if (boom.value) throw new Error('render-boom')
          return h('p', { class: 'err-ok' }, 'fine')
        }
      },
    })

    await registry.ensure('com.test.err', makeSurfaceEnsureInput(ErrSurface))
    expect(registry.has('com.test.err')).toBe(true)

    // 渲染错误进该应用自己的 errorHandler（注册表落日志带 appId），不冒泡、
    // 更不自动销毁实例 / 停用后端——UI 错误是 UI 事实，业务终态由应用 / 后端决定
    boom.value = true
    await nextTick()
    await nextTick()

    expect(registry.has('com.test.err'), '实例不因 Vue 渲染错误被销毁').toBe(true)
  })
})
