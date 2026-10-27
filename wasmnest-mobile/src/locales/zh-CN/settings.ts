export default {
  settings: {
    title: '设置',
    // 票 2026-10-10：`general` / `dangerZone` 随 `actions` 组一并退役（零 UI 调用）。
    // 2026-10-14：设备级擦除的文案迁入本文件 `about` 组的 dangerZone 系列
    // （入口从平台设置一级页迁到「关于 WasmNest」）。
    ui: {
      title: '界面设置',
      terminalFontSize: '终端字体大小',
    },
    appearance: {
      title: '外观',
      subtitle: '主题、语言、字体与宿主背景',
      // 术语（2026-10-27）：`theme` 一词只指「主题预设」（整套外观语汇）；
      // 深浅色改称「明暗模式」，避免同一页两个「主题」。
      theme: '主题',
      colorMode: '明暗模式',
      lightMode: '浅色模式',
      darkMode: '深色模式',
      followSystem: '跟随系统',
      themePresetSection: '主题',
      themeDefault: '默认',
      themeDefaultDesc: '暖调工作台，实心卡面',
      themeDiffuse: '弥散玻璃',
      themeDiffuseDesc: '柔光雾面，大圆角',
      themeLiquid: '液态玻璃',
      themeLiquidDesc: '高饱和折射，镜面高光',
      themeHyper: '超色彩主义',
      themeHyperDesc: '高饱和色块，硬边投影',
      themeDynamic: '动态',
      themeHint: '主题覆盖平台外壳与图标语汇；应用根容器自己声明的配色优先。',
      language: '语言',
      languageChinese: '中文',
      languageEnglish: 'English',
      fontSize: '字体大小',
      fontNormal: '正常',
      fontLarge: '大',
      fontXLarge: '超大',
      generalSection: '通用',
      displaySection: '显示',
      // 宿主壁纸（2026-10-15 由壳设置页迁入：背景属外观配置，与主题深浅同屏；
      // 2026-10-23 起背景全宿主生效，与桌面壳同口径。档位渐变/遮罩预览逻辑
      // 在 styles/wallpaper.css，与壳根同源）
      backgroundSection: '宿主背景',
      backgroundNote: '全宿主生效',
      wallNone: '无',
      wallAurora: '极光',
      wallDune: '沙丘',
      wallReef: '礁湖',
      wallCustom: '自定义',
      wallPick: '从相册选择',
      wallReplace: '更换图片',
      wallRemove: '移除图片',
      wallDim: '遮罩强度',
      // 票 2026-10-10 C4：terminalSection / maxOpenTerminals 随「终端上限」这一业务项
      // 下沉 bedcode 应用，外观页只留平台项。
    },
    // 票 2026-10-10 C4：notification 整组退役——通知三开关 / 振动 / 提示音皆业务项，
    // 已下沉 bedcode 应用的设置页，`mobile-settings-notifications` 路由同批退役。
    about: {
      title: '关于',
      subtitle: '版本信息与更新',
      infoSection: '信息',
      updateSection: '更新',
      githubRepo: 'GitHub 仓库',
      checkUpdate: '检查更新',
      alreadyLatest: '已是最新版本',
      checkingUpdate: '正在检查更新...',
      newVersionAvailable: '发现新版本',
      updateCheckFailed: '检查更新失败',
      downloadingUpdate: '正在下载更新...',
      downloadComplete: '下载完成，正在安装...',
      installingUpdate: '正在安装更新...',
      downloadUpdate: '立即更新',
      currentVersion: '当前版本',
      // 危险操作（2026-10-14 修订）：从平台设置一级页迁入「关于 WasmNest」。
      // 擦除对象含设备入场凭据与宿主连接态，按 §8 凭据零过境只能由宿主执行，
      // 实现见 src/composables/useClearAllData.ts。
      dangerZone: '危险操作',
      clearAllData: '清除所有数据',
      clearAllDataHint: '断开连接并清空预设任务、连接历史、配对设备、会话配置与本机缓存，无法撤销。',
      clearAllDataFailed: '清除未完成，部分数据可能仍在，请重试或重启应用。',
    },
    // 票 2026-10-10：`actions` 组整组退役。两个 action 已按归属分流：
    // 「重置设置」→ wasm-apps/bedcode/src/settings/i18n.ts（重置业务设置项）；
    // 「清除所有数据」→ 本文件 about 组的 dangerZone 系列（设备级擦除，留宿主）。
    browser: {
      confirmOpen: '确定要在浏览器中打开此链接吗？',
    },
  },
}
