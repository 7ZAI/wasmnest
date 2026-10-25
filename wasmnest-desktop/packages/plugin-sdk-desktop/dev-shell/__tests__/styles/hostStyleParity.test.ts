/**
 * dev-shell 样式与桌面宿主真源漂移锁
 *
 * dev-shell/src/styles/style.css 是宿主壳样式（src/style.css）的发布副本：
 * dev-shell 随 npm 包分发，不能反向 import 宿主 src（发布物内路径不存在），
 * 故保留副本。本锁钉死两者字节一致——宿主样式变更时必须同步副本，否则红。
 * （Seam 3：改副本不同步 / 改真源不同步都会在这里爆。）
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HOST_STYLE = fileURLToPath(new URL('../../../../../src/style.css', import.meta.url))
const DEV_SHELL_STYLE = fileURLToPath(new URL('../../src/styles/style.css', import.meta.url))

describe('设计 token 与宿主一致', () => {
  it('should_matchHostSource_when_ShellCssCompared（dev-shell style.css 副本随宿主真源同步）', () => {
    const host = readFileSync(HOST_STYLE, 'utf-8')
    const devShell = readFileSync(DEV_SHELL_STYLE, 'utf-8')

    expect(devShell).toBe(host)
  })
})
