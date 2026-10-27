export default {
  settings: {
    title: 'Settings',
    // Ticket 2026-10-10: `general` / `dangerZone` retired with the `actions` group
    // (no UI callers left). 2026-10-14: the device-level wipe copy moved into this
    // file's `about` group (entry moved from platform settings to "About WasmNest").
    ui: {
      title: 'UI Settings',
      terminalFontSize: 'Terminal Font Size',
    },
    appearance: {
      title: 'Appearance',
      subtitle: 'Theme, language, font and home background',
      // Terminology (2026-10-27): "theme" means the preset only; light/dark is
      // called "colour mode" so one screen never has two things named Theme.
      theme: 'Theme',
      colorMode: 'Colour mode',
      lightMode: 'Light Mode',
      darkMode: 'Dark Mode',
      followSystem: 'Follow System',
      themePresetSection: 'Theme',
      themeDefault: 'Default',
      themeDefaultDesc: 'Warm workbench, solid surfaces',
      themeDiffuse: 'Diffuse glass',
      themeDiffuseDesc: 'Soft haze, large radii',
      themeLiquid: 'Liquid glass',
      themeLiquidDesc: 'High-saturation refraction, specular edge',
      themeHyper: 'Hyper colour',
      themeHyperDesc: 'Saturated blocks, hard shadows',
      themeDynamic: 'Animated',
      themeHint:
        'Themes cover the platform shell and icon language; palettes declared by an app root take precedence.',
      language: 'Language',
      languageChinese: '中文',
      languageEnglish: 'English',
      fontSize: 'Font Size',
      fontNormal: 'Normal',
      fontLarge: 'Large',
      fontXLarge: 'Extra Large',
      generalSection: 'General',
      displaySection: 'Display',
      // Host wallpaper (moved from the shell settings page on 2026-10-15: background
      // belongs to appearance config, same screen as theme mode; since 2026-10-23
      // it applies to the whole host, matching the desktop shell. Gradient & dim
      // preview logic live in styles/wallpaper.css, shared with the shell root)
      backgroundSection: 'Host background',
      backgroundNote: 'Applies to the whole host',
      wallNone: 'None',
      wallAurora: 'Aurora',
      wallDune: 'Dune',
      wallReef: 'Reef',
      wallCustom: 'Custom',
      wallPick: 'Choose from gallery',
      wallReplace: 'Replace image',
      wallRemove: 'Remove image',
      wallDim: 'Overlay strength',
    },
    // Ticket 2026-10-10 C4: the whole `notification` group is retired — every entry is a
    // business setting, now owned by the bedcode app; the
    // `mobile-settings-notifications` route retires with it.
    about: {
      title: 'About',
      subtitle: 'Version info and updates',
      infoSection: 'Info',
      updateSection: 'Updates',
      githubRepo: 'GitHub Repository',
      checkUpdate: 'Check for Updates',
      alreadyLatest: 'Already on the latest version',
      checkingUpdate: 'Checking for updates...',
      newVersionAvailable: 'New version available',
      updateCheckFailed: 'Update check failed',
      downloadingUpdate: 'Downloading update...',
      downloadComplete: 'Download complete, installing...',
      installingUpdate: 'Installing update...',
      downloadUpdate: 'Update Now',
      currentVersion: 'Current Version',
      // Danger zone (2026-10-14 revision): moved here from the top-level platform
      // settings page. Its targets include device entry credentials and host
      // connection state, so only the host may run it. See useClearAllData.ts.
      dangerZone: 'Danger Zone',
      clearAllData: 'Clear All Data',
      clearAllDataHint:
        'Disconnects and wipes preset tasks, connection history, paired devices, session configs and local cache. This cannot be undone.',
      clearAllDataFailed: 'Cleanup did not finish; some data may remain. Retry or restart the app.',
    },
    // Ticket 2026-10-10: the `actions` group retired; both actions were moved by
    // ownership — "reset settings" to the bedcode app, "clear all data"
    // to this file's about group (device-level wipe, host-owned).
    browser: {
      confirmOpen: 'Are you sure you want to open this link in a browser?',
    },
  },
}
