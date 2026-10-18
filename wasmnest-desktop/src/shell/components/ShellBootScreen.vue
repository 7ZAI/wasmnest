<template>
  <Teleport to="body">
    <Transition name="boot-fade">
      <div
        v-if="visible"
        class="fixed inset-0 z-[100] bg-page flex flex-col items-center justify-center gap-4"
        @click="state.boot.value = false"
      >
        <!-- 品牌标志：与应用图标（src-tauri/icons/icon.svg）逐字同源——品牌 ink
             斜向渐变底 + 编织 W（小尺寸走实心态）。品牌固定色，不跟主题反色。 -->
        <svg class="boot-logo" viewBox="0 0 100 100" aria-hidden="true">
          <defs>
            <linearGradient id="boot-logo-bg" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#16181C" />
              <stop offset="100%" stop-color="#08090B" />
            </linearGradient>
          </defs>
          <rect width="100" height="100" rx="22.5" fill="url(#boot-logo-bg)" />
          <g transform="translate(15.855,17.193) scale(0.68289)">
            <polygon points="4.54,22.28 26.06,92.71 32.32,59.81 19.46,17.72" fill="#FF9E2C" />
            <polygon points="24.22,90.61 51.10,56.86 51.10,34.38 29.84,61.08" fill="#F5F7F9" />
            <polygon points="48.90,56.86 75.78,90.61 70.16,61.08 48.90,34.38" fill="#F5F7F9" />
            <polygon points="73.94,92.71 95.46,22.28 80.54,17.72 67.68,59.81" fill="#F5F7F9" />
          </g>
        </svg>
        <div class="line">{{ t('shell.boot.line') }}</div>
        <div class="bar"><i :style="{ width: progress + '%' }"></i></div>
        <div class="log">
          <div v-for="step in steps" :key="step.key">
            <span class="dot" :class="{ ok: step.done, running: step.active }">{{
              step.done ? '✓' : step.active ? '·' : ''
            }}</span>
            {{ t(step.key, step.params) }}
          </div>
        </div>
        <div class="note">{{ t('shell.boot.skip') }}</div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * ShellBootScreen — 启动屏（真实初始化步骤驱动，非演示文案）
 *
 * 步骤 = 壳的实际加载链：面目录就绪（静态构建，瞬时）→ 就绪。
 * 授权概览步骤随前端 loader 退役（宿主自启无审批态，2026-10-17）。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useShellState } from '../useShellState'
import { useShellApps } from '../useShellApps'

const { t } = useI18n()
const state = useShellState()
const appsStore = useShellApps()

const visible = computed(() => state.boot.value)
const pluginsLoaded = computed(() => !appsStore.loading.value && appsStore.plugins.value.length > 0)
const bootStartedAt = ref(0)

/** 步骤状态机：注册表 → 授权 → 就绪（0/1/2） */
const stepIndex = ref(0)
let timer: ReturnType<typeof setInterval> | null = null

const steps = computed(() => [
  {
    key: 'shell.boot.stepRegistry',
    params: { count: appsStore.plugins.value.length },
    done: stepIndex.value >= 1,
    active: stepIndex.value === 0,
  },
  {
    key: 'shell.boot.stepAuth',
    params: {},
    done: stepIndex.value >= 2,
    active: stepIndex.value === 1,
  },
  {
    key: 'shell.boot.stepReady',
    params: {},
    done: stepIndex.value >= 3,
    active: stepIndex.value === 2,
  },
])

const progress = computed(() => {
  if (!visible.value) return 100
  const elapsed = Date.now() - bootStartedAt.value
  return Math.min(100, Math.round((elapsed / 2200) * 100))
})

/** 就绪后落一条驻留通知（运行时就绪） */
function emitReadyNotif() {
  if (!visible.value) return
  state.pushNotif({
    kind: 'info',
    sticky: true,
    icon: 'check',
    source: t('shell.notif.hostSource'),
    title: t('shell.notif.ready.title'),
    body: t('shell.notif.ready.body', { count: appsStore.plugins.value.length }),
  })
}

watch(pluginsLoaded, (done) => {
  if (done) {
    // 注册表（面目录）就绪 → 直接进就绪态；授权概览步骤随前端 loader 退役
    // （宿主 Rust 自启装配应用，无 needsApproval），不再拉 plugin_auth_overview
    stepIndex.value = 3
    emitReadyNotif()
  }
})

onMounted(() => {
  bootStartedAt.value = Date.now()
  // 壳启动即拉应用清单（与启动屏步骤联动）
  void appsStore.load()
  timer = setInterval(() => {
    // 进度条驱动（re-render 用）
    if (visible.value && progress.value >= 100) {
      state.boot.value = false
    }
  }, 120)
  // 保底：3s 后无论加载链是否就绪都收起启动屏（仅启动屏展示，
  // 授权裁决本身仍 fail-closed，见 AGENTS §8）
  setTimeout(() => {
    if (visible.value) state.boot.value = false
  }, 3000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<style scoped>
/* 启动屏品牌标志：尺寸与图标的满幅圆角方一致（图标底板 rx=22.5 / 100 网格 = 22.5%），
   底与图形由 SVG 自绘（品牌固定色），不再用主题色的 .glyph 底板包一层 */
.boot-logo {
  width: 52px;
  height: 52px;
  flex-shrink: 0;
}
.line {
  font-family: var(--font-mono, ui-monospace, 'SF Mono', Menlo, Consolas, monospace);
  font-size: calc(12px * var(--ui-scale));
  color: var(--text-secondary);
}
.bar {
  width: 280px;
  height: 3px;
  border-radius: 2px;
  background: var(--border);
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  background: var(--color-primary);
  border-radius: 2px;
  transition: width 0.3s;
}
.log {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-family: var(--font-mono, ui-monospace, 'SF Mono', Menlo, Consolas, monospace);
  font-size: calc(11px * var(--ui-scale));
  color: var(--text-tertiary);
  min-width: 280px;
}
.log div {
  display: flex;
  gap: 7px;
}
.log .dot {
  width: 12px;
  text-align: center;
}
.log .dot.ok {
  color: var(--color-success);
}
.log .dot.running {
  color: var(--color-warning);
}
.note {
  font-size: calc(11px * var(--ui-scale));
  color: var(--text-tertiary);
}
.boot-fade-enter-active,
.boot-fade-leave-active {
  transition: opacity 0.3s ease;
}
.boot-fade-enter-from,
.boot-fade-leave-to {
  opacity: 0;
}
</style>
