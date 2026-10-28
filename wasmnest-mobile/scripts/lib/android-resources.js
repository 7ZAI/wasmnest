/**
 * Android 生成资源目录的插件裁剪
 *
 * Tauri CLI 每轮构建把 `src-tauri/resources/plugins/**` 增量复制到
 * `src-tauri/gen/android/app/src/main/assets/resources/plugins/`，但**不会清理源目录
 * 已删除的条目**。插件改名 / 下架后，旧插件目录仍会随 APK 打包，宿主解压后按两个
 * 不同 id 装载同名应用（实测：`com.wasmnest.terminal-session` 于 2026-10-25 改名
 * `com.wasmnest.bedcode` 后，移动端主屏出现两个 BedCode）。
 *
 * 该目录是纯生成物（gen/ 已 gitignore），以**当前源目录为准**做一次删除式对齐：
 * 只删除源目录中已不存在的插件目录；源目录缺失时不动（Android 工程尚未 init /
 * 插件尚未构建）。
 *
 * 仅删 `src/main/assets` 还不够：AGP 的 assets 合并 / 压缩中间产物同样是增量写入，
 * 删除输入文件不会回收既有输出（实测 merge*Assets、compress*Assets 均保留旧目录）。
 * 中间产物按同一份 active 名单对齐；删掉输出后 Gradle 判定任务过期，按干净输入重建。
 */

import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** Gradle 中间产物中插件目录的相对布局（相对各变体/任务目录） */
const INTERMEDIATE_LAYOUTS = [
  ['assets', 'resources/plugins/mobile'],
  ['compressed_assets', 'out/assets/resources/plugins/mobile'],
]

/** 删除目录；失败不阻断构建（Windows 上可能被 Gradle 占用），仅告警 */
function tryRemoveDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
    return true
  } catch (e) {
    console.warn(`[android-resources] 删除过期插件目录失败（可能被 Gradle 占用）: ${dir} — ${e.message}`)
    return false
  }
}

/** 目录下的插件子目录名（跳过隐藏目录） */
function pluginDirNames(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
}

/** 删除各变体、各任务目录下不在 active 名单中的插件中间产物 */
function pruneGradleIntermediates(mobileRoot, active) {
  const intermediates = join(mobileRoot, 'src-tauri/gen/android/app/build/intermediates')
  if (!existsSync(intermediates)) return []

  const removed = new Set()
  for (const [stage, layout] of INTERMEDIATE_LAYOUTS) {
    const stageDir = join(intermediates, stage)
    if (!existsSync(stageDir)) continue
    for (const variant of readdirSync(stageDir, { withFileTypes: true })) {
      if (!variant.isDirectory()) continue
      const variantDir = join(stageDir, variant.name)
      for (const task of readdirSync(variantDir, { withFileTypes: true })) {
        if (!task.isDirectory()) continue
        const pluginsDir = join(variantDir, task.name, layout)
        if (!existsSync(pluginsDir)) continue
        for (const name of pluginDirNames(pluginsDir)) {
          if (active.has(name)) continue
          if (tryRemoveDir(join(pluginsDir, name))) removed.add(name)
        }
      }
    }
  }
  return [...removed]
}

/**
 * 删除 Android 生成资源中源目录已不存在的插件目录
 *
 * @param {string} mobileRoot wasmnest-mobile 目录绝对路径
 * @returns {string[]} 被删除的插件目录名
 */
export function pruneStaleAndroidPluginAssets(mobileRoot) {
  const sourceDir = join(mobileRoot, 'src-tauri/resources/plugins/mobile')
  const assetDir = join(mobileRoot, 'src-tauri/gen/android/app/src/main/assets/resources/plugins/mobile')
  if (!existsSync(sourceDir) || !existsSync(assetDir)) return []

  const active = new Set(pluginDirNames(sourceDir))
  const removed = new Set()

  for (const name of pluginDirNames(assetDir)) {
    if (active.has(name)) continue
    if (tryRemoveDir(join(assetDir, name))) removed.add(name)
  }
  for (const name of pruneGradleIntermediates(mobileRoot, active)) removed.add(name)

  const list = [...removed]
  if (list.length > 0) {
    console.log(
      `[android-resources] 已清理生成资源中的过期插件（源目录已移除）: ${list.join(', ')}`,
    )
  }
  return list
}
