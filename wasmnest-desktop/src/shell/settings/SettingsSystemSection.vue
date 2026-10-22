<template>
  <!-- ==================== SYSTEM ==================== -->
  <section>
    <h3 class="wb-section-title">{{ t('settings.system.title') }}</h3>
    <div
      class="bg-[var(--bg-card)] border border-[var(--border)] rounded-[10px] divide-y divide-[var(--border)]"
    >
      <!-- 防止休眠：方角开关 -->
      <div class="px-5 py-3.5 flex items-center justify-between gap-4">
        <div>
          <span class="text-[calc(13px*var(--ui-scale))] text-[var(--text-primary)]">{{
            t('settings.system.preventSleep')
          }}</span>
        </div>
        <button
          class="relative w-10 h-5 rounded-[4px] border transition-colors flex-shrink-0"
          :class="
            preventSleep
              ? 'bg-[var(--color-primary)] border-[var(--color-primary)]'
              : 'bg-[var(--bg-page)] border-[var(--border-strong)]'
          "
          role="switch"
          :aria-checked="preventSleep"
          @click="preventSleep = !preventSleep"
        >
          <span
            class="absolute top-[3px] w-3 h-3 rounded-[2px] transition-all"
            :class="
              preventSleep
                ? 'left-[22px] bg-[var(--color-primary-contrast)]'
                : 'left-[3px] bg-[var(--border-strong)]'
            "
          />
        </button>
      </div>

      <!-- 应用贡献的动态扩展设置项：别的应用对系统设置的动态扩展（用户 2026-10-22
           裁决——有注册才在「系统设置」内动态渲染，无固定「扩展设置」分组）。
           宿主不解释 label / hint 的业务含义；动作失败只进日志，不拖垮设置页。 -->
      <component
        :is="entry.onSelect ? 'button' : 'div'"
        v-for="entry in settingsEntries"
        :key="entry.id"
        class="ext-row px-5 py-3.5 w-full flex items-center gap-4 text-left"
        :class="{ action: !!entry.onSelect }"
        :type="entry.onSelect ? 'button' : undefined"
        :data-entry-id="entry.id"
        @click="entry.onSelect ? run(entry) : undefined"
      >
        <span class="ext-ico">
          <ShellIcon :name="entry.icon || 'gear'" :size="13" />
        </span>
        <span class="ext-text">
          <b>{{ entry.label }}</b>
          <span v-if="entry.hint" class="ext-sub">{{ entry.hint }}</span>
        </span>
        <ShellIcon v-if="entry.onSelect" name="back" :size="12" class="ext-go" />
      </component>
    </div>
  </section>
</template>

<script setup lang="ts">
/**
 * 设置页 — 系统分组（SettingsView 拆分产物）
 *
 * 防止休眠开关直写 store，由父组件 deep watch 防抖持久化。
 * 扩展设置项没有独立分组：别的应用经 registerSettingsEntry 贡献的动态设置项
 * （标题 + 摘要 + 可选动作描述符）直接渲染在本组卡内、宿主机制行之后——
 * 有注册才出现，无固定「扩展设置」占位。
 *
 * 默认端口已迁出（用户 2026-10-19 裁决）：端口属终端会话/设备连接域的产品配置，
 * 控制面归 bedcode 设置页「会话」分组（经宿主面 `update_server_port` 写入宿主
 * AppConfig——真源仍在宿主，只是不再由宿主 UI 提供入口）。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/settings'
import { useShellExtensions } from '../extensions'
import type { ShellSettingsEntry } from '../extensions/types'
import { logger } from '@/utils/frontendLogger'
import ShellIcon from '../components/ShellIcon.vue'

const { t } = useI18n()
const settingsStore = useSettingsStore()
const { settingsEntries } = useShellExtensions()

const preventSleep = computed({
  get: () => settingsStore.settings.network.prevent_sleep ?? true,
  set: (value: boolean) => {
    settingsStore.settings.network.prevent_sleep = value
  },
})

async function run(entry: ShellSettingsEntry): Promise<void> {
  if (!entry.onSelect) return
  try {
    await entry.onSelect()
  } catch (e) {
    // 扩展动作失败不拖垮设置页：详情进日志，静态界面保持可用
    logger.error(`[Shell] settings extension action failed: ${entry.id}`, e)
  }
}
</script>

<style scoped>
/* 动态扩展设置行：有动作 = 按钮，无动作 = 静态行（不造点了没反应的死按钮） */
.ext-row {
  border: none;
  background: none;
  color: inherit;
  font: inherit;
}
.ext-row.action {
  cursor: pointer;
  transition:
    background-color var(--motion-duration-fast) var(--motion-ease),
    color var(--motion-duration-fast) var(--motion-ease);
}
.ext-row.action:hover {
  background: var(--bg-hover);
}
.ext-ico {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  border-radius: var(--radius-button);
  background: var(--bg-hover);
  color: var(--text-secondary);
}
.ext-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}
.ext-text b {
  font-size: calc(12.5px * var(--ui-scale));
  font-weight: 600;
  letter-spacing: -0.005em;
  color: var(--text-primary);
}
.ext-sub {
  font-size: calc(11.5px * var(--ui-scale));
  line-height: 1.45;
  color: var(--text-tertiary);
}
/* 右侧指示箭头：复用返回箭头旋转 180°，不新增图标路径 */
.ext-go {
  flex-shrink: 0;
  color: var(--text-tertiary);
  transform: rotate(180deg);
}
.ext-row.action:hover .ext-go {
  color: var(--text-primary);
}
</style>
