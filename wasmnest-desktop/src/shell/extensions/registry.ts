/**
 * 桌面壳扩展点注册表
 *
 * 职责边界：只做「注册 / 撤销 / 排序 / 查询」，不做任何 UI 决策，也不感知
 * 扩展从哪来。壳组件只消费描述符，不关心注册者是谁。
 *
 * 生命周期：`register*` 返回 Disposable，调用方停用 / 卸载时 dispose 即摘除；
 * 同 id 重复注册覆盖旧项（旧句柄的 dispose 不会误删新项）。
 */
import { computed, markRaw, shallowRef } from 'vue'
import { SHELL_SKIN_DEFAULT } from '../composables/state'
import type {
  ShellExtensionHandle,
  ShellSettingsEntry,
  ShellStatusBarItem,
  ShellThemeSkin,
} from './types'

const statusBarItems = shallowRef<ShellStatusBarItem[]>([])
const settingsEntries = shallowRef<ShellSettingsEntry[]>([])
const themeSkins = shallowRef<ShellThemeSkin[]>([])

function byOrder<T extends { order?: number }>(a: T, b: T): number {
  return (a.order ?? 100) - (b.order ?? 100)
}

const orderedStatusBarItems = computed(() => [...statusBarItems.value].sort(byOrder))
const orderedSettingsEntries = computed(() => [...settingsEntries.value].sort(byOrder))
const orderedThemeSkins = computed(() => [...themeSkins.value].sort(byOrder))

/** 注册 / 替换一个状态栏项 */
export function registerStatusBarItem(item: ShellStatusBarItem): ShellExtensionHandle {
  assertExtensionId('status bar item', item.id)
  if (!item.label && !item.component) {
    throw new Error(`[shell-extensions] status bar item "${item.id}" needs label or component`)
  }
  const entry: ShellStatusBarItem = {
    ...item,
    component: item.component ? markRaw(item.component) : undefined,
  }
  statusBarItems.value = [
    ...statusBarItems.value.filter((current) => current.id !== entry.id),
    entry,
  ]
  return {
    dispose: () => {
      // 只摘自己：同 id 已被后来者覆盖时，旧句柄不得删除新注册
      statusBarItems.value = statusBarItems.value.filter((current) => current !== entry)
    },
  }
}

/** 注册 / 替换一个设置页扩展项 */
export function registerSettingsEntry(entry: ShellSettingsEntry): ShellExtensionHandle {
  assertExtensionId('settings entry', entry.id)
  if (!entry.label.trim()) {
    throw new Error(`[shell-extensions] settings entry "${entry.id}" needs a non-blank label`)
  }
  const next: ShellSettingsEntry = { ...entry }
  settingsEntries.value = [
    ...settingsEntries.value.filter((current) => current.id !== next.id),
    next,
  ]
  return {
    dispose: () => {
      settingsEntries.value = settingsEntries.value.filter((current) => current !== next)
    },
  }
}

/** 注册 / 替换一套主题皮肤 */
export function registerThemeSkin(skin: ShellThemeSkin): ShellExtensionHandle {
  assertExtensionId('theme skin', skin.id)
  if (skin.id === SHELL_SKIN_DEFAULT) {
    throw new Error(`[shell-extensions] theme skin id "${SHELL_SKIN_DEFAULT}" is reserved`)
  }
  assertTokens(skin.id, skin.tokens)
  assertTokens(skin.id, skin.darkTokens)
  const next: ShellThemeSkin = { ...skin }
  themeSkins.value = [...themeSkins.value.filter((current) => current.id !== next.id), next]
  return {
    dispose: () => {
      themeSkins.value = themeSkins.value.filter((current) => current !== next)
    },
  }
}

/** 清空全部扩展注册（宿主重载 / 测试隔离；正常注销走各 Disposable） */
export function clearShellExtensions(): void {
  statusBarItems.value = []
  settingsEntries.value = []
  themeSkins.value = []
}

/**
 * 扩展点 id 契约：必须是 trim 后的非空串。
 *
 * 空 / 空白 / 前后带空白的 id 会破坏「同 id 覆盖」语义（多个空 id 彼此顶掉或共存），
 * 并让消费组件的 v-for :key、选中态比较出现重复 / 非法键。注册表是第三方贡献的
 * 契约边界，非法 id 在注册时即拒绝，而不是延迟到渲染期炸。
 */
function assertExtensionId(kind: string, id: string): void {
  if (typeof id !== 'string' || id.trim() === '' || id !== id.trim()) {
    throw new Error(`[shell-extensions] ${kind} id must be a non-blank, trimmed string`)
  }
}

function assertTokens(skinId: string, tokens: Record<string, string> | undefined): void {
  if (!tokens) return
  for (const key of Object.keys(tokens)) {
    if (!key.startsWith('--')) {
      throw new Error(`[shell-extensions] theme skin "${skinId}" token must start with --: ${key}`)
    }
  }
}

/** 壳内消费入口：全部为已排序视图（computed，注册变化即时反映） */
export function useShellExtensions() {
  return {
    statusBarItems: orderedStatusBarItems,
    settingsEntries: orderedSettingsEntries,
    themeSkins: orderedThemeSkins,
  }
}
