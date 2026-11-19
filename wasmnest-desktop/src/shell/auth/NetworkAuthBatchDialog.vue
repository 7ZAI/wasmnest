<template>
  <Teleport to="body">
    <Transition name="modal">
      <div
        v-if="current"
        class="fixed inset-0 z-[9999] flex items-center justify-center p-4"
        @click.self="respond('deny')"
      >
        <div class="absolute inset-0 bg-black/50 backdrop-blur-sm"></div>

        <!-- 决策面保持实心：批量授权要逐字核对 origin，不做玻璃表面 -->
        <div
          ref="panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="network-auth-batch-title"
          tabindex="-1"
          class="relative w-full max-w-md rounded-card shadow-2xl border bg-card border-[var(--border)] focus:outline-none"
        >
          <div class="px-6 py-4 border-b border-[var(--border)]">
            <h3 id="network-auth-batch-title" class="text-lg font-semibold text-[var(--text-primary)]">
              {{ t('desktop.auth.netAuthBatchTitle', { count: current.origins.length }) }}
            </h3>
          </div>

          <div class="p-6 space-y-4">
            <p class="text-sm text-[var(--text-secondary)]">
              {{
                t('desktop.auth.netAuthBatchRequest', {
                  plugin: current.pluginId,
                  count: current.origins.length,
                })
              }}
            </p>

            <!-- 完整列出每个 origin：不得折叠 / 模糊化 / 只显示「等 N 个地址」 -->
            <div
              class="max-h-64 overflow-y-auto overscroll-contain rounded-input border border-[var(--border)] bg-[var(--bg-input)]"
              role="list"
              :aria-label="t('desktop.auth.netAuthBatchOriginList')"
            >
              <div
                v-for="origin in current.origins"
                :key="origin"
                role="listitem"
                class="px-3 py-2 text-xs text-[var(--text-primary)] break-all wb-mono border-b border-[var(--border)] last:border-b-0"
              >
                {{ origin }}
              </div>
            </div>

            <p class="text-xs text-[var(--text-tertiary)]">
              {{ t('desktop.auth.netAuthBatchScope') }}
            </p>
          </div>

          <div class="flex items-center justify-end gap-2 px-6 py-4 border-t border-[var(--border)]">
            <button
              type="button"
              class="px-3 h-9 rounded-btn text-sm font-medium bg-[var(--bg-hover)] text-[var(--text-tertiary)] hover:bg-[var(--bg-input)] transition-colors duration-200"
              @click="respond('deny_always')"
            >
              {{ t('desktop.auth.netAuthBatchDenyAlways') }}
            </button>
            <button
              type="button"
              class="px-3 h-9 rounded-btn text-sm font-medium bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:bg-[var(--bg-input)] transition-colors duration-200"
              @click="respond('deny')"
            >
              {{ t('desktop.auth.netAuthBatchDeny') }}
            </button>
            <button
              type="button"
              class="px-4 h-9 rounded-btn text-sm font-medium bg-brand text-[var(--color-primary-contrast)] hover:bg-[var(--color-primary-hover)] transition-colors duration-200"
              @click="respond('allow')"
            >
              {{ t('desktop.auth.netAuthBatchAllow', { count: current.origins.length }) }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * NetworkAuthBatchDialog — 网络出站批量授权弹窗
 *
 * 监听宿主事件 `plugin:network-auth-batch-request`，把一次批量询问映射为三态决定
 * （`allow` / `deny` / `deny_always`）经 `plugin_network_auth_batch_respond` 回给宿主。
 *
 * 与单 origin 弹窗分开：载荷是 origin 列表，决定是整批语义。事件到达时进入本组件
 * 的队列，前一批未答完不覆盖；每批完整展示全部 origin，用户必须能逐字核对。
 *
 * Esc / 点击遮罩按「本次拒绝」处理（不落账）；应答走宿主面凭证，应用前端无法代答。
 */
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  networkAuthBatchRespond,
  type NetworkAuthBatchDecision,
} from '@/utils/appCommands'
import { logger } from '@/utils/frontendLogger'

const { t } = useI18n()

/** 宿主批量弹窗事件载荷（与 `network_auth::batch_prompt` 发出的 json 对齐） */
interface NetworkAuthBatchRequest {
  requestId: string
  batchId: string
  pluginId: string
  /** 去重后的未决 origin（`scheme://host:port`，保持首次出现顺序） */
  origins: string[]
}

const queue = ref<NetworkAuthBatchRequest[]>([])
const current = computed(() => queue.value[0] ?? null)
const panel = ref<HTMLElement | null>(null)

let unlisten: UnlistenFn | null = null

function focusPanel(): void {
  void nextTick(() => panel.value?.focus())
}

onMounted(async () => {
  unlisten = await listen<NetworkAuthBatchRequest>('plugin:network-auth-batch-request', (event) => {
    queue.value = [...queue.value, event.payload]
    focusPanel()
  })
  window.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  unlisten?.()
  window.removeEventListener('keydown', onKeydown)
})

/** Esc 按「本次拒绝」收场（与超时同口径，不落账） */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.repeat || !current.value) return
  event.preventDefault()
  void respond('deny')
}

/** 回传当前批次的决定，并推进到下一批（应答失败只留日志：宿主侧按拒绝收场） */
async function respond(decision: NetworkAuthBatchDecision): Promise<void> {
  const request = current.value
  if (!request) return
  queue.value = queue.value.slice(1)
  try {
    await networkAuthBatchRespond(request.requestId, decision)
  } catch (e) {
    logger.error('[NetworkAuthBatchDialog] 应答失败', e)
  }
  focusPanel()
}
</script>

<style scoped>
.modal-enter-active,
.modal-leave-active {
  transition: opacity var(--motion-duration-base) var(--motion-ease, ease);
}

.modal-enter-active > :last-child,
.modal-leave-active > :last-child {
  transition: transform var(--motion-duration-base) var(--motion-ease, ease);
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from > :last-child,
.modal-leave-to > :last-child {
  transform: scale(0.95);
}

@media (prefers-reduced-motion: reduce) {
  .modal-enter-active,
  .modal-leave-active {
    transition: opacity 120ms linear;
  }
  .modal-enter-active > :last-child,
  .modal-leave-active > :last-child {
    transition: none;
  }
  .modal-enter-from > :last-child,
  .modal-leave-to > :last-child {
    transform: none;
  }
}
</style>