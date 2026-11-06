<template>
  <!-- ==================== ABOUT ==================== -->
  <section>
    <h3 class="wb-section-title">{{ t('settings.about.title') }}</h3>
    <div class="shell-panel px-5 py-4">
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-2">
          <span class="text-[calc(13px*var(--ui-scale))] font-semibold text-[var(--text-primary)]"
            >WasmNest</span
          >
          <span class="wb-mono text-[var(--text-secondary)]">v{{ appVersion || '—' }}</span>
        </div>
        <div class="flex items-center gap-3">
          <!-- GitHub 仓库：系统浏览器打开（按钮走壳控件语言，玻璃主题才有药丸材质） -->
          <button class="shell-btn ghost" data-testid="settings-github" @click="openGitHub">
            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.27-.01-1.17-.02-2.12-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.25 3.34.95.1-.74.4-1.25.73-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.15 1.18a10.96 10.96 0 015.74 0c2.19-1.49 3.15-1.18 3.15-1.18.62 1.59.23 2.76.11 3.05.73.81 1.18 1.83 1.18 3.09 0 4.41-2.69 5.38-5.25 5.67.41.35.77 1.05.77 2.12 0 1.53-.01 2.76-.01 3.14 0 .31.21.67.8.56A11.51 11.51 0 0023.5 12C23.5 5.65 18.35.5 12 .5z"
              />
            </svg>
            {{ t('settings.about.githubRepo') }}
          </button>
          <!-- 下载进度 -->
          <template v-if="updateStatus === 'downloading'">
            <div class="w-32 h-1.5 bg-[var(--border)] overflow-hidden">
              <div
                class="h-full w-full origin-left bg-[var(--color-primary)] transition-transform duration-300"
                :style="{ transform: `scaleX(${downloadPercent / 100})` }"
              />
            </div>
            <span class="wb-mono text-[var(--text-secondary)]">{{ downloadPercent }}%</span>
          </template>
          <!-- 有新版：版本号 + 主操作；检查按钮让位，同一行只留一个可点的动作 -->
          <template v-else-if="updateStatus === 'available'">
            <span class="text-xs text-[var(--text-secondary)]">
              {{ t('settings.about.newVersionAvailable') }}
              <span v-if="availableVersion" class="wb-mono text-[var(--text-primary)]"
                >v{{ availableVersion }}</span
              >
            </span>
            <button
              class="shell-btn"
              data-testid="settings-install-update"
              @click="handleInstallUpdate"
            >
              {{ t('settings.about.downloadUpdate') }}
            </button>
          </template>
          <!-- 检查中：按钮留在原位只换禁用态（标签不变 → 行宽不跳），无障碍名换成进度文案 -->
          <button
            v-else-if="updateStatus === 'checking'"
            class="shell-btn ghost"
            data-testid="settings-check-update"
            disabled
            aria-busy="true"
            :aria-label="t('settings.about.checkingUpdate')"
          >
            <span class="update-spinner" aria-hidden="true"></span>
            {{ t('settings.about.checkUpdate') }}
          </button>
          <span
            v-else-if="updateStatus === 'downloaded' || updateStatus === 'installing'"
            class="text-xs text-[var(--text-secondary)]"
          >
            {{ getUpdateStatusText() }}
          </span>
          <button
            v-else
            class="shell-btn ghost"
            data-testid="settings-check-update"
            @click="handleCheckUpdate"
          >
            {{ t('settings.about.checkUpdate') }}
          </button>
        </div>
      </div>
      <p v-if="updateStatus === 'failed'" class="mt-2 text-xs text-[var(--color-danger-ink)]">
        {{ getUpdateStatusText() }}
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
/**
 * 设置页 — 关于分组（SettingsView 拆分产物）
 *
 * 版本号、GitHub 仓库链接、更新检查 / 下载 / 安装进度。
 * 卡面走 `.shell-panel`（与 `.shell-card` 同一档内容面），按钮走 `.shell-btn`：
 * 此前用 legacy `.wb-btn-*` / 裸 `bg-[var(--bg-card)]`，玻璃主题的结构规则命中不到，
 * 同一页里因此出现「玻璃药丸」与「实心 6px 圆角」两种控件语言。
 * 挂载时读取应用版本号；更新状态由 useUpdateChecker（模块级单例）共享。
 * 「检查更新」入口就在本卡（此前只有状态展示，触发按钮只存在于测试注释里的
 * 旧工具栏，实际已无任何 UI 入口）。检查源 = GitHub Release 的 latest.json。
 */
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import { useUpdateChecker } from '@/shell/settings/useUpdateChecker'
import { getAppVersion, openExternalUrl } from '@/shell/settings/commands'
import { logger } from '@/utils/frontendLogger'
import i18n from '@/i18n'

const { t } = useI18n()
const toast = useToast()

const {
  status: updateStatus,
  downloadProgress,
  availableVersion,
  checkForUpdate,
  downloadAndInstall,
  getUpdateStatusText,
} = useUpdateChecker()

const appVersion = ref('')

async function handleCheckUpdate() {
  const update = await checkForUpdate()
  if (!update && updateStatus.value === 'latest') {
    toast.info(i18n.global.t('settings.about.alreadyLatest'))
  } else if (!update && updateStatus.value === 'failed') {
    toast.error(i18n.global.t('settings.about.checkFailed'))
  }
}

async function handleInstallUpdate() {
  await downloadAndInstall()
}

/** 在系统浏览器中打开 GitHub 仓库（经宿主命令，http/https scheme 白名单闸门）
 *
 * 地址必须是**发布 latest.json 的那个仓**（`7ZAI/wasmnest`）：更新检查与安装都
 * 从这里取资产，链接指向旧仓（BedCode）会把用户带到与更新源无关的页面。
 */
async function openGitHub() {
  try {
    await openExternalUrl('https://github.com/7ZAI/wasmnest')
  } catch (e) {
    logger.error('Failed to open GitHub repo:', e)
  }
}

const downloadPercent = computed(() => {
  if (downloadProgress.value.contentLength === 0) return 0
  return Math.round(
    (downloadProgress.value.downloaded / downloadProgress.value.contentLength) * 100,
  )
})

onMounted(async () => {
  try {
    appVersion.value = await getAppVersion()
  } catch {
    appVersion.value = '—'
  }
})
</script>

<style scoped>
/* 检查中的行内加载指示：颜色继承按钮 currentColor（disabled 态自带降透明），
   旋转只出现在进行中的动作上（ui-ux-pro-max · ux · Continuous Animation）。
   全局「动画效果」关闭与 prefers-reduced-motion 由壳 CSS 压成瞬时，此处不重复判。 */
.update-spinner {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1.5px solid color-mix(in srgb, currentColor 30%, transparent);
  border-top-color: currentColor;
  animation: update-spinner-spin 0.8s linear infinite;
}
@keyframes update-spinner-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
