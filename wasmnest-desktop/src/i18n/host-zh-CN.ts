/**
 * 宿主机制文案（中文）——桌面宿主前端下沉后由 app 前端持有
 *
 * 来源：宿主 `src/locales/zh-CN/{common,desktop,settings}.ts`（设备壳 shell.ts 与
 * 应用中心 desktop.plugin.* 随退役面删除）。本文件与 host-en.ts 由同一机制面迁移
 * 而来：全局错误信封（errors.*）、通用文案（common.*）、设置页平台分组
 * （settings.*）、工作台/服务器/启动画面/退出确认（desktop.*）。
 *
 * 授权弹窗文案从 `desktop.plugin.*` 迁入 `desktop.auth.*`：应用中心删除后
 * 「plugin」词汇退役，弹窗属安全闸门机制（fail-closed 语义不变，仅 key 换名）。
 */

export default {
  shell: {
    skipToContent: '跳到主内容',
    home: {
      where: '主屏',
      aria: '主屏',
      searchAria: '主屏搜索',
      appsTitle: '应用',
      installed: '已安装',
      noApps: '没有匹配「{q}」的应用',
      sysTitle: '系统',
      sysHint: '全局管理页面（从后台应用面板打开）',
      matches: '个匹配',
    },
    // 多任务面板（工具栏入口）：打开过 / 后台运行的面在此切换与关闭
    recents: {
      title: '后台应用',
      countUnit: '个',
      close: '收起后台应用',
      closeAll: '全部关闭',
      empty: '没有后台运行的应用',
      open: '切换到 {name}',
      closeOne: '关闭 {name}',
      stopInstance: '停止实例',
      closePage: '关闭页面',
      sysPage: '系统页',
      resumedHint: '应用实例留在后台运行，点按会回到它上次停留的页面；✕ 是真正关闭实例。',
    },
    state: {
      running: '运行中',
      degraded: '降级',
      dormant: '未启动',
      approval: '待审批',
      error: '错误',
    },
    nav: {
      back: '返回',
      backTitle: '返回（Esc）',
      tasks: '后台应用',
      tasksTitle: '后台应用：{count} 个在运行',
      home: '主屏',
      homeTitle: '回到主屏（应用继续在后台运行）',
    },
    toolbar: {
      notifs: '通知中心，{count} 条',
      notifsTitle: '通知中心（{count} 条）',
      quickSettings: '快捷设置',
      themeToLight: '切换到浅色',
      themeToDark: '切换到深色',
      minimize: '最小化',
      maximize: '最大化',
      close: '关闭窗口',
    },
    statusBar: {
      aria: '平台状态栏',
      ready: '运行时就绪',
      loading: '正在加载',
      apps: '{count} 个应用',
      approvals: '{count} 项待审批',
      openPerms: '打开权限与授权',
    },
    app: {
      stop: '停用',
      subCommands: '{count} 个命令',
      approval: {
        title: '等待权限审批',
        desc: 'manifest 声明 {perms} 个权限位，其中 {risks} 个高危位。批准是整单裁决，不做逐位勾选。',
        viewPerms: '查看权限详情',
        approveStart: '批准并启动',
      },
      error: {
        title: '应用错误',
        desc: '该应用启动失败（实例未在运行）。可在应用管理页查看详情后重试。',
        backHome: '返回主屏',
      },
      dormant: {
        desc: '应用未启动。启动后将以全屏卡片打开。',
        start: '启动并打开',
      },
      noView: {
        desc: '该应用没有可挂载的宿主视图，请从应用管理页查看其能力。',
        backHome: '返回主屏',
      },
    },
    sys: {
      chip: '系统页 · 卡片',
      apps: {
        name: '应用管理',
        desc: '安装 · 启停 · 卸载 · 配置',
      },
      perms: {
        name: '权限与授权',
        desc: '策略档位 · 授权记录 · 权限位',
      },
      settings: {
        name: '设置',
        desc: '界面 · 背景 · 皮肤 · 系统 · 扩展 · 关于',
      },
    },
    quickSettings: {
      title: '快捷设置',
      close: '收起快捷设置',
      on: '开',
      off: '关',
      tileTheme: '深色主题',
      tileAnim: '动画',
      tileCrypto: '链路加密',
      tileSleep: '防止休眠',
    },
    notif: {
      title: '通知中心',
      countUnit: '条',
      close: '收起通知中心',
      clearAll: '清除全部',
      empty: '没有通知',
      pending: '待处理',
      notifications: '通知',
      dismiss: '关闭通知：{title}',
      justNow: '刚刚',
      minutesAgo: '{mins} 分钟前',
      hostSource: '宿主',
      approval: {
        title: '等待权限审批',
        body: 'manifest 声明 {perms} 个权限位（{risks} 个高危），批准后才会激活。',
        go: '去审批',
      },
      stopped: {
        title: '已停止',
        body: '实例已停用，可在主屏重新打开。',
        toast: '{name} 已停止',
      },
      started: {
        title: '已启动',
        body: '{name} 已激活并挂载运行面',
      },
      uninstalled: {
        title: '已卸载',
        body: '{name} 及其数据已移除',
      },
      approved: {
        title: '已批准并启动',
        body: '审批通知随之消失（派生自待审批清单，无独立生命周期）。',
      },
      closeAll: {
        title: '已关闭 {count} 张卡片',
        body: '应用实例已全部停用，系统页已关闭。',
        toast: '已关闭 {count} 张卡片',
      },
      open: '查看',
      reopen: '重新打开',
      ready: {
        title: '运行时就绪',
        body: '已加载 {count} 个应用，授权策略层 fail-closed 自检通过。',
      },
    },
    ctx: {
      aria: '应用操作菜单',
      open: '打开',
      startOpen: '启动并打开',
      manage: '应用管理',
      perms: '权限与授权',
      stop: '停用',
      uninstall: '卸载',
      uninstallDisabled: '请先停用应用后再卸载',
    },
    dialog: {
      close: '关闭弹窗',
      cancel: '取消',
      approval: {
        title: '批准「{name}」',
        desc: 'manifest 声明 {perms} 个权限位。批准是整单裁决——逐位勾选会让高危位混在低位里被顺手放行。',
        afterHint: '批准后返回实际授予的权限位清单；未授予的位在运行期仍被闸门拒绝。',
        approving: '批准中…',
        confirm: '批准并启动',
        success: '{name} 已批准并启动',
      },
      strategy: {
        title: '切换为「始终允许」？',
        body: '「{name}」的{resource}请求将不再询问：没记录过的目标会直接放行，并以「未经确认」记入授权记录。切档不会一次性授予全部权限，只有该应用实际访问到的目标才会逐步累积。',
        confirm: '确认切换',
      },
      uninstall: {
        title: '卸载「{name}」？',
        body: '将删除安装目录、插件存储与启用状态，不可恢复。授权记录随之清除。',
        confirm: '确认卸载',
        success: '{name} 已卸载',
      },
      exit: {
        title: '退出 WasmNest？',
        desc: '以下应用仍在运行：',
        none: '没有应用在运行，可直接退出。',
        confirm: '仍然退出',
      },
    },
    settings: {
      ui: {
        title: '界面',
        themeLight: '浅色',
        themeDark: '深色',
        themeSystem: '跟随系统',
        language: '语言',
        fontSize: '字号',
        animations: '动画',
        animationsDesc: '屏幕切换与覆层动效（关闭即降级）',
      },
      background: {
        title: '背景',
        wallLabel: '壁纸',
        dimLabel: '遮罩强度 · {pct}%',
        customReplace: '更换图片…',
        customRemove: '移除',
        customHint: 'PNG / JPG / WebP，单张不超过 20 MB；图片会复制到应用数据目录。',
        customSaved: '自定义壁纸已更新',
        customRemoved: '自定义壁纸已移除',
        wall: {
          none: '无（纯色）',
          aurora: '极光',
          dune: '沙丘',
          reef: '礁湖',
          custom: '自定义',
        },
      },
      permsEntry: {
        title: '授权管理',
        desc: '策略档位与授权记录',
        hint: '安全闸门的管理入口，完整记录见「权限与授权」页',
        open: '打开权限与授权',
      },
      skins: {
        title: '主题皮肤',
        desc: '平台外壳的配色方案；应用仍可自持配色。',
        default: '默认',
        defaultDesc: '跟随平台默认色板',
        hint: '皮肤只覆盖平台外壳的 CSS 变量；应用根容器自己声明的配色优先。',
      },
      extensions: {
        title: '扩展设置',
        desc: '为平台扩展预留的设置位；应用级设置仍归各应用。',
        empty: '预留区域 · 暂无扩展设置项',
        hint: '扩展注册后自动出现；停用或卸载时一并摘除。',
      },
    },
    perms: {
      pending: '{count} 个应用待审批',
      pendingHint: '审批是整单裁决——逐位勾选会让「高危位混在低位里被顺手放行」。',
      pendingGo: '去审批',
      appMeta: '{perms} 权限位 · {risks} 高危 · {records} 条授权记录',
      manage: '管理',
      secUser: '已授权 {count}',
      secAuto: '免询问放行 {count}',
      secFirstParty: '内置免询问 {count}',
      secDeny: '硬拒绝 {count}',
    },
    apps: {
      sortHint:
        '按授权风险排序（「始终允许」最宽松置顶）。运行中的应用不可卸载；启用方向先过审批门。',
      listAria: '已安装应用列表',
      install: '安装应用',
      installDesc: '本地 zip（plugin_install_from_file）',
      installToast: '安装应用：请选择本地 zip 包（正式链路待接入）',
      kvSource: '来源',
      kvSize: '体积',
      kvViews: '视图',
      kvType: '类型',
      approveStart: '批准并启动',
      stop: '停用',
      open: '打开',
      startOpen: '启动并打开',
      uninstall: '卸载',
      uninstallDisabled: '请先停用应用后再卸载',
      approvalCallout: '待审批：manifest 声明 {perms} 个权限位（{risks} 个高危）。批准是整单裁决。',
      strategyTitle: '授权策略',
      strategyHint: '策略切换不追溯已落账记录；收紧需逐条撤销。完整记录见「权限与授权」。',
      permsTitle: '权限位（manifest 声明 · 加载期整单裁决 · 只读）',
      permsHint: '高危位标红：可执行任意命令 / 读写主库。',
      configTitle: '应用配置',
      configEmpty: '无可用的配置项（manifest contributes.configuration.properties 为空）。',
      configSave: '保存',
      configReset: '重置为默认',
      configSaved: '配置已保存（写入插件存储）',
      noSelection: '选择一个应用查看详情',
      // 2026-10-17 壳恢复后（生命周期归宿主，前端无启停）：应用管理收敛为只读面目录
      // 应用整包挂载面（ADR 0057 机制 B）：加载 / 失败两态文案。此前组件直接引用
      // 未注册的 key，界面回显 `shell.apps.loading` 原文。
      loading: '应用界面加载中…',
      mountFailed: '应用界面加载失败，可重试；若持续失败请查看日志',
      // 失败态只给壳自有文案，后端原文（WASM/linker 报错）只进日志（ADR 0030）
      errorHint: '应用启动失败（实例未在运行）：可再次启动，或先到「权限与授权」核对授权后重试',
      enabled: '启用',
      enabledHint: '已启用 = 应用可用（偏好记录，不驱动启动）',
      autostart: '自启',
      autostartHint: '启动时自动激活（只改偏好，下次启动生效）',
      surfaceHint: '宿主运行面：{route}',
      permCardTitle: '权限与授权',
      permHint: '策略分档、授权记录与内置免询问项的查看与管理，与设置页「应用授权」同一口径。',
      permGo: '进入权限与授权',
      source: {
        builtin: '内置',
        scanned: '已扫描',
        wasm: 'WASM',
        user: '本地安装',
      },
    },
    boot: {
      line: 'WasmNest · wasm-app 平台启动中',
      skip: '点击任意处跳过',
      stepRegistry: '已装应用注册表加载（{count}）',
      stepAuth: '授权策略层 fail-closed 自检',
      stepReady: '运行时就绪',
    },
  },
  common: {
    button: {
      cancel: '取消',
      stop: '停止',
    },
    status: {
      error: '错误',
      unknown: '未知',
      running: '运行中',
      stopped: '已停止',
      asking: '等待输入',
      starting: '启动中',
    },
    misc: {
      terminalTitle: '终端 - {name}',
    },
  },
  // ==================== 错误信封（ADR 0030）====================
  // 顶层命名空间 errors.<code> ↔ 信封 code，零映射层；改码 = 破坏性变更。
  // UI 呈现规则：toast / 页面只显示友好文案（模板 + params 插值），永不显示错误码 / request_id / 技术详情。
  errors: {
    retry: '重试',
    host: {
      internal: '操作未完成，请稍后重试',
      invoke: {
        timeout: '操作超时，请重试',
      },
      // 机制码（ADR 0030 注册表 v0）：应用管理面机制失败 + 运行时段（事件通道信封）
      // ——同一 kind 对用户是同一件事 → 同一文案；插值参数只允许应用显示名
      plugin: {
        'not-activated': '该应用未启用，无法执行此操作',
        'not-found': '应用不存在或已卸载',
        trap: '应用「{name}」运行异常，已尝试自动恢复',
        'recovery-failed': '应用「{name}」运行异常且未能自动恢复，请到应用中心处理',
        'self-check-failed': '应用「{plugin}」启动自检失败，请检查配置',
        degraded: '应用「{name}」降级运行，部分功能不可用',
      },
    },
    frontend: {
      internal: '操作未完成，请稍后重试',
    },
    shell: {
      wallpaper: {
        invalid: '无法使用这张图片：请选择 PNG / JPG / WebP，且不超过 20 MB',
      },
    },
  },
  desktop: {
    splash: {
      status: '正在启动…',
      tagline: '多 WASM 应用运行平台',
    },
    sidebar: {
      settings: '设置',
      navigation: '导航',
      serviceRunning: '服务运行中',
      serviceStopped: '服务已停止',
      serviceStarting: '服务启动中',
      collapse: '收起侧边栏',
      expand: '展开侧边栏',
    },
    // 全局未捕获异常的兜底文案（renderer errorHandler / unhandledrejection）
    runtimeUnexpected: '发生了未知错误，详情见日志',
    // 窗口控制三键的 tooltip 随应用自绘标题栏一起退役（标题栏归壳常驻，
    // 壳用 shell.toolbar.*；终端窗口内的文案归 app 域 session.terminal.*）
    // 退出确认（window-close-requested 透传运行中会话清单）
    session: {
      confirmExitTitle: '确认退出',
      confirmExitMsg: '以下 {count} 个会话仍在运行，退出后将终止所有运行中的进程。',
      confirmExitForce: '强制退出',
    },
    server: {
      title: '服务器管理',
      sectionStatus: '状态',
      sectionNetwork: '网络',
      port: '端口',
      portHint: '修改后在下次服务启动时生效',
      surfaceHint: '服务随应用界面启停；关闭最后一个应用后停止对外广播',
      portSave: '保存',
      portRestartConfirmTitle: '保存端口',
      portRestartConfirmBody: '端口修改需要重启服务器后才能生效，是否立即重启？',
      portRestartNow: '立即重启',
      portRestartLater: '稍后重启',
      portSavedDelayed: '端口已保存，将在服务器下次启动时生效',
      portRestartApplied: '端口已更新，服务器已重启生效',
      localIp: '本地 IP',
      autoStart: '自启动',
      start: '启动',
      stop: '停止',
      restart: '重启',
      status: {
        running: '运行中',
        stopped: '已停止',
        starting: '启动中',
      },
      monitoring: '性能监控',
      uptime: '运行时长',
      connections: '连接数',
      totalRequests: '总请求数',
      cpuUsage: 'CPU 占用',
      memoryUsage: '内存占用',
      requestRate: '请求速率',
      wsThroughput: 'WS 消息吞吐',
      wsSentRate: '发送速率',
      wsRecvRate: '接收速率',
      startSuccess: '服务器已启动',
      stopSuccess: '服务器已停止',
      restartSuccess: '服务器已重启',
      // 错误信封化后去 {error} 插值（技术详情禁止上用户可见面，ADR 0030）；
      // 具体失败详情由 showUserError → errors.host.* 统一呈现，这三个 key 保留为静态兜底文案
      startFailed: '启动失败，请稍后重试',
      stopFailed: '停止失败，请稍后重试',
      restartFailed: '重启失败，请稍后重试',
      advancedConfig: '高级配置',
      workers: 'Worker 线程数',
      workersHint: '0 = 自动（CPU 核心数）',
      keepAlive: 'Keep-Alive 超时',
      keepAliveHint: '秒，0 = 禁用',
      clientRequestTimeout: '请求头超时',
      clientDisconnectTimeout: '断开超时',
      maxConnections: '最大连接数',
      maxConnectionsHint: '每 worker',
      backlog: 'TCP Backlog',
      tcpNodelay: 'TCP_NODELAY',
      shutdownTimeout: '停机超时',
      wsMaxFrameSize: 'WS 帧大小',
      wsMaxFrameSizeHint: 'KB',
      wsMaxMessageSize: 'WS 消息大小',
      wsMaxMessageSizeHint: 'MB',
      resetDefaults: '还原默认',
      resetSuccess: '已还原为默认配置，重启服务器后生效',
      collapse: '收起',
      expand: '展开',
    },
    // 未匹配路由兜底页（D3 fail-visible：退役面直接访问时显性 not-found）
    notFound: {
      title: '页面不存在',
      body: '你访问的页面不存在或已随版本更新移除',
      back: '返回终端会话',
    },
    // ==================== 授权弹窗（安全闸门，fail-closed）====================
    // 文件系统授权（票 03 起三档 + 记住）+ 网络出站授权（票 05，origin 粒度）。
    // 应答经宿主面命令（需宿主凭证），前端只做展示与决定回传。
    auth: {
      fsAuthTitle: '文件访问授权',
      fsAuthRead: '读取',
      fsAuthWrite: '写入',
      // 授权记录按操作拆分，弹窗要说清这次要的是读、写还是两者
      fsAuthReadWrite: '读写',
      fsAuthRequest: '应用 {plugin} 请求{operation}文件',
      fsAuthPickerRequest: '你刚在系统选择框中选中以下路径，应用 {plugin} 请求{operation}',
      fsAuthGrantScopeDir:
        '勾选「记住」将按所在目录授权：该目录下其它文件的{operation}以后不再询问',
      fsAuthPath: '文件路径',
      fsAuthPaths: '文件路径（{count} 个目录）',
      // 「记住」只记这次的操作（读 / 写 / 读写），文案必须跟着说清
      fsAuthRemember: '记住此路径的{operation}授权，下次自动放行',
      fsAuthAllow: '允许',
      fsAuthDeny: '拒绝',
      // 应答三态：「总是询问」档不提供「记住」，允许按钮只能承诺这一次；
      // 「以后都拒绝」落 deny 记录（该目标与其子树此后被直接拒绝）
      fsAuthAllowOnce: '允许本次',
      fsAuthDenyAlways: '以后都拒绝',
      netAuthTitle: '网络访问授权',
      netAuthRequest: '应用 {plugin} 请求访问一个网络地址',
      netAuthOrigin: '地址',
      // 同意 = 此地址此后免询问：授权范围必须让用户看得见，否则只能靠猜
      netAuthScope: '同意后，该地址（此主机与端口）以后不再询问；拒绝可在「设置 → 应用授权」里撤销',
      // 「总是询问」档下的同一处说明：该档不落记录，说「以后不再询问」就是在骗用户
      netAuthScopeOnce: '只放行这一批请求；该应用处于「总是询问」，下次访问仍会询问',
      netAuthAllow: '允许',
      netAuthDeny: '拒绝',
      netAuthDenyAlways: '以后都拒绝',
    },
  },
  settings: {
    title: '设置',
    linkCrypto: {
      title: '链路加密',
      master: '启用链路加密',
      masterDesc: '对局域网传输的报文端到端加密；默认关闭，开启前请先在移动端完成配对',
      encryptHttp: '加密 HTTP 载荷',
      encryptHttpDesc: 'REST 请求/响应体信封加密（终端输入回传等）',
      encryptWsTerminal: '加密终端通道',
      encryptWsTerminalDesc: 'WS 终端帧加解密（PTY 输出流）',
      encryptWsEvent: '加密事件通道',
      encryptWsEventDesc: 'WS 事件帧加解密（同步事件广播）',
      plaintextFallback: '允许明文回退',
      plaintextFallbackDesc: '未协商的老客户端放行明文；关闭后非本机未协商请求一律拒绝',
      fingerprint: '本机指纹',
      fingerprintDesc: '本机身份密钥指纹（SHA-256 前 16 位），请与移动端展示值人工比对',
      saveFailed: '链路加密配置保存失败',
    },
    system: {
      title: '系统设置',
      preventSleep: '防止系统休眠',
    },
    log: {
      title: '日志设置',
      level: '日志级别',
      levelDebug: '调试',
      levelInfo: '信息',
      levelWarn: '警告',
      levelError: '错误',
      levelApplied: '日志级别已切换',
      format: '日志格式',
      formatText: '文本',
      formatJson: 'JSON',
      maxFiles: '保留文件数',
      capacityMb: '容量上限（MB）',
      persist: '持久化配置',
      openDir: '打开日志目录',
      save: '保存配置',
      saved: '日志配置已保存',
      saveFailed: '日志配置保存失败',
    },
    // 授权策略与记录（2026-09-27 授权策略增强 · 票 01）：设置页二级入口「应用授权」
    // 与授权管理页文案。档位措辞与 spec §4.1 逐字一致；resource 分类名对应宿主
    // 读模型的 resource 值（fs / network）在界面上的说法
    authorization: {
      title: '应用授权',
      entry: '应用授权记录',
      back: '返回设置',
      refresh: '刷新',
      appCount: '{count} 个应用',
      empty: '暂无可管理的应用',
      emptyHint: '安装并启用应用后，这里会列出它们的授权情况',
      recordCount: '{count} 条记录',
      records: {
        toggle: '展开授权记录',
        fsTitle: '文件目录记录',
        networkTitle: '网络地址记录',
        empty: '该应用还没有文件授权记录',
        fsEmpty: '该应用还没有文件授权记录',
        networkEmpty: '该应用还没有网络授权记录',
        revoke: '取消授权',
        removeDeny: '移除拒绝',
        revoked: '已取消该目录的授权，后续访问会被直接拒绝',
        networkRevoked: '已取消该地址的授权，后续请求会被直接拒绝',
        denyRemoved: '已移除拒绝记录，该目录回到未授权状态',
        effect: {
          allow: '已授权',
          deny: '硬拒绝',
        },
        ops: {
          read: '读',
          write: '写',
          read_write: '读写',
        },
        source: {
          user: '用户确认',
          always_allow: '免询问自动放行',
          legacy: '旧版遗留',
          user_deny: '用户拒绝',
        },
      },
      // 四分区标题与空态（票 07 详情页 / 票 08 设置页共用，spec §9.2）：
      // 用户已授权 / 免询问自动放行（未经确认）/ 内置免询问（第一方）/ 硬拒绝
      sections: {
        userGranted: '用户已授权',
        autoAllowed: '免询问自动放行',
        firstParty: '内置免询问',
        denied: '硬拒绝',
        // 免询问自动放行记录必须带「未经确认」标记并与用户确认记录视觉区分（spec §9.4）
        unconfirmed: '未经确认',
        empty: '暂无授权记录',
        // 内置免询问项的两种形态（第一方清单：home 前缀 / 任意项目的具名段）
        firstPartyHome: '家目录',
        firstPartySegment: '项目目录',
        revokeHint: '撤销后该目录后续访问会被直接拒绝',
        // 该应用没有内置免询问项时的空态（与「有项」区分：空态是事实，不是缺数据）
        firstPartyEmpty: '该应用没有内置免询问项',
        firstPartyRevoked: '已取消该目录的免询问，后续访问会被直接拒绝',
      },
      strategy: {
        always_ask: '总是询问',
        default: '默认',
        always_allow: '始终允许',
      },
      // 策略控件（票 03 起，票 04 放开「始终允许」）：三档都可选；切到「始终允许」
      // 走二次确认，确认文案必须说清该档的语义边界（spec §4.3）——切档**不**一次性
      // 授予全部权限，只有实际访问到的目标才逐步累积进记录（可持续累积，故仍要提示）
      strategyControl: {
        title: '{resource}请求策略',
        saved: '策略已更新，下一次判定立即生效',
        hint: {
          // 「总是询问」跳过全部 allow 记录，所以已授权过的目标也照问——
          // 写成「未记录的目标都会询问」会让用户以为已授权的静默通过（票 06 修正）
          always_ask: '每次访问都询问（已授权过的目标也照问）',
          default: '记录命中即放行，未记录才询问',
          always_allow: '未记录的目标免询问放行，并自动记录（未经确认）',
        },
        confirmTitle: '改为「始终允许」？',
        // 语义边界（spec §4.3）必须出现在确认里：用户以为「一次点开全盘」与
        // 以为「什么都不会发生」都是错的认知
        confirmBody:
          '「{name}」的{resource}请求将不再询问：没记录过的目标会直接放行，并以「未经确认」记入授权记录。切档不会一次性授予全部权限，只有该应用实际访问到的目标才会逐步累积——持续访问会让这份清单持续变长，可随时在下方逐条取消授权。',
        confirmOk: '改为始终允许',
      },
      resource: {
        fs: '文件',
        network: '网络',
      },
    },
    ui: {
      title: '界面设置',
    },
    appearance: {
      theme: '主题',
      palette: '主题色板',
      paletteWarm: '暖调工作台',
      paletteCool: '冷灰调',
      paletteForest: '森野绿',
      paletteOcean: '海洋青',
      paletteSunset: '落日晚霞',
      paletteViolet: '星空紫',
      paletteDesc: '全局配色风格，切换即时生效',
      lightMode: '浅色模式',
      darkMode: '深色模式',
      followSystem: '跟随系统',
      language: '语言',
      fontSize: '字体大小',
      animations: '动画效果',
      animationsDesc: '关闭后全局禁用页面切换与交互过渡动画',
    },
    about: {
      title: '关于',
      githubRepo: 'GitHub 仓库',
      checkUpdate: '检查更新',
      alreadyLatest: '已是最新版本',
      checkingUpdate: '正在检查更新...',
      checkFailed: '检查更新失败，请稍后重试',
      newVersionAvailable: '发现新版本',
      downloadingUpdate: '正在下载更新...',
      downloadComplete: '下载完成，正在安装...',
      installingUpdate: '正在安装更新...',
      downloadUpdate: '立即更新',
    },
    reset: {
      title: '恢复初始设置',
      desc: '清除应用授权记录与个性化偏好，恢复默认设置',
      action: '恢复初始设置',
      confirmTitle: '恢复初始设置',
      confirmBody:
        '将清除所有应用的授权记录，删除已复制的自定义壁纸，并把全部设置恢复为默认值。此操作无法撤销。',
      confirmOk: '恢复',
      done: '已恢复初始设置',
      failed: '恢复失败，请稍后重试',
    },
  },
}
