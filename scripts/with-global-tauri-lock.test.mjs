#!/usr/bin/env node
/**
 * withGlobalTauri 配置锁（issue #22 / #16 / ADR 0058，2026-10-24）
 * -----------------------------------------------------------------------------
 * 钉住双端 `src-tauri/tauri.conf.json` 的 `app.withGlobalTauri === false`。
 *
 * 背景：平台仓产品侧曾依赖 `window.__TAURI__` 注入全局（双端 usePlatform 探测、
 * bench e2e Channel 取用）。#22 已解除全部产品代码级裸读（探测改经 plugin-os
 * 插件调用，Channel 改从打包类源重建），双端 conf 置 false——全局 API bundle 不再
 * 注入 webview。该全局把完整 Tauri API 暴露给宿主 webview 里的任意 wasm 应用前端，
 * 属纯暴露面，禁止回开。
 *
 * 为什么不能用行为测试表达（docs/testing.md §4 新锁门槛 1）：纯配置项没有行为面——
 * 它的全部效果恰是「某全局永不注入」这个**否定事实**，前端行为测试要么 mock 掉
 * 运行时、要么只能断言全局**在场**时的行为，断言不了缺席；conf 又是 Rust 侧构建
 * 输入（跨构建单元，无编译期约束，改 conf 不经任何编译检查）。唯一防回归手段 =
 * 对配置文件做文本断言。
 *
 * Seam 3：本锁上线时已跑红一次（desktop conf 临时置 true → 本锁红并点名该端 →
 * 复原 false → 绿），红线记录见 issue #22 交付说明。
 *
 * 已知例外：wdio 手动 harness（@wdio/tauri-plugin 1.4.0 的 webview execute 以
 * `window.__TAURI__` 在场为硬前置）——它是仓外依赖的测试基础设施、不进 CI 门禁，
 * 不构成回开 conf 的理由；其处置（注桩 / 插件升级）走独立事项。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 双端 conf 相对平台仓根的路径（新增宿主端时在此同批登记） */
const CONFS = [
  'wasmnest-desktop/src-tauri/tauri.conf.json',
  'wasmnest-mobile/src-tauri/tauri.conf.json',
]

test('should_keepWithGlobalTauriFalse_when_bothEndsConfigured', () => {
  for (const rel of CONFS) {
    const raw = readFileSync(join(ROOT, rel), 'utf8')
    // 先钉键在场再钉值：键被改名 / 挪位时这里给出可定位的失败，而不是 undefined === false 的间接红
    assert.match(raw, /"withGlobalTauri"/, `${rel} 缺少 withGlobalTauri 配置项`)
    const conf = JSON.parse(raw)
    assert.equal(
      conf?.app?.withGlobalTauri,
      false,
      `${rel} 的 app.withGlobalTauri 必须为 false：` +
        '产品侧已无 window.__TAURI__ 裸读依赖（issue #22），回开等于把完整 Tauri API ' +
        'bundle 重新注入宿主 webview（任意 wasm 应用前端可直取）。确需回开先过宿主薄壳' +
        '三问（docs/architecture.md §1.4）并停下问用户，同步更新本锁与 docs/codemap.md §8.1',
    )
  }
})
