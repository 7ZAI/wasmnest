<template>
  <!-- 运行面适配器（Level 1：每应用一个独立 Vue 应用）
       结构约束：状态面（加载 / 预留位 / 失败）必须是插槽的**兄弟节点**——
       app.mount 会清空容器，宿主 UI 放进容器会被应用挂载抹掉。 -->
  <div class="relative flex flex-col flex-1 min-h-0">
    <!-- 运行屏插槽：注册表把该应用自己的容器 attach 进来（容器内是该应用
         独立 Vue 应用的根；attach / detach 只移动 DOM，不重建实例） -->
    <div ref="outlet" class="absolute inset-0" data-testid="app-surface-outlet" />

    <!-- 清单尚未拉完：加载态。壳先渲染、清单后到，这段窗口里 apps 为空，
         此时报「应用不存在」是假空态（2026-10-16 用户反馈）。 -->
    <div
      v-if="!app && !listReady"
      class="absolute inset-0 flex items-center justify-center bg-[var(--mobile-bg-primary)]"
    >
      <span class="shell-type-body text-[var(--mobile-text-secondary)]">
        {{ t('shell.common.loading') }}
      </span>
    </div>

    <!-- 应用不存在：清单已就绪仍查不到，给出原因，不留白屏 -->
    <div
      v-else-if="!app"
      class="absolute inset-0 flex flex-1 items-center justify-center px-8 text-center bg-[var(--mobile-bg-primary)]"
    >
      <p class="shell-type-body text-[var(--mobile-text-secondary)]">
        {{ t('shell.run.notFound') }}
      </p>
    </div>

    <!-- 应用在册但运行面未注册：预留位（终端 / AI Chatbox / 文件传输等应用内
         页面都属于应用自己，平台不实现，接入后由运行面顶掉这里）。
         注册面晚到时适配器会在组件出现后补建（见 watch），不永久空态。 -->
    <div v-else-if="!surface" class="absolute inset-0 flex flex-col bg-[var(--mobile-bg-primary)]">
      <ShellPlaceholderSurface :app="app" />
    </div>

    <!-- 创建 / 挂载失败：fail-visible（点名应用，不白屏）；
         半挂载实例已被注册表清掉，重试可重新创建，失败不牵连其他应用 -->
    <div
      v-else-if="mountFailed"
      class="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center bg-[var(--mobile-bg-primary)]"
    >
      <p class="shell-type-body text-[var(--mobile-text-secondary)]">
        {{ t('shell.run.mountFailed', { name: app.name }) }}
      </p>
      <button
        type="button"
        class="shell-capsule-btn"
        :aria-label="t('shell.common.retry')"
        @click="retryEnsure"
      >
        {{ t('shell.common.retry') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 应用运行面适配器（宿主侧）
 * -----------------------------------------------------------------------------
 * 职责：解析当前应用的运行面组件 → 经注册表 ensure 出该应用的 **独立 Vue 应用**
 * 并 attach 到本屏插槽 → 渲染加载 / 预留位 / 失败等宿主状态面。不在壳组件树里
 * 直接渲染应用运行面组件。
 *
 * 只服务当前运行屏；后台应用的实例由壳对账（ShellHost → reconcileSurfaceApps）
 * 负责建立并保持 detached。本适配器不得成为后台实例的唯一创建路径。
 *
 * 切换语义全部由注册表承担：attach / detach 幂等、detach 不 unmount、
 * 仅 dispose 与创建失败清理会 unmount（判据与桌面 appSurfaceRegistry 同组）。
 * 应用组件身份变化（应用重启注册了新组件）由注册表自动销毁旧实例重建。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { logger } from '@/utils/frontendLogger'
import { useShellApps } from '../composables/useShellApps'
import { getSurfaceAppRegistry, makeSurfaceEnsureInput } from '../surfaceRuntime'
import ShellPlaceholderSurface from './ShellPlaceholderSurface.vue'

const props = defineProps<{ appId: string }>()

const { t } = useI18n()
const { getApp, resolveSurface, listReady } = useShellApps()
const registry = getSurfaceAppRegistry()

const app = computed(() => getApp(props.appId))
/** 用 appId 而非 app 对象做依赖：应用停止/启动后对象会换，但解析入口不变 */
const surface = computed(() => resolveSurface(props.appId))

/** 本屏插槽：注册表把该应用的容器 attach 到这里 */
const outlet = ref<HTMLElement | null>(null)
/** ensure / mount 失败标记（fail-visible 状态面 + 重试） */
const mountFailed = ref(false)
/** 重试计数：自增触发重建管线（组件修复后可手动重试） */
const ensureTick = ref(0)
/** 本适配器已卸载：创建在途的续跑不得再 attach */
let unmounted = false

async function ensureAndAttach(): Promise<void> {
  const el = outlet.value
  const component = surface.value
  const appId = props.appId
  if (!el || !component || !appId) return
  mountFailed.value = false
  try {
    await registry.ensure(appId, makeSurfaceEnsureInput(component))
  } catch (e) {
    // 注册表已清半挂载实例；失败事实仍需按 appId 落一条日志
    mountFailed.value = true
    logger.error(`[ShellAppSurface] 运行面创建失败 appId=${appId}`, e)
    return
  }
  // 创建在途期间本屏可能已卸载或换了应用：此时 el 不再属于当前插槽。
  // 不得 attach——否则容器被塞进死插槽，前台信号也会被错误推成 true。
  if (unmounted || el !== outlet.value || appId !== props.appId) return
  registry.attach(appId, el)
}

function retryEnsure(): void {
  ensureTick.value += 1
}

onMounted(() => {
  void ensureAndAttach()
})

// 运行面晚到补建 / 应用身份切换 / 手动重试都走同一条 ensure + attach 管线
watch([surface, () => props.appId, ensureTick], () => void ensureAndAttach())

onBeforeUnmount(() => {
  unmounted = true
  // 切走 = 只 detach（实例与状态保留）。只摘自己挂的：过渡期新运行屏可能已把
  // 同一应用的容器 attach 到新插槽，无条件 detach 会把新屏的界面拉掉
  const record = registry.get(props.appId)
  if (record && record.container.parentElement === outlet.value) {
    registry.detach(props.appId)
  }
})
</script>
