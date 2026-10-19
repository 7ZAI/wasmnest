/**
 * 应用图标 URL 解析（壳机制面）
 *
 * 图标是**应用包自带的资源**（manifest `icon` 字段，例如 `icon.svg`，由构建脚本随
 * 整包复制到 `plugins/desktop/<appId>/` 下），不属于宿主资产——宿主不 import 任何
 * wasm-app 源码（hostAppBoundaryLock 钉住），因此只能经 asset 协议按路径加载：
 * `<plugin_get_asset_dir>/<appId>/<icon 文件>`。
 *
 * 判据与 AppMountSlot 的整包装载同源：目录唯一真源 = 宿主命令
 * `plugin_get_asset_dir`（含 dev 回退，前端不拼 `resources/plugins/desktop`）。
 *
 * 失败口径：目录取不到 / 平台不支持（浏览器预览无 asset 协议）→ 返回 undefined，
 * 调用方回退壳内通用图标（ShellAppTile 的 tone + glyph），不显性报错——图标缺失是
 * 装饰性降级，不该拦住任何操作。
 */
import { convertFileSrc } from '@tauri-apps/api/core'
import { invoke } from '@/utils/invoke'
import { logger } from '@/utils/frontendLogger'

/** manifest 未声明 icon 时的约定文件名（构建脚本固定复制 icon.svg） */
const DEFAULT_ICON_FILE = 'icon.svg'

/** appId+文件 → asset URL（同进程内不会变，避免每个图块重复解析） */
const urlCache = new Map<string, string>()

/**
 * 整包根目录（一次取用后缓存）。
 *
 * **失败不缓存**：首次解析可能早于产物就绪（构建中 / 刚清理），重试必须能重新问
 * 宿主，否则一次失败会被钉成「本进程永远没有图标」。
 */
let dirPromise: Promise<string | null> | null = null

function assetDir(): Promise<string | null> {
  if (!dirPromise) {
    dirPromise = invoke<string>('plugin_get_asset_dir')
      .then((dir) => dir)
      .catch((e) => {
        dirPromise = null
        logger.warn('[Shell] app asset dir unavailable, falling back to shell glyphs', e)
        return null
      })
  }
  return dirPromise
}

/**
 * 应用图标 URL（appId 维度缓存）；解析不出来 → undefined。
 *
 * 路径用字符串拼接而不是 `@tauri-apps/api/path` 的 join：join 每次都要过一次 IPC，
 * 而这里只是把宿主给出的目录与 `<appId>/<file>` 接起来；Windows 反斜杠先归一到 `/`
 * （Win32 与 asset 协议都接受正斜杠），避免转义差异导致 404。
 */
export async function appIconUrl(
  appId: string,
  iconFile?: string,
): Promise<string | undefined> {
  if (!appId) return undefined
  const file = iconFile && iconFile.trim() !== '' ? iconFile.trim() : DEFAULT_ICON_FILE
  const key = `${appId}\u0000${file}`
  const hit = urlCache.get(key)
  if (hit) return hit

  const dir = await assetDir()
  if (!dir) return undefined
  try {
    const base = dir.replace(/\\/g, '/').replace(/\/+$/, '')
    const url = convertFileSrc(`${base}/${appId}/${file}`)
    urlCache.set(key, url)
    return url
  } catch (e) {
    // 浏览器预览等无 asset 协议的环境：按降级处理（不缓存，Tauri 环境里还有机会）
    logger.warn(`[Shell] app icon url failed: appId=${appId} file=${file}`, e)
    return undefined
  }
}

/** 清空缓存（测试隔离；目录变更时也可用） */
export function clearAppIconCache(): void {
  urlCache.clear()
  dirPromise = null
}
