#!/usr/bin/env node
/**
 * 移动端插件产物预检（dev 启动前「删旧产物 → 全量重建」，2026-11-11 用户裁决）
 *
 * 单一路径保证「宿主起来前，随包插件的产物一定是当前 wasmnest-apps 源码构建的」，
 * 与桌面端 `wasmnest-desktop/scripts/plugin-precheck.mjs` 同构：
 *   - `pnpm run tauri:android:dev`（scripts/dev-run.js）：spawn 宿主前先跑本脚本；
 *   - 裸 `tauri dev` / `tauri android dev`：`tauri.conf.json` 的 `beforeDevCommand`
 *     串入本脚本（宿主构建前完成）。
 *
 * 默认 fresh：先删 `src-tauri/resources/plugins/mobile/*` 与 gen/android 生成资源里的
 * 插件目录（含同 id 下的陈旧文件），再跑 `plugin-build.js --fresh` 全量构建。
 * 编译缓存（`target/`、`.build/`）不动，所以是「产物全新、依赖不重编」。
 *
 * 跳过条件（避免一次 dev 会话连做两遍全量构建）：
 *   - env `WASMNEST_PLUGIN_PRECHECK_DONE=1`：dev-run 已完成本轮重建；
 *   - env `WASMNEST_PLUGIN_PRECHECK_REUSE=1`：显式复用现有产物（dev-run --reuse）。
 * 两条都只打印说明后返回，不做任何构建。
 */

import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_BUILD = resolve(__dirname, 'plugin-build.js')

/** 与桌面端 plugin-precheck.mjs 同名同义（跨进程标记，dev-run 写进宿主子进程 env） */
const PRECHECK_DONE_ENV = 'WASMNEST_PLUGIN_PRECHECK_DONE'
const PRECHECK_REUSE_ENV = 'WASMNEST_PLUGIN_PRECHECK_REUSE'

if (process.env[PRECHECK_DONE_ENV] === '1') {
  console.log('[plugin-precheck] dev-run 已完成插件产物重建，这里跳过重复全量构建')
} else if (process.env[PRECHECK_REUSE_ENV] === '1') {
  console.log(
    '[plugin-precheck] WASMNEST_PLUGIN_PRECHECK_REUSE=1：复用现有插件产物（缺产物/WASM 陈旧请去掉该开关）',
  )
} else {
  console.log('[plugin-precheck] 移动端插件产物：删旧产物 → 全量重建（plugin-build --fresh）')
  const res = spawnSync(process.execPath, [PLUGIN_BUILD, '--fresh'], { stdio: 'inherit' })
  if (res.status !== 0) {
    console.error('[plugin-precheck] ✗ 插件全量重建失败。请手动执行后重试：')
    console.error('[plugin-precheck]   cd wasmnest-mobile && node scripts/plugin-build.js --fresh')
    process.exit(res.status ?? 1)
  }
  console.log('[plugin-precheck] 插件产物已删旧重建（全部为当前源码构建产物）')
}
