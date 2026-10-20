/**
 * 壳状态（模块级单例 composable）— 主屏 + 全屏面 + 卡片 MRU + 覆层 + 通知
 *
 * 2026-10-17 lifecycle-sync 改造后：
 * - 路由是唯一事实源：'/' = 主屏；'/sys/*' = 系统页全屏；app 路由 = 应用界面全屏；
 * - cards = 打开过的面清单（MRU，路由驱动；主屏不展示，工具栏多任务面板消费）；
 * - **打开 / 关闭走真实生命周期**：openApp = preauthorize → activate（真激活，
 *   仅当前会话，不写启动复活快照）+ 挂载运行面；closeCard / stopApp = deactivate
 *   （**真停用**）成功后才摘面
 *   （D2/D5；动作经 useShellApps 收口到宿主命令面）；
 * - 审批：未授权激活落 NeedsApproval → 壳审批弹窗（approval 分支）→ 批准后激活；
 * - 通知：审批通知从待审批应用派生（真实数据源，不再是恒空桩）。
 */
import { computed, ref } from 'vue'
import { useToast } from '@/composables/useToast'
import i18n from '@/i18n'
import router from '@/router'
import { forgetAppRoute, lastRouteOf } from '../mount/appSession'
import { appCardKey, cardId, cardKind, isHighRisk, mruActivate, mruRemove, notifCount, sysCardKey, sysPageOf } from './state'
import { pluginIdOfAppRoute, useShellApps } from './useShellApps'
import type { CardKey, HostNotif, ShellCtxMenu, ShellDialogKind, ShellScreen } from '../types'

const toast = useToast()
const t = i18n.global.t

// ==================== 主屏 + 面 ====================

const screen = ref<ShellScreen>('home')
/** 打开过的面清单（MRU 最新在前；工具栏多任务面板与「全部关闭」消费） */
const cards = ref<CardKey[]>([])
/** 当前全屏面（screen === 'card' 时非空；由路由同步） */
const activeCard = ref<CardKey | null>(null)

// ==================== 覆层（不产卡；Esc 逐层收） ====================

const panelOpen = ref(false)
/** 快捷设置面板（工具栏「快捷设置」入口；2026-10-19 与通知中心拆分） */
const quickSettingsOpen = ref(false)
/** 多任务全屏层（工具栏「多任务」入口；后台运行的应用在此切换 / 关闭） */
const recentsOpen = ref(false)
const ctxMenu = ref<ShellCtxMenu | null>(null)
const dialog = ref<ShellDialogKind | null>(null)
/** 弹窗关联的应用 id（审批 / 卸载弹窗的目标） */
const dialogAppId = ref<string | null>(null)
/** 策略二次确认的资源（授权策略切换弹窗预留） */
const dialogResource = ref<string | null>(null)
/** 主屏 type-to-search 查询串 */
const homeQ = ref('')

// ==================== 通知（机制面） ====================

const notifs = ref<HostNotif[]>([])
let notifSeq = 100

function pushNotif(
  n: Omit<HostNotif, 'id' | 'mins' | 'sticky'> & { mins?: number; sticky?: boolean },
): void {
  const { mins = 0, sticky = false, ...rest } = n
  notifs.value = [{ id: 'n' + ++notifSeq, mins, sticky, ...rest }, ...notifs.value]
}

function dismissNotif(id: string): void {
  notifs.value = notifs.value.filter((n) => n.id !== id)
}

/** 清除全部：驻留项（sticky）不动，只清可清除的普通通知 */
function clearNotifs(): void {
  notifs.value = notifs.value.filter((n) => n.sticky)
}

/**
 * 审批通知：从待审批应用动态派生（真实 NeedsApproval 态；批准后自然消失，
 * 无独立生命周期——与「宿主只承载机制面、文案由来源方给出」同口径）
 */
function approvalNotifs(): HostNotif[] {
  const apps = useShellApps()
  return apps.approvalApps.value.map((app) => ({
    id: 'approval:' + app.id,
    kind: 'info',
    icon: 'shield',
    source: t('shell.notif.hostSource'),
    app: app.id,
    title: t('shell.notif.approval.title'),
    body: t('shell.notif.approval.body', {
      perms: app.permissions.length,
      risks: app.permissions.filter((p) => isHighRisk(p)).length,
    }),
    mins: 0,
    actions: [{ id: 'go', label: t('shell.notif.approval.go') }],
    sticky: true,
  }))
}

/** 铃铛角标 = 通知条数 + 待审批数（审批是真实动作入口，必须可见） */
const notifCountTotal = computed(() => notifCount(notifs.value) + approvalNotifs().length)

// ==================== 面动作（路由驱动 + 真实生命周期） ====================

/**
 * 面 key → 落地路由。
 *
 * 应用卡优先回**上次停在那页**（app 自报，见 appSession）：实例仍在后台运行时
 * 「切回应用」应当续接，而不是每次都把人丢回落地页；没记录过才用落地路由。
 */
function routeOf(key: CardKey): string {
  if (cardKind(key) === 'app') {
    const appId = cardId(key)
    return lastRouteOf(appId) ?? useShellApps().appOf(appId)?.route ?? '/'
  }
  const sys = sysPageOf(cardId(key))
  return sys ? `/sys/${sys.id}` : '/'
}

/** 路由 → 面 key（反向；未知路由回主屏） */
function faceOfRoute(path: string): CardKey | null {
  if (path === '/') return null
  if (path.startsWith('/sys/')) return sysCardKey(path.split('/')[2] ?? '')
  const pluginId = pluginIdOfAppRoute(path)
  return pluginId ? appCardKey(pluginId) : null
}

/**
 * 某应用当前是否有壳内会话（打开过且未真停用 = 卡片还在）。
 *
 * 主屏绿点的必要条件之一（`state.ts#appDotState`）：角色驱动的后台实例没有卡片，
 * 不算用户打开过，不画绿点；显式自启的应用另由 autostart 放行。
 */
function hasAppSession(appId: string): boolean {
  return cards.value.some((key) => cardKind(key) === 'app' && cardId(key) === appId)
}

/** 进入一个面（MRU 置顶 + 切 card 屏；幂等：重复进入只重排不重复产卡） */
function enterFace(key: CardKey | null): void {
  if (!key) {
    screen.value = 'home'
    activeCard.value = null
    return
  }
  cards.value = mruActivate(cards.value, key)
  activeCard.value = key
  screen.value = 'card'
  panelOpen.value = false
  quickSettingsOpen.value = false
  recentsOpen.value = false
  ctxMenu.value = null
}

/** 路由变化 → 壳状态同步（ShellHost watch route.path 调用） */
function syncFromRoute(path: string): void {
  enterFace(faceOfRoute(path))
}

/**
 * 开应用面：**真实激活**（preauthorize → activate，仅当前会话、不写启动快照）+
 * 产卡 + 进入应用界面路由。失败时按终态分流：NeedsApproval → 审批弹窗；其余 toast 错误。
 * 无宿主运行面的应用（如 ai-chatbox / file-transfer）只激活不产卡——壳诚实呈现
 * 「已运行但无挂载视图」（主屏网格状态 chip 可见）。
 *
 * 已在后台运行的应用再点图标 = **续接**：进入它上次停留的页面（app 自报记录），
 * 不重置到落地页——这是「记住运行中应用的状态」的落点。
 */
async function openApp(appId: string): Promise<void> {
  const apps = useShellApps()
  const app = apps.appOf(appId)
  if (!app) return

  const wasRunning = app.state === 'running' || app.state === 'degraded'
  const ok = await apps.activate(appId)
  if (!ok) {
    const failed = apps.appOf(appId)
    if (failed?.state === 'approval') {
      // 未授权激活被审批门禁拒 → 壳审批弹窗（D5：preauthorize → activate →
      // NeedsApproval → plugin_approve → 激活）
      dialog.value = 'approval'
      dialogAppId.value = appId
    }
    // 其余失败已由 useShellApps.runAction → showUserError 统一 toast（ADR 0030），
    // 这里不再二次提示：lastError 是错误码，铺到 toast 上就是给用户看 code
    return
  }

  if (!app.route) {
    // 无宿主运行面：激活成功但无界面可挂载——只落通知不产卡
    if (!wasRunning) {
      pushNotif({
        kind: 'event',
        icon: 'play',
        source: t('shell.notif.hostSource'),
        app: appId,
        title: t('shell.notif.started.title'),
        body: t('shell.notif.started.body', { name: app.name }),
      })
    }
    return
  }

  enterFace(appCardKey(appId))
  void router.push(lastRouteOf(appId) ?? app.route)
  if (!wasRunning) {
    pushNotif({
      kind: 'event',
      icon: 'play',
      source: t('shell.notif.hostSource'),
      app: appId,
      title: t('shell.notif.started.title'),
      body: t('shell.notif.started.body', { name: app.name }),
    })
  }
}

/** 开系统页卡 */
function openSys(pageId: string): void {
  const sys = sysPageOf(pageId)
  if (!sys) return
  enterFace(sysCardKey(pageId))
  void router.push(`/sys/${pageId}`)
}

/**
 * 多任务面板开合（工具栏入口）。
 *
 * 与通知中心 / 快捷设置互斥：三者都是占满视野的浏览面，同时开只会互相遮挡；
 * 打开多任务即收起通知中心、快捷设置与右键菜单。
 */
function toggleRecents(open = !recentsOpen.value): void {
  recentsOpen.value = open
  if (!open) return
  panelOpen.value = false
  quickSettingsOpen.value = false
  ctxMenu.value = null
}

/**
 * 快捷设置面板开合（工具栏入口；与通知中心拆分的独立浏览面）。
 *
 * 与多任务 / 通知中心互斥（同 toggleRecents 口径）；打开时收掉其余浏览面。
 */
function toggleQuickSettings(open = !quickSettingsOpen.value): void {
  quickSettingsOpen.value = open
  if (!open) return
  panelOpen.value = false
  recentsOpen.value = false
  ctxMenu.value = null
}

/** 激活卡片（多任务面板点行）：MRU 置顶 + 切到对应路由（应用续接上次页面） */
function activateCard(key: CardKey): void {
  enterFace(key)
  void router.push(routeOf(key))
}

/**
 * 关卡片：应用卡 = **真停用**（deactivate 成功后才摘面——失败留卡，错误提示由
 * `showUserError` 统一发出，不静默丢运行中实例）；系统页卡 = 只关页面。
 * 关的是当前全屏面 → 切 MRU 次卡路由，无卡 → 回主屏。
 */
async function closeCard(key: CardKey, _silent = false): Promise<void> {
  if (cardKind(key) === 'app') {
    const appId = cardId(key)
    const apps = useShellApps()
    const ok = await apps.deactivate(appId)
    if (!ok) {
      // 失败提示已由 showUserError 统一发出（ADR 0030）；lastError 是错误码，不可展示
      return // 停用失败：卡片与运行面保留（不留「关了还在跑」的假象）
    }
    const app = apps.appOf(appId)
    if (app) {
      toast.success(t('shell.notif.stopped.toast', { name: app.name }))
    }
    // 实例已停用 = 用户关掉了这个应用：页面记忆随之作废（下次是全新开始），
    // 否则「关了再开」会莫名其妙跳回上次那页
    forgetAppRoute(appId)
  }
  cards.value = mruRemove(cards.value, key)
  if (activeCard.value === key) {
    if (cards.value.length) {
      activateCard(cards.value[0])
    } else {
      goHome()
    }
  }
}

/** 回主屏（清面态 + 路由回 '/'；后台实例与它们的页面记忆都保留） */
function goHome(): void {
  screen.value = 'home'
  activeCard.value = null
  panelOpen.value = false
  quickSettingsOpen.value = false
  recentsOpen.value = false
  ctxMenu.value = null
  homeQ.value = ''
  void router.push('/')
}

/** 返回：覆层按 z 序先收，耗尽后全屏 → 主屏 */
function goBack(): void {
  if (dialog.value) {
    dialog.value = null
    return
  }
  if (ctxMenu.value) {
    ctxMenu.value = null
    return
  }
  if (panelOpen.value) {
    panelOpen.value = false
    return
  }
  if (quickSettingsOpen.value) {
    quickSettingsOpen.value = false
    return
  }
  if (recentsOpen.value) {
    recentsOpen.value = false
    return
  }
  if (screen.value !== 'home') goHome()
}

/**
 * 全部关闭：一键清场——每个应用卡真停用（失败保留该卡并 toast），系统页卡直关；
 * 全部成功后回主屏 + 落一条事件通知。
 */
async function stopAllCards(): Promise<void> {
  const keys = [...cards.value]
  if (!keys.length) return
  const apps = useShellApps()
  let closedCount = 0
  const remaining: CardKey[] = []
  for (const key of keys) {
    if (cardKind(key) === 'sys') {
      closedCount += 1
      continue
    }
    const appId = cardId(key)
    const ok = await apps.deactivate(appId)
    if (ok) {
      closedCount += 1
      // 实例停用 = 应用被关掉：页面记忆随之作废
      forgetAppRoute(appId)
    } else remaining.push(key)
  }
  cards.value = remaining
  if (closedCount > 0) {
    pushNotif({
      kind: 'event',
      icon: 'layers',
      source: t('shell.notif.hostSource'),
      title: t('shell.notif.closeAll.title', { count: closedCount }),
      body: t('shell.notif.closeAll.body'),
    })
    toast.success(t('shell.notif.closeAll.toast', { count: closedCount }))
  }
  if (!cards.value.length) goHome()
}

/** 卡片标题（应用卡取应用名；系统页卡取系统页名） */
function cardTitleOf(key: CardKey): string {
  if (cardKind(key) === 'app') {
    return useShellApps().appOf(cardId(key))?.name ?? cardId(key)
  }
  const sys = sysPageOf(cardId(key))
  return sys ? t(sys.nameKey) : cardId(key)
}

// ==================== 审批 / 停用动作（真实生命周期；ShellDialogLayer / ContextMenu 消费） ====================

/**
 * 批准并启动（审批弹窗确认动作）：整单批准 → 激活 → 挂载运行面。
 * 批准成功后审批通知随派生源消失（无独立生命周期）。
 */
async function approveAndStart(appId: string): Promise<boolean> {
  const apps = useShellApps()
  const ok = await apps.approve(appId)
  if (!ok) {
    // 失败文案由 useShellApps → showUserError 统一发出（ADR 0030）；lastError 是错误码
    return false
  }
  dialog.value = null
  dialogAppId.value = null
  toast.success(t('shell.dialog.approval.success', { name: apps.appOf(appId)?.name ?? appId }))
  await openApp(appId)
  return true
}

/** 停用应用（真实动作：deactivate 真停用 + 摘运行面） */
async function stopApp(appId: string): Promise<void> {
  const key = appCardKey(appId)
  if (cards.value.includes(key)) {
    await closeCard(key)
  } else {
    // 无卡运行（后台运行但未产卡）：直接真停用
    const apps = useShellApps()
    const ok = await apps.deactivate(appId)
    if (ok) {
      forgetAppRoute(appId)
      const app = apps.appOf(appId)
      if (app) toast.success(t('shell.notif.stopped.toast', { name: app.name }))
    }
    // 失败同样已在 showUserError 内提示（ADR 0030），此处不重复
  }
}

/** 卸载应用（含数据清理确认由 ShellDialogLayer uninstall 分支呈现） */
async function uninstallApp(appId: string): Promise<void> {
  const apps = useShellApps()
  const ok = await apps.uninstall(appId)
  dialog.value = null
  dialogAppId.value = null
  if (ok) {
    forgetAppRoute(appId)
    // 同停用：应用没了，它的运行面不能留在栈里（否则返回时只剩「应用不存在」）
    cards.value = mruRemove(cards.value, appCardKey(appId))
    if (activeCard.value === appCardKey(appId)) {
      if (cards.value.length) activateCard(cards.value[0])
      else goHome()
    }
    const app = apps.appOf(appId)
    toast.success(t('shell.dialog.uninstall.success', { name: app?.name ?? appId }))
  }
  // 失败提示由 showUserError 统一发出（ADR 0030）；此处只负责关闭弹窗与摘卡
}

export function useShellState() {
  return {
    screen,
    cards,
    activeCard,
    hasAppSession,
    panelOpen,
    quickSettingsOpen,
    toggleQuickSettings,
    recentsOpen,
    toggleRecents,
    ctxMenu,
    dialog,
    dialogAppId,
    dialogResource,
    homeQ,
    notifs,
    notifCountTotal,
    pushNotif,
    dismissNotif,
    clearNotifs,
    approvalNotifs,
    openApp,
    openSys,
    activateCard,
    closeCard,
    goHome,
    goBack,
    stopAllCards,
    approveAndStart,
    stopApp,
    uninstallApp,
    cardTitleOf,
    syncFromRoute,
    routeOf,
  }
}
