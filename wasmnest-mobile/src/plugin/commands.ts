/**
 * Mobile Plugin Commands
 *
 * 插件相关 Tauri invoke 命令封装
 */

import { invoke } from '@tauri-apps/api/core'
import type { PluginInfo } from './types'
import { ensureHostCredential, invalidateChannelToken } from './credentials'

/** 获取所有已加载插件信息 */
export async function pluginListLoaded(): Promise<PluginInfo[]> {
  return await invoke('plugin_list_loaded')
}

/** 获取单个插件信息 */
export async function pluginGetInfo(pluginId: string): Promise<PluginInfo | null> {
  return await invoke('plugin_get_info', { pluginId })
}

/**
 * 预授权（启用前置，独立于 activate 供前端先行调用）
 *
 * 时序契约：toggle 启用时先调本命令（此阶段不显示 LoadingDialog，授权弹窗
 * 可正常交互）→ 通过后再显示 loading 并调 pluginActivate；拒绝则直接失败
 *
 * 宿主面凭证已绑定（ADR 0058）
 */
export async function pluginPreauthorize(pluginId: string): Promise<void> {
  const credential = await ensureHostCredential()
  return await invoke('plugin_preauthorize', { pluginId, credential })
}

/** 激活插件（宿主面凭证已绑定，ADR 0058） */
export async function pluginActivate(pluginId: string): Promise<void> {
  const credential = await ensureHostCredential()
  return await invoke('plugin_activate', { pluginId, credential })
}

/** 停用插件（宿主面凭证已绑定，ADR 0058） */
export async function pluginDeactivate(pluginId: string): Promise<void> {
  const credential = await ensureHostCredential()
  try {
    await invoke('plugin_deactivate', { pluginId, credential })
  } finally {
    // 宿主在停用路径上回收该插件的通道令牌（issue #28）：本地缓存必须同步作废，
    // 否则同一页面内「停用再启用」会拿死令牌把首批命令全打成凭证错误。
    // 放 finally：即使停用请求失败（如插件已不存在），旧令牌也不应继续被当作有效。
    invalidateChannelToken(pluginId)
  }
}

/** 查询插件「启动时自动激活」偏好（缺省 false = 不自动启动） */
export async function pluginIsAutostart(pluginId: string): Promise<boolean> {
  return await invoke('plugin_is_autostart', { pluginId })
}

/** 设置插件「启动时自动激活」偏好（只改偏好，下次启动生效；宿主门，ADR 0058） */
export async function pluginSetAutostart(pluginId: string, autostart: boolean): Promise<void> {
  const credential = await ensureHostCredential()
  return await invoke('plugin_set_autostart', { pluginId, autostart, credential })
}

/**
 * 标记插件错误（插件自报面 + 宿主代报面）
 *
 * `credential` 决定调用方身份（issue #28）：插件用自己的通道令牌只能报自己的错，
 * 宿主持 loader 会话可代报任意目标。宿主路径（loader）用 `ensureHostCredential()`，
 * 插件路径用 `ensureChannelToken(自己的 id)`——由调用方决定，本函数不做猜测。
 */
export async function pluginMarkError(pluginId: string, error: string, credential: string): Promise<void> {
  return await invoke('plugin_mark_error', { pluginId, error, credential })
}

/** 插件显式上报启动成功（Error → Activated 自愈；插件自报面，令牌只能是自己） */
export async function pluginReportReady(pluginId: string, credential: string): Promise<void> {
  return await invoke('plugin_report_ready', { pluginId, credential })
}

/** 批准插件权限（人工审批：记录权限清单 + 目录内容哈希钉扎；宿主面凭证已绑定，ADR 0058） */
export async function pluginApprove(pluginId: string): Promise<void> {
  const credential = await ensureHostCredential()
  return await invoke('plugin_approve', { pluginId, credential })
}

// ==================== 插件存储 / 命令派发（身份 = credential，ADR 0058 / issue #28） ====================
//
// 三者都要求显式 `credential`：令牌决定调用方身份，`pluginId` 只作目标。宿主路径传
// `ensureHostCredential()`（可作用于任意目标），插件路径传 `ensureChannelToken(自己)`。
// 宿主侧另有运行态 + `storage` 权限两段校验（未声明 storage 的应用同样被拒）。

/** 获取插件存储值 */
export async function pluginStorageGet(pluginId: string, key: string, credential: string): Promise<any> {
  return await invoke('plugin_storage_get', { pluginId, key, credential })
}

/** 设置插件存储值 */
export async function pluginStorageSet(
  pluginId: string,
  key: string,
  value: any,
  credential: string,
): Promise<void> {
  return await invoke('plugin_storage_set', { pluginId, key, value, credential })
}

/** 删除插件存储值 */
export async function pluginStorageDelete(pluginId: string, key: string, credential: string): Promise<void> {
  return await invoke('plugin_storage_delete', { pluginId, key, credential })
}

/** 插件日志输出 */
export async function pluginLog(pluginId: string, level: string, message: string): Promise<void> {
  return await invoke('plugin_log', { pluginId, level, message })
}

/** 调用 WASM 插件命令（令牌只能驱动自己；宿主凭证可驱动任意目标） */
export async function pluginInvoke(
  pluginId: string,
  command: string,
  args: any,
  credential: string,
): Promise<any> {
  return await invoke('plugin_invoke', { pluginId, command, args, credential })
}

/** 应用更新检查返回（宿主 `plugin_check_app_update`，与 Rust camelCase 对齐） */
export interface AppUpdateCheckInfo {
  pluginId: string
  currentVersion: string
  latestVersion: string
  tag: string
  zipAsset: string
  sha256: string
  bytes: number
  compat: {
    hostRuntime: string
    mountContract: string
    sdkVersion: string
    witVersion: string
  } | null
  compatible: boolean
  compatReason?: { key: string; params?: Record<string, string> }
}

/** 检查应用更新（应用管理页；宿主面凭证） */
export async function pluginCheckAppUpdate(pluginId: string): Promise<AppUpdateCheckInfo> {
  const credential = await ensureHostCredential()
  return await invoke('plugin_check_app_update', { pluginId, credential })
}

/** 下载更新包到本地（sha256 由 Rust 复算；安装走 `pluginInstallFromFile(path, true)`） */
export async function pluginDownloadUpdate(args: {
  pluginId: string
  tag: string
  zipAsset: string
  sha256: string
}): Promise<string> {
  const credential = await ensureHostCredential()
  return await invoke('plugin_download_update', { ...args, credential })
}

/**
 * 应用包预读结果（安装前裁决：新装 / 已装 / 是否留有可恢复旧数据）
 *
 * 与 Rust `PeekedAppPackage` 同形状：`hasRetainedData` 只在 fresh install 消费，
 * `installed` 供壳层区分「已装应用自己的数据」与「keep-data 卸载残留」。
 */
export interface PeekedAppPackage {
  /** 包路径（本地包原样；远程包 = 已下载的临时文件） */
  path: string
  pluginId: string
  hasRetainedData: boolean
  installed: boolean
}

/** 预读本地应用包（只读：不解压落盘、不改注册表；宿主面凭证） */
export async function pluginPeekAppPackage(path: string): Promise<PeekedAppPackage> {
  const credential = await ensureHostCredential()
  return await invoke('plugin_peek_app_package', { path, credential })
}

/**
 * 下载远程应用包到本地临时目录（两相安装的第一相；出站过 egress 闸门）
 *
 * 落地前壳层据返回的 id / 已装 / 旧数据决定是否询问恢复，再把 `path` 交给
 * `pluginInstallFromFile`。移动端尚无远程安装 UI 入口，本命令是将来入口的
 * 唯一正确形态（一相「下载即安装」无法在落盘前询问）。
 */
export async function pluginDownloadPackage(zipUrl: string): Promise<PeekedAppPackage> {
  const credential = await ensureHostCredential()
  return await invoke('plugin_download_package', { zipUrl, credential })
}

/**
 * 从本地 zip 插件包安装（宿主面凭证已绑定，ADR 0058）
 *
 * `restoreData` 只对 fresh install 生效：keep-data 卸载留下的旧数据是否恢复；
 * 缺省 false = 丢弃（壳层在存在旧数据时先询问，默认也是不恢复）。
 */
export async function pluginInstallFromFile(
  path: string,
  upgrade = false,
  restoreData = false,
): Promise<string> {
  const credential = await ensureHostCredential()
  return await invoke('plugin_install_from_file', { path, credential, upgrade, restoreData })
}

/** 卸载应用（L3；宿主拒绝系统服务）。`keepData` 缺省 = 删除应用数据 */
export async function pluginUninstall(pluginId: string, keepData = false): Promise<void> {
  const credential = await ensureHostCredential()
  return await invoke('plugin_uninstall', { pluginId, credential, keepData })
}

/** 用系统查看器打开已下载文件（需 system:open 权限） */
export async function pluginOpenFile(
  pluginId: string,
  path: string,
  displayName: string,
): Promise<void> {
  return await invoke<void>('plugin_open_file', { pluginId, path, displayName })
}

/** 用系统文件管理器打开文件所在目录（历史记录「打开所在文件夹」；需 system:open 权限） */
export async function pluginOpenFileLocation(pluginId: string, path: string): Promise<void> {
  return await invoke<void>('plugin_open_file_location', { pluginId, path })
}

/** 按文件名打开接收文件所在目录（历史「打开所在文件夹」真机路径；需 system:open 权限） */
export async function pluginRevealReceivedFile(pluginId: string, fileName: string): Promise<void> {
  return await invoke<void>('plugin_reveal_received_file', { pluginId, fileName })
}

/** 引导开启「所有文件访问」权限（打开公共 Download 目录所需；未授权时跳系统设置页
 * 返回跳转前授权状态；需 system:open 权限） */
export async function pluginOpenAllFilesAccess(pluginId: string): Promise<boolean> {
  return await invoke<boolean>('plugin_open_all_files_access', { pluginId })
}

/** 打开公共下载目录（设置页下载目录区「打开」；未授权时报 needs_all_files_access；
 * 需 system:open 权限） */
export async function pluginOpenDownloadDir(pluginId: string): Promise<void> {
  return await invoke<void>('plugin_open_download_dir', { pluginId })
}
