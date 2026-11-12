import { browser, expect } from '@wdio/globals'

/**
 * E2E smoke：桌面宿主壳恢复后的启动冒烟（2026-10-17 用户裁决：方案 C 壳 =
 * 新宿主 UI，侧边栏工作台形态沉入 wasm-app 作为应用界面）
 * ---------------------------------------------------------------------------
 * 断言链（对应 user stories 1/2/3/18/19）：
 *   1. boot：应用能启动并响应 IPC，默认落地**壳主屏**（应用卡 + 系统卡网格）；
 *   2. 进入应用面后侧边栏静态项渲染：四项（设备配对 / 终端会话 / Agent任务 / 设置），
 *      路由直写侧边栏（D3 静态菜单表），无贡献面注册；
 *   3. 逐路由导航：/pairing → /sessions → /tasks → /settings 各自渲染对应页面
 *      （菜单项点击 = 真实用户路径）；
 *   4. 深链：/terminal-window/:id 直渲终端窗口视图（bareWindow，不套侧边栏外壳），
 *      /server 诊断页 URL 直达；
 *   5. 退役面 fail-visible：直接访问 /plugins（应用中心）落 not-found 兜底，
 *      不白屏、不静默回落。
 *
 * 判据只断言外部行为（DOM 出现/不出现），不断言实现细节。运行前置：
 *   - debug 二进制 `src-tauri/target/debug/wasmnest-desktop`（含 tauri-plugin-wdio）；
 *   - 已构建前端产物（`pnpm run build`，frontendDist=../dist 嵌入二进制）；
 *   - 独占实例（端口 8767 与应用数据目录空闲）。
 *
 * 跑法：pnpm exec wdio run wdio.conf.ts --spec e2e/specs/smoke.spec.ts
 */

/** 侧边栏静态菜单表（D3 单一事实源的 E2E 镜像：路径 + 中文显示名） */
const STATIC_MENU: Array<[path: string, label: string]> = [
  ['/pairing', '设备配对'],
  ['/sessions', '终端会话'],
  ['/tasks', 'Agent任务'],
  ['/settings', '设置'],
]

/** 每个页面一个可区分的 DOM 文本锚（取页面自身 i18n 标题，语言默认 zh-CN） */
const PAGE_ANCHORS: Record<string, string> = {
  '/pairing': '设备配对',
  '/sessions': '终端会话',
  '/tasks': 'Agent任务',
  '/settings': '设置',
  '/server': '服务器管理',
  '/plugins': '页面不存在',
}

describe('WasmNest Desktop smoke（壳恢复后：主屏 + 应用面分流）', () => {
  it('应用能启动并响应 execute（boot，落地壳主屏）', async () => {
    await browser.pause(3000)

    const href = await browser.tauri.execute(() => window.location.href)
    expect(typeof href).toBe('string')
    expect(href.length).toBeGreaterThan(0)

    const result = await browser.tauri.execute(({ core }) => core.invoke('ping'))
    expect(result).toBeDefined()
    expect(typeof result).toBe('string')

    // 默认落地 = 壳主屏（方案 C：主屏网格含应用卡与系统卡，无侧边栏）
    const bodyText = await browser.tauri.execute(() => document.body.innerText)
    expect((bodyText as string).includes('BedCode')).toBe(true)
    expect((bodyText as string).includes('应用')).toBe(true)
    expect((bodyText as string).includes('系统')).toBe(true)
  })

  it('壳主屏点应用卡 → 应用界面侧边栏渲染四项静态菜单（路由直写，无贡献注册）', async () => {
    // 进入应用面（侧边栏工作台形态；主屏本身无侧边栏）
    await browser.tauri.execute(
      new Function(
        `return async function () { history.pushState(null, '', '/sessions'); window.dispatchEvent(new PopStateEvent('popstate')) }`,
      )() as unknown as () => Promise<void>,
    )
    await browser.pause(1500)

    const links = await browser.tauri.execute(() =>
      Array.from(document.querySelectorAll('nav a')).map((a) => a.getAttribute('href')),
    )
    // 四项菜单 + 底部服务状态/折叠按钮不带 href，故过滤出非空 href
    const navHrefs = (links as (string | null)[]).filter((h) => h && h.startsWith('/'))
    const expected = STATIC_MENU.map(([path]) => path)
    for (const p of expected) {
      expect(navHrefs).toContain(p)
    }
    expect(navHrefs.length).toBe(expected.length)
  })

  for (const [path, anchor] of Object.entries(PAGE_ANCHORS)) {
    if (path === '/plugins') continue // 退役面走最后一条用例
    it(`路由 ${path} 渲染对应页面（锚文本「${anchor}」）`, async () => {
      await browser.tauri.execute(
        new Function(
          `return async function () { history.pushState(null, '', ${JSON.stringify(path)}); window.dispatchEvent(new PopStateEvent('popstate')) }`,
        )() as unknown as () => Promise<void>,
      )
      // 路由切换有页面过渡动画，留足等待
      await browser.pause(1500)

      const bodyText = await browser.tauri.execute(() => document.body.innerText)
      expect((bodyText as string).includes(anchor)).toBe(true)
    })
  }

  it('终端窗口深链 /terminal-window/:id 直渲（bareWindow，无侧边栏外壳）', async () => {
    await browser.tauri.execute(
      new Function(
        `return async function () { history.pushState(null, '', '/terminal-window/test-session'); window.dispatchEvent(new PopStateEvent('popstate')) }`,
      )() as unknown as () => Promise<void>,
    )
    await browser.pause(1500)

    const hasNav = await browser.tauri.execute(() => Boolean(document.querySelector('nav')))
    expect(hasNav).toBe(false) // bareWindow 不套侧边栏
  })

  it('退役面 /plugins 落 not-found 兜底（fail-visible，不白屏）', async () => {
    await browser.tauri.execute(
      new Function(
        `return async function () { history.pushState(null, '', '/plugins'); window.dispatchEvent(new PopStateEvent('popstate')) }`,
      )() as unknown as () => Promise<void>,
    )
    await browser.pause(1500)

    const bodyText = await browser.tauri.execute(() => document.body.innerText)
    expect((bodyText as string).includes('页面不存在')).toBe(true)
  })

  it('生命周期链：壳主屏点应用卡 → 应用界面 → 关闭卡 → 回主屏且应用停用（2026-10-17 lifecycle-sync）', async () => {
    // 1. 回壳主屏
    await browser.tauri.execute(
      new Function(
        `return async function () { history.pushState(null, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')) }`,
      )() as unknown as () => Promise<void>,
    )
    await browser.pause(1200)

    // 2. 点 BedCode 应用卡（主屏应用网格，aria-label 含应用名 + 状态）→ 打开 = 真实激活 + 进入应用界面
    const clicked = await browser.tauri.execute(() => {
      const tile = Array.from(document.querySelectorAll('.appicon')).find((el) =>
        (el.getAttribute('aria-label') ?? '').includes('BedCode'),
      ) as HTMLElement | undefined
      if (!tile) return false
      tile.click()
      return true
    })
    expect(clicked).toBe(true)
    await browser.pause(1500)

    // 3. 应用界面侧边栏渲染（四项静态菜单）
    const links = await browser.tauri.execute(() =>
      Array.from(document.querySelectorAll('nav a')).map((a) => a.getAttribute('href')),
    )
    const navHrefs = (links as (string | null)[]).filter((h) => h && h.startsWith('/'))
    for (const [path] of STATIC_MENU) {
      expect(navHrefs).toContain(path)
    }

    // 4. 回主屏（运行卡片带含应用卡）→ 点卡上关闭（hcard-x）= **真停用**
    await browser.tauri.execute(
      new Function(
        `return async function () { history.pushState(null, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')) }`,
      )() as unknown as () => Promise<void>,
    )
    await browser.pause(1200)
    const closed = await browser.tauri.execute(() => {
      const x = document.querySelector('.hcard .hcard-x') as HTMLElement | undefined
      if (!x) return false
      x.click()
      return true
    })
    expect(closed).toBe(true)
    await browser.pause(1500)

    // 5. 卡片已摘除（无运行卡）+ 主屏网格状态 = 未启动（停用态可见）
    const hasCard = await browser.tauri.execute(() => Boolean(document.querySelector('.hcard')))
    expect(hasCard).toBe(false)
    const bodyText = await browser.tauri.execute(() => document.body.innerText)
    expect((bodyText as string).includes('未启动')).toBe(true)
  })
})
