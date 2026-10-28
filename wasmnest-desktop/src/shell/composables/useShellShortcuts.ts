/**
 * 壳快捷键装配层：绑定读写（壳偏好轨）+ window capture 抢占监听 + 动作执行
 *
 * 分工：决策全在 shortcutsModel（纯函数、直测），本文件只是薄装配——
 * 守卫链（splash / IME 让位）→ 规范化 → 查生效绑定 → 执行动作 → 拦截事件。
 * 动作全部落在宿主自有壳原语（useShellState / settings store），不携带应用
 * 产品语义（§2 自检见 shortcutsModel 头注释）。
 *
 * 抢占契约（ADR 0060）：capture 阶段先于一切 DOM / 冒泡监听；**只有命中已注册
 * 组合才** preventDefault + stopPropagation——其余按键（含应用内单键、Esc、
 * 组合）完全放行，应用照常收到。用户清空绑定 = 组合归还应用。ShellHost 原有
 * 的冒泡 onKeydown 保持管 Esc / 主屏搜索语义（不进注册表），两者的接缝在
 * ShellHost.onKeydown 的注释里。
 */
import { computed } from 'vue'
import { useShellSettings } from './useShellSettings'
import { useShellState } from './useShellState'
import {
  cycleAppCards,
  effectiveBindings,
  comboFromEvent,
  type ShortcutActionId,
} from './shortcutsModel'
import { useSettingsStore } from '@/stores/settings'
import { useTheme } from '@/composables/useTheme'
import {
  FONT_SIZE_LEVELS,
  NORMAL_FONT_SIZE,
  fontSizeLevelIndex,
  useFontSize,
} from '@/composables/useFontSize'

/**
 * 录制挂起（模块级单标记，同一时刻至多一个录制框）：设置页录键期间 capture
 * 监听整体让位——否则用户按下的新组合会先被抢占逻辑吞掉（命中已注册组合时
 * 还会误触发动作），录制框永远收不到事件。
 */
let captureSuspended = false

export function suspendShortcutCapture(): void {
  captureSuspended = true
}

export function resumeShortcutCapture(): void {
  captureSuspended = false
}

export function useShellShortcuts() {
  const { prefs } = useShellSettings()

  /** 生效绑定（默认表 + sparse 覆盖；'' = 已清除 = 组合归还应用） */
  const bindings = computed(() => effectiveBindings(prefs.value.shortcuts))

  /** 组合串 → 动作（反查表；空绑定不入表） */
  const actionByCombo = computed(() => {
    const map = new Map<string, ShortcutActionId>()
    for (const [id, combo] of Object.entries(bindings.value)) {
      if (combo !== '') map.set(combo, id as ShortcutActionId)
    }
    return map
  })

  // ==================== 绑定写侧（设置页消费） ====================

  /** 录入保存（UI 侧先用 shortcutsModel.validateBinding 裁决，fail-visible） */
  function setBinding(action: ShortcutActionId, combo: string): void {
    prefs.value = {
      ...prefs.value,
      shortcuts: { ...prefs.value.shortcuts, [action]: combo },
    }
  }

  /** 单动作恢复默认：摘掉覆盖键（与「未改过」同形，未来出厂键位调整自动跟随） */
  function resetBinding(action: ShortcutActionId): void {
    if (prefs.value.shortcuts === undefined) return
    const next = { ...prefs.value.shortcuts }
    delete next[action]
    prefs.value = { ...prefs.value, shortcuts: Object.keys(next).length > 0 ? next : undefined }
  }

  /** 全部恢复默认 */
  function resetAllBindings(): void {
    prefs.value = { ...prefs.value, shortcuts: undefined }
  }

  // ==================== 动作执行器（全部现成壳原语） ====================

  async function runAction(action: ShortcutActionId): Promise<void> {
    const state = useShellState()
    switch (action) {
      case 'app.next':
      case 'app.prev': {
        const target = cycleAppCards(
          state.cards.value,
          state.activeCard.value,
          action === 'app.next' ? 1 : -1,
        )
        if (!target) return
        // 多任务层开着时先切后收：用户要的是「看到目标应用」，不是 stale 面板
        if (state.recentsOpen.value) state.toggleRecents(false)
        state.activateCard(target)
        return
      }
      case 'multitask.toggle':
        state.toggleRecents()
        return
      case 'home':
        state.goHome()
        return
      case 'settings.open':
        state.openSys('settings')
        return
      case 'apps.manage':
        state.openSys('apps')
        return
      case 'theme.toggle': {
        // ShellToolbar.toggleTheme 同款（useTheme.isDark 处理 system 档）
        const settingsStore = useSettingsStore()
        const { isDark } = useTheme()
        settingsStore.settings.ui.theme = isDark.value ? 'light' : 'dark'
        void settingsStore.saveSettings({ ui: settingsStore.settings.ui })
        return
      }
      case 'font.increase':
      case 'font.decrease': {
        // 五档划分（2026-10-28）：px 是持久化真源，档位只是离散口径；到头 no-op
        const settingsStore = useSettingsStore()
        const cur = fontSizeLevelIndex(settingsStore.settings.ui.font_size || NORMAL_FONT_SIZE)
        const next = cur + (action === 'font.increase' ? 1 : -1)
        if (next < 0 || next >= FONT_SIZE_LEVELS.length) return
        settingsStore.settings.ui.font_size = FONT_SIZE_LEVELS[next].px
        useFontSize().setupFontSize()
        void settingsStore.saveSettings({ ui: settingsStore.settings.ui })
        return
      }
    }
  }

  // ==================== capture 抢占监听 ====================

  /**
   * 装配全局 capture keydown；返回 teardown。
   * enabled：壳总闸（splash 期不动作）——让位语义比动作集合更基础的守卫放调用方。
   */
  function setupShellShortcuts(options: { enabled: () => boolean }): () => void {
    const handler = (e: KeyboardEvent): void => {
      if (captureSuspended) return // 设置页录键中：整体让位（ADR 0060 录制例外）
      if (!options.enabled()) return
      // IME 合成期让位（useHomeSearch 同款判据）：候选确认键绝不是快捷键
      if (e.isComposing || e.keyCode === 229) return
      const combo = comboFromEvent(e)
      if (!combo) return
      const action = actionByCombo.value.get(combo)
      if (!action) return // 未注册组合：完全放行（应用照常收到，壳不抢）
      e.preventDefault()
      e.stopPropagation()
      void runAction(action)
    }
    // capture：先于应用内任何元素监听与 ShellHost 的冒泡 onKeydown
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }

  return { bindings, setBinding, resetBinding, resetAllBindings, setupShellShortcuts }
}
