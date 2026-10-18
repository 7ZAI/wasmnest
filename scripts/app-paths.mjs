/**
 * 应用仓（wasmnest-apps）源码路径 resolver —— 三仓拆分 spec §5-E7
 *
 * 平台仓的 dev / 构建脚本与部分测试需要读取各 wasm app 源码（构建、watch、产物校验），
 * 而 app 源码自三仓拆分起住独立的应用仓（`${WASMNESTX}/wasmnest-apps`，spec §0.1 R1）。
 * 本模块是平台仓内**唯一**的应用源码路径解析点，禁止在调用方散落硬编码。
 *
 * 解析规则：
 *  1. `WASMNEST_APPS_ROOT` 显式指定应用仓根（CI / 非常规布局里 export）；
 *  2. 未设时按 R1 钉死的同场布局推导：平台仓根（本文件上一级）的兄弟目录 `wasmnest-apps`；
 *  3. 目录缺失时**显性抛错**（fail-visible）——静默跳过会让构建/watch/锁空转，
 *     是拆仓后最危险的失效形态。
 *
 * 应用仓目录布局：`<appsRoot>/apps/<slug>/{desktop,mobile}`。
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 平台仓根：本文件在 `<platform>/scripts/` 下 */
export const PLATFORM_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 未设 `WASMNEST_APPS_ROOT` 时的默认应用仓根（L1 同场布局：平台仓的兄弟目录） */
export const DEFAULT_APPS_ROOT = resolve(PLATFORM_ROOT, '..', 'wasmnest-apps')

/**
 * 应用仓根（绝对路径）。
 *
 * @returns {string} 应用仓根
 * @throws 目录不存在时抛错（含两种修复方式），不返回可能无效的路径
 */
export function appsRoot() {
  const override = process.env.WASMNEST_APPS_ROOT
  if (override) {
    if (!existsSync(override)) {
      throw new Error(
        `[app-paths] WASMNEST_APPS_ROOT 指向的目录不存在: ${override}（当前工作区未按 R1 布局装配？）`,
      )
    }
    return resolve(override)
  }
  if (!existsSync(DEFAULT_APPS_ROOT)) {
    throw new Error(
      `[app-paths] 应用仓缺失: ${DEFAULT_APPS_ROOT}。` +
        `请按 R1 布局把 wasmnest-apps 放到平台仓的兄弟目录，或设置 WASMNEST_APPS_ROOT 指向它。`,
    )
  }
  return DEFAULT_APPS_ROOT
}

/**
 * 单个应用工程目录（`<appsRoot>/apps/<slug>/<end>`）。
 *
 * @param {string} slug 应用 slug（目录名：bedcode / ai-chatbox / file-transfer / agent-hub）
 * @param {'desktop'|'mobile'} end 端
 * @returns {string} 应用工程目录绝对路径
 */
export function appDir(slug, end) {
  const dir = join(appsRoot(), 'apps', slug, end)
  if (!existsSync(dir)) {
    throw new Error(`[app-paths] 应用目录不存在: ${dir}（检查 slug/end 拼写与 apps 仓内容）`)
  }
  return dir
}

/**
 * 应用工程目录是否存在（不抛错）。
 *
 * 用于「缺失即跳过」的容错分支（如 dev-run 的插件 watch 跳过、target 残留扫描）；
 * 主流程仍应用 [`appDir`]，让缺应用仓成为显性失败。
 *
 * @param {string} slug 应用 slug
 * @param {'desktop'|'mobile'} end 端
 * @returns {boolean}
 */
export function hasAppDir(slug, end) {
  try {
    return existsSync(join(appsRoot(), 'apps', slug, end))
  } catch {
    return false
  }
}
