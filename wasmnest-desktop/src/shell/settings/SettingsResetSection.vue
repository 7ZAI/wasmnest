<template>
  <!-- ==================== RESET（恢复初始设置） ==================== -->
  <section>
    <h3 class="wb-section-title">{{ t('settings.reset.title') }}</h3>
    <div class="bg-[var(--bg-card)] border border-[var(--border)] rounded-[10px] px-5 py-4">
      <div class="flex items-center justify-between gap-4">
        <span class="text-[calc(13px*var(--ui-scale))] text-[var(--text-primary)]">{{
          t('settings.reset.desc')
        }}</span>
        <!-- 破坏性动作入口不用 ghost（与普通设置动作同形会掩盖风险）：danger tint +
             回转箭头，与弹窗内确认按钮同一视觉语言 -->
        <Button
          variant="danger"
          size="sm"
          data-testid="settings-reset-open"
          @click="confirmOpen = true"
        >
          <template #icon>
            <ShellIcon name="reset" :size="13" />
          </template>
          {{ t('settings.reset.action') }}
        </Button>
      </div>
    </div>

    <!-- 二次确认：破坏性操作（清授权记录 + 还原默认配置）必须显式确认 -->
    <Modal
      :model-value="confirmOpen"
      size="sm"
      :title="t('settings.reset.confirmTitle')"
      @update:model-value="(v: boolean) => (confirmOpen = v)"
    >
      <p
        data-testid="settings-reset-confirm-body"
        class="text-[calc(12px*var(--ui-scale))] text-[var(--text-secondary)] leading-relaxed"
      >
        {{ t('settings.reset.confirmBody') }}
      </p>
      <template #footer>
        <div class="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            data-testid="settings-reset-cancel"
            @click="confirmOpen = false"
          >
            {{ t('common.button.cancel') }}
          </Button>
          <Button
            variant="danger"
            size="sm"
            :disabled="busy"
            :loading="busy"
            data-testid="settings-reset-confirm"
            @click="runReset"
          >
            {{ t('settings.reset.confirmOk') }}
          </Button>
        </div>
      </template>
    </Modal>
  </section>
</template>

<script setup lang="ts">
/**
 * 设置页 — 「恢复初始设置」分组
 *
 * 语义（用户 2026-10-19）：一次点击做两件事——
 *   1. 清除所有授权记录：先撤销全部 allow（`plugin_auth_revoke`），再重新读一遍
 *      授权模型移除全部 deny（`plugin_auth_remove_record`），回到「未覆盖」初始态；
 *   2. 还原默认配置：整表回传宿主 AppConfig 默认值（端口 / 主题 / 字号 / 动画 /
 *      终端默认值），重置壳的壁纸 / 遮罩 / 主题偏好，并删除复制到应用数据目录的
 *      自定义壁纸文件（只改偏好会把文件留在磁盘上，等于没恢复干净）。
 *
 * **必须两遍**：撤销的语义是「删 allow + 落一条 deny」（spec §8.4），新落的 deny
 * 不在首轮快照里。只按首轮快照遍历会把「恢复初始设置」变成「把用户授权过的每个
 * 目标都硬拒绝」——deny 是判定链第 0 层，此后相关应用一律打不开（2026-10-20 实机：
 * ai-chatbox 激活被 `~/.wasmnest/ai-chatbox` 的 deny 记录拦下）。
 *
 * 破坏性操作必须有显式确认（弹窗），失败显性提示，不静默部分完成。
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import { useSettingsStore } from '@/stores/settings'
import { authOverview, authRemoveRecord, authRevoke } from '@/utils/appCommands'
import { useShellSettings } from '@/shell/composables/useShellSettings'
import { clearCustomWallpaper } from '@/shell/composables/customWallpaper'
import { WALLPAPER_DEFAULT, WALL_DIM_DEFAULT } from '@/shell/composables/state'
import { SHELL_THEME_DEFAULT } from '@/shell/composables/themePresets'
import Button from '@/components/Button.vue'
import Modal from '@/components/Modal.vue'
import ShellIcon from '@/shell/components/ShellIcon.vue'

const { t } = useI18n()
const toast = useToast()
const settingsStore = useSettingsStore()
const { prefs } = useShellSettings()

const confirmOpen = ref(false)
const busy = ref(false)

async function clearAllAuthRecords(): Promise<void> {
  // 第一遍：撤销全部 allow。每次撤销都会落一条新的 deny（spec §8.4）。
  const apps = await authOverview()
  for (const app of apps) {
    for (const rec of app.records) {
      if (rec.effect === 'allow') {
        await authRevoke(app.pluginId, rec.resource, rec.target)
      }
    }
  }

  // 第二遍：重新读取，移除全部 deny（含第一遍新落的），否则「清空」反而变成
  // 「全部硬拒绝」，应用被判定链第 0 层永久拦下。
  const after = await authOverview()
  for (const app of after) {
    for (const rec of app.records) {
      if (rec.effect === 'deny') {
        await authRemoveRecord(app.pluginId, rec.resource, rec.target)
      }
    }
  }
}

async function runReset(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    await clearAllAuthRecords()
    // 复制到应用数据目录的自定义壁纸也要删（用户 2026-10-20 明确要求）：
    // 只把偏好改回默认会把文件留在磁盘上，等于「恢复初始设置」没有恢复干净。
    await clearCustomWallpaper()
    await settingsStore.resetSettings()
    prefs.value.wallpaper = WALLPAPER_DEFAULT
    prefs.value.wallDim = WALL_DIM_DEFAULT
    prefs.value.wallpaperImage = ''
    prefs.value.theme = SHELL_THEME_DEFAULT
    confirmOpen.value = false
    toast.success(t('settings.reset.done'))
  } catch (e) {
    console.error('[Settings] reset to defaults failed:', e)
    toast.error(t('settings.reset.failed'))
  } finally {
    busy.value = false
  }
}
</script>
