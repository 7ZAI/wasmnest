<template>
  <section class="card-screen" :aria-label="t(head.nameKey)">
    <!-- 系统页卡：页头 + 页体（2026-10-19 用户裁决：撤掉三页互切 tab——
         设置页只展示设置，应用管理 / 权限与授权同理；系统页之间的跳转走主屏
         系统网格 / 多任务面板，以及页内既有的互跳入口卡片） -->
    <div class="sysframe">
      <div class="sys-head">
        <!-- 页头与页体共用一条左基线（同一个 980px 内容列）：此前页头贴窗口左缘
             20px、页体居中在 230px，一屏里出现两条互不相干的对齐线，像把两个页
             拼在一起。页头内容收进与 .sys-wrap 同宽同内边距的容器后，图标 / 标题 /
             正文自上而下落在同一条竖线上。 -->
        <div class="sys-head-in">
          <!-- 二级页返回：回父页（同卡子路由，router.push 即可——ShellHost 的
               route.path watch 会经 syncFromRoute 归位 face） -->
          <button v-if="sub" class="sys-back" @click="backToParent">
            <ShellIcon name="back" :size="13" />
            <span>{{ t(parentMeta.nameKey) }}</span>
          </button>
          <span class="glyph-box tone-system" style="width: 38px; height: 38px">
            <ShellIcon :name="head.icon" :size="19" :stroke-width="1.7" />
          </span>
          <div class="min-w-0">
            <div class="sys-t">{{ t(head.nameKey) }}</div>
            <div class="note">{{ t(head.descKey) }}</div>
          </div>
        </div>
      </div>
      <div class="sys-body">
        <div class="sys-wrap">
          <SysAppsView v-if="sysPageId === 'apps'" />
          <SysPermsView v-else-if="sysPageId === 'perms'" />
          <SysShortcutsView v-else-if="subId === 'shortcuts'" />
          <SysAppearanceView v-else-if="sub" />
          <SysSettingsView v-else />
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
/**
 * ShellCardScreen — 系统页全屏承载（应用管理 / 权限与授权 / 设置）
 *
 * 2026-10-17 壳恢复后：应用面（bedcode 界面）由 ShellHost 直接渲染 AppContent
 * （侧边栏工作台形态），本组件只承载系统页卡——页头 + 页体。
 * 2026-10-19 用户裁决：撤掉页头下的三页互切 tab，每张系统页只展示自己的内容
 * （设置页不再混着「应用管理 / 权限」的切换入口）；系统页之间的跳转走主屏系统
 * 网格 / 多任务面板与页内互跳卡片。当前页取自路由（/sys/:pageId），与 ShellHost
 * 的分流一致。
 * 2026-10-28 用户裁决：系统页支持二级页（/sys/:pageId/:sub，同一张卡内切子路由，
 * 如设置页「外观」）——页头换二级页元数据并出现返回父页的按钮，页体按子页分发。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { SYS_PAGES, SYS_SUB_PAGES } from '../composables/state'
import ShellIcon from './ShellIcon.vue'
import SysAppsView from '../sys/SysAppsView.vue'
import SysPermsView from '../sys/SysPermsView.vue'
import SysAppearanceView from '../sys/SysAppearanceView.vue'
import SysShortcutsView from '../sys/SysShortcutsView.vue'
import SysSettingsView from '../sys/SysSettingsView.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const sysPageId = computed(() => route.params.pageId as string)
/** 二级页子段原文（settings/appearance | settings/shortcuts），分发与元数据都用它 */
const subId = computed(() => route.params.sub as string | undefined)
/** 二级页元数据（settings/appearance → 外观）；无子段或不认识的子段都回落父页 */
const sub = computed(() => {
  const s = subId.value
  return (s && SYS_SUB_PAGES[`${sysPageId.value}/${s}`]) || null
})
const parentMeta = computed(
  () => SYS_PAGES.find((s) => s.id === sysPageId.value) ?? SYS_PAGES[0],
)
/** 页头元数据：二级页优先，否则父页自身 */
const head = computed(() => sub.value ?? parentMeta.value)

function backToParent(): void {
  void router.push(`/sys/${sysPageId.value}`)
}
</script>

<style scoped>
.card-screen {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  /* 背景由 ShellHost 壳根（.shell-wall）统一铺：系统页若再自铺 --bg-page，
     切到系统页时壁纸会被整面盖住。 */
}
.sysframe {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.sys-head {
  padding: 18px 0 14px;
  border-bottom: 1px solid var(--border);
}
.sys-head-in {
  max-width: 980px;
  margin: 0 auto;
  padding: 0 20px;
  display: flex;
  align-items: center;
  gap: 13px;
}
/* 二级页返回：页头内联小按钮（图标 + 父页名），只出现在子路由上；
   同 .shell-mini 的尺寸感但去边框——页头不放重边框控件，弱化为可点的位置线索 */
.sys-back {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px;
  border-radius: var(--radius-button);
  color: var(--text-secondary);
  font-size: calc(11.5px * var(--ui-scale));
  white-space: nowrap;
  transition:
    background-color var(--motion-duration-fast) var(--motion-ease),
    color var(--motion-duration-fast) var(--motion-ease);
}
.sys-back:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
/* 页面标题取显示级字号（19px × ui-scale）：与 13px 正文拉开 1.45 档，
   一进系统页先读到「这是哪一页」；此前 15px 只比正文大一点，标题不成层级。 */
.sys-t {
  font-size: var(--font-size-h1);
  font-weight: 600;
  line-height: 1.25;
  letter-spacing: -0.015em;
  color: var(--text-primary);
}
.sys-head .note {
  font-size: calc(12px * var(--ui-scale));
  color: var(--text-secondary);
  line-height: 1.4;
  margin-top: 3px;
}
.sys-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.sys-wrap {
  max-width: 980px;
  margin: 0 auto;
  padding: 18px 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
</style>
