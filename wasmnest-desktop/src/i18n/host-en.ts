/**
 * Host mechanism copy (English) — held by the app frontend after the desktop
 * host-frontend downsink.
 *
 * Source: host `src/locales/en/{common,desktop,settings}.ts` (device-shell
 * shell.ts and the app-center desktop.plugin.* group retired with the
 * retirement surface). Migrated together with host-zh-CN.ts as one mechanism
 * face: global error envelope (errors.*), common copy (common.*), settings
 * platform sections (settings.*), workbench/server/splash/exit-confirm
 * (desktop.*).
 *
 * Authorization dialog copy moved from `desktop.plugin.*` to `desktop.auth.*`:
 * the "plugin" vocabulary retires with the app center; the dialogs are
 * security-gate mechanisms (fail-closed semantics unchanged, key renamed only).
 */

export default {
  shell: {
    skipToContent: 'Skip to content',
    home: {
      where: 'Home',
      aria: 'Home screen',
      searchAria: 'Search on home',
      appsTitle: 'Apps',
      installed: 'installed',
      noApps: 'No apps match "{q}"',
      noneEnabled: 'No enabled apps (re-enable them in App management)',
      sysTitle: 'System',
      sysHint: 'Global management pages (open from Background apps)',
      matches: 'matches',
    },
    // Recent-tasks panel (toolbar entry): opened / background faces switch and close here
    recents: {
      title: 'Background apps',
      countUnit: 'running',
      close: 'Hide background apps',
      closeAll: 'Close all',
      empty: 'No apps running in the background',
      open: 'Switch to {name}',
      closeOne: 'Close {name}',
      stopInstance: 'Stop instance',
      closePage: 'Close page',
      sysPage: 'System page',
      resumedHint:
        'App instances keep running in the background; tapping one returns to the page it was last on. ✕ really closes the instance.',
    },
    state: {
      running: 'Running',
      degraded: 'Degraded',
      dormant: 'Idle',
      approval: 'Approval needed',
      error: 'Error',
    },
    nav: {
      back: 'Back',
      backTitle: 'Back (Esc)',
      tasks: 'Background',
      tasksTitle: 'Background apps: {count} running',
      home: 'Home',
      homeTitle: 'Home: apps keep running in the background',
    },
    toolbar: {
      notifs: 'Notifications, {count}',
      notifsTitle: 'Notification center ({count})',
      quickSettings: 'Quick settings',
      themeToLight: 'Switch to light',
      themeToDark: 'Switch to dark',
      minimize: 'Minimize',
      maximize: 'Maximize',
      close: 'Close window',
    },
    statusBar: {
      aria: 'Platform status bar',
      ready: 'Runtime ready',
      loading: 'Loading',
      apps: '{count} apps',
      approvals: '{count} pending',
      openPerms: 'Open permissions & authorization',
    },
    app: {
      stop: 'Stop',
      subCommands: '{count} commands',
      approval: {
        title: 'Waiting for permission approval',
        desc: 'manifest declares {perms} permission bits, {risks} of them high-risk. Approval is all-or-nothing; no per-bit selection.',
        viewPerms: 'View permission details',
        approveStart: 'Approve & start',
      },
      error: {
        title: 'App error',
        desc: 'This app failed to start (instance not running). See App Manager for details and retry.',
        backHome: 'Back to home',
      },
      dormant: {
        desc: 'App is not running. Starting opens it as a fullscreen card.',
        start: 'Start & open',
      },
      noView: {
        desc: 'This app has no host-mountable view. Check its capabilities in App Manager.',
        backHome: 'Back to home',
      },
    },
    sys: {
      chip: 'System page · Card',
      apps: {
        name: 'App Manager',
        desc: 'Install · start/stop · uninstall · configure',
      },
      perms: {
        name: 'Permissions & Authorization',
        desc: 'Policy tiers · auth records · permission bits',
      },
      settings: {
        name: 'Settings',
        desc: 'Appearance · background · skins · system · extensions · about',
      },
    },
    quickSettings: {
      title: 'Quick settings',
      close: 'Collapse quick settings',
      on: 'On',
      off: 'Off',
      tileTheme: 'Dark theme',
      tileAnim: 'Animations',
      tileCrypto: 'Link crypto',
      tileSleep: 'Prevent sleep',
    },
    notif: {
      title: 'Notification Center',
      countUnit: 'items',
      close: 'Collapse notification center',
      clearAll: 'Clear all',
      empty: 'No notifications',
      pending: 'Pending',
      notifications: 'Notifications',
      dismiss: 'Dismiss notification: {title}',
      justNow: 'Just now',
      minutesAgo: '{mins}m ago',
      hostSource: 'Host',
      approval: {
        title: 'Waiting for permission approval',
        body: 'manifest declares {perms} permission bits ({risks} high-risk); it activates only after approval.',
        go: 'Review',
      },
      stopped: {
        title: 'Stopped',
        body: 'Instance deactivated; reopen from the home screen.',
        toast: '{name} stopped',
      },
      started: {
        title: 'Started',
        body: '{name} activated and mounted',
      },
      uninstalled: {
        title: 'Uninstalled',
        body: '{name} and its data removed',
      },
      approved: {
        title: 'Approved & started',
        body: 'The approval notification disappears automatically (derived, no lifecycle).',
      },
      closeAll: {
        title: 'Closed {count} cards',
        body: 'All app instances stopped and system pages closed.',
        toast: 'Closed {count} cards',
      },
      open: 'View',
      reopen: 'Reopen',
      ready: {
        title: 'Runtime ready',
        body: '{count} apps loaded; authorization policy fail-closed self-check passed.',
      },
    },
    ctx: {
      aria: 'App actions',
      open: 'Open',
      startOpen: 'Start & open',
      manage: 'App management',
      perms: 'Permissions & authorization',
      stop: 'Stop',
      uninstall: 'Uninstall',
      uninstallDisabled: 'Stop the app before uninstalling',
    },
    dialog: {
      close: 'Close dialog',
      cancel: 'Cancel',
      approval: {
        title: 'Approve "{name}"',
        desc: 'manifest declares {perms} permission bits. Approval is all-or-nothing — per-bit selection would let high-risk bits slip through.',
        afterHint:
          'After approval you get the actually granted bits; ungranted bits stay blocked at runtime.',
        approving: 'Approving…',
        confirm: 'Approve & start',
        success: '{name} approved & started',
      },
      strategy: {
        title: 'Switch to "Always allow"?',
        body: 'Requests of {name} for {resource} will no longer prompt: unseen targets are allowed directly and recorded as "unconfirmed". Switching does not grant everything at once — only targets actually accessed accumulate over time.',
        confirm: 'Confirm switch',
      },
      uninstall: {
        title: 'Uninstall "{name}"?',
        body: 'Deletes install directory, plugin storage and enable state; not recoverable. Auth records are removed too.',
        confirm: 'Confirm uninstall',
        success: '{name} uninstalled',
      },
      exit: {
        title: 'Quit WasmNest?',
        desc: 'These apps are still running:',
        none: 'No apps running; you can quit now.',
        confirm: 'Quit anyway',
      },
    },
    settings: {
      ui: {
        title: 'Appearance',
        themeLight: 'Light',
        themeDark: 'Dark',
        themeSystem: 'System',
        language: 'Language',
        fontSize: 'Font size',
        animations: 'Animations',
        animationsDesc: 'Screen transitions and overlay effects (disable to degrade)',
      },
      background: {
        title: 'Background',
        wallLabel: 'Wallpaper',
        dimLabel: 'Dim overlay · {pct}%',
        customReplace: 'Replace image…',
        customRemove: 'Remove',
        customHint: 'PNG / JPG / WebP, up to 20 MB. The image is copied into app data.',
        customSaved: 'Custom wallpaper updated',
        customRemoved: 'Custom wallpaper removed',
        wall: {
          none: 'None (solid)',
          aurora: 'Aurora',
          dune: 'Dune',
          reef: 'Reef',
          custom: 'Custom',
        },
      },
      permsEntry: {
        title: 'Authorization',
        desc: 'Policy tiers and auth records',
        hint: 'Security-gate entry; full records live in Permissions & Authorization',
        open: 'Open permissions',
      },
      skins: {
        title: 'Theme skins',
        desc: 'Color schemes for the platform shell; apps keep their own palettes.',
        default: 'Default',
        defaultDesc: 'Follow the platform default palette',
        hint: 'Skins only override shell CSS variables; palettes declared by an app root take precedence.',
      },
      extensions: {
        title: 'Extension settings',
        desc: 'Settings slots reserved for platform extensions; app-level settings stay with each app.',
        empty: 'Reserved area · no extension settings yet',
        hint: 'Rows appear automatically when an extension registers and are removed when it is disabled.',
      },
    },
    perms: {
      pending: '{count} apps awaiting approval',
      pendingHint:
        'Approval is all-or-nothing — per-bit selection would let high-risk bits slip through.',
      pendingGo: 'Review',
      appMeta: '{perms} permission bits · {risks} high-risk · {records} auth records',
      manage: 'Manage',
      secUser: 'Granted {count}',
      secAuto: 'Auto-allowed {count}',
      secFirstParty: 'First-party {count}',
      secDeny: 'Denied {count}',
    },
    apps: {
      sortHint:
        'Sorted by auth risk ("always allow" loosest first). Running apps cannot be uninstalled; enabling goes through the approval gate first.',
      listAria: 'Installed apps',
      install: 'Install app',
      installDesc: 'Local zip (plugin_install_from_file)',
      installToast: 'Install app: pick a local zip (full flow pending)',
      kvSource: 'Source',
      kvSize: 'Size',
      kvViews: 'Views',
      kvType: 'Type',
      approveStart: 'Approve & start',
      stop: 'Stop',
      open: 'Open',
      startOpen: 'Start & open',
      uninstall: 'Uninstall',
      uninstallDisabled: 'Stop the app before uninstalling',
      approvalCallout:
        'Pending approval: manifest declares {perms} permission bits ({risks} high-risk). Approval is all-or-nothing.',
      strategyTitle: 'Authorization strategy',
      strategyHint:
        'Switching tiers does not affect existing records; tightening requires revoking one by one. Full records in Permissions & Authorization.',
      permsTitle: 'Permission bits (manifest-declared · load-time all-or-nothing · read-only)',
      permsHint: 'High-risk bits highlighted: arbitrary command execution / main DB access.',
      configTitle: 'App configuration',
      configEmpty: 'No configurable items (manifest contributes.configuration.properties empty).',
      configSave: 'Save',
      configReset: 'Reset to defaults',
      configSaved: 'Configuration saved (written to plugin storage)',
      noSelection: 'Select an app to view details',
      // 2026-10-17 lifecycle-sync: face catalog revived to real lifecycle actions
      // App bundle mount surface (ADR 0057 mechanism B): loading / failure states
      loading: 'Loading app interface…',
      mountFailed:
        'Failed to load the app interface. You can retry; if it keeps failing, check the logs',
      errorHint:
        'The app failed to start (no running instance). Start it again, or review Permissions & Authorization and retry',
      systemServices: 'System services',
      businessApps: 'Apps',
      enabled: 'Enabled',
      enabledHint: 'Enabled = app available (preference record, does not trigger start)',
      autostart: 'Autostart',
      autostartHint: 'Auto-activate at startup (preference only; takes effect next boot)',
      surfaceHint: 'Host-mounted surface: {route}',
      permCardTitle: 'Permissions & Authorization',
      permHint:
        'Policy tiers, auth records and built-in first-party entries share the same view as the settings "App authorization" page.',
      permGo: 'Open permissions & authorization',
      source: {
        builtin: 'Built-in',
        scanned: 'Scanned',
        wasm: 'WASM',
        user: 'User-installed',
      },
    },
    boot: {
      line: 'WasmNest · wasm-app platform starting',
      skip: 'Click anywhere to skip',
      stepRegistry: 'Installed app registry loaded ({count})',
      stepAuth: 'Authorization policy fail-closed self-check',
      stepReady: 'Runtime ready',
    },
  },
  common: {
    button: {
      cancel: 'Cancel',
      stop: 'Stop',
    },
    status: {
      error: 'Error',
      unknown: 'Unknown',
      running: 'Running',
      stopped: 'Stopped',
      asking: 'Waiting for Input',
      starting: 'Starting',
    },
    misc: {
      terminalTitle: 'Terminal - {name}',
    },
  },
  // ==================== Error Envelope (ADR 0030) ====================
  // Top-level namespace: errors.<code> ↔ envelope code, zero mapping layer;
  // renaming a code is a breaking change. UI rule: toasts/pages show friendly
  // copy (template + params interpolation) only; never render the code,
  // request_id, or technical detail.
  errors: {
    retry: 'Retry',
    host: {
      internal: 'Operation failed, please try again',
      invoke: {
        timeout: 'Operation timed out, please retry',
      },
      // Mechanism codes (ADR 0030 registry v0): app-management failures
      // + runtime domain (event-channel envelopes) — one user-facing story
      // per failure kind; interpolation params carry display names only
      plugin: {
        'not-activated': 'This app is not enabled, this action is unavailable',
        'not-found': 'App not found or removed',
        trap: 'App "{name}" misbehaved, auto-recovery attempted',
        'recovery-failed': 'App "{name}" failed and could not recover; check the app center',
        'self-check-failed': 'App "{plugin}" self-check failed, check its configuration',
        degraded: 'App "{name}" is running degraded, some features unavailable',
      },
    },
    frontend: {
      internal: 'Operation failed, please try again',
    },
    shell: {
      wallpaper: {
        invalid: 'This image cannot be used: choose a PNG / JPG / WebP up to 20 MB',
      },
    },
  },
  desktop: {
    splash: {
      status: 'Starting up…',
      tagline: 'Multi-WASM app runtime',
    },
    sidebar: {
      settings: 'Settings',
      navigation: 'Navigation',
      serviceRunning: 'Service Running',
      serviceStopped: 'Service Stopped',
      serviceStarting: 'Service Starting',
      collapse: 'Collapse Sidebar',
      expand: 'Expand Sidebar',
    },
    // Fallback copy for globally uncaught exceptions (renderer errorHandler /
    // unhandledrejection)
    runtimeUnexpected: 'An unexpected error occurred. See logs for details',
    // Window-control tooltips retired with the app-drawn title bar: the title bar
    // belongs to the shell (shell.toolbar.*); terminal-window copy lives in the
    // app domain session.terminal.*
    // Exit confirmation (window-close-requested carries the running-session list)
    session: {
      confirmExitTitle: 'Confirm Exit',
      confirmExitMsg:
        '{count} session(s) are still running. All running processes will be terminated if you exit.',
      confirmExitForce: 'Force Exit',
    },
    server: {
      title: 'Server Management',
      sectionStatus: 'Status',
      sectionNetwork: 'Network',
      port: 'Port',
      portHint: 'Takes effect on the next service start',
      surfaceHint: 'Service follows app surfaces; stops when the last app surface closes',
      portSave: 'Save',
      portRestartConfirmTitle: 'Save Port',
      portRestartConfirmBody:
        'The port change takes effect after the server restarts. Restart now?',
      portRestartNow: 'Restart Now',
      portRestartLater: 'Later',
      portSavedDelayed: 'Port saved. It will take effect the next time the server starts.',
      portRestartApplied: 'Port updated and server restarted.',
      localIp: 'Local IP',
      autoStart: 'Auto-start',
      start: 'Start',
      stop: 'Stop',
      restart: 'Restart',
      status: {
        running: 'Running',
        stopped: 'Stopped',
        starting: 'Starting',
      },
      monitoring: 'Performance Monitoring',
      uptime: 'Uptime',
      connections: 'Connections',
      totalRequests: 'Total Requests',
      cpuUsage: 'CPU Usage',
      memoryUsage: 'Memory Usage',
      requestRate: 'Request Rate',
      wsThroughput: 'WS Throughput',
      wsSentRate: 'Sent Rate',
      wsRecvRate: 'Received Rate',
      startSuccess: 'Server started',
      stopSuccess: 'Server stopped',
      restartSuccess: 'Server restarted',
      // Error-enveloped: {error} interpolation removed (technical details must
      // never reach the user-facing surface, ADR 0030); concrete failures surface
      // uniformly via showUserError → errors.host.*; these keys stay as static
      // fallback copy
      startFailed: 'Start failed, please try again',
      stopFailed: 'Stop failed, please try again',
      restartFailed: 'Restart failed, please try again',
      advancedConfig: 'Advanced Configuration',
      workers: 'Worker Threads',
      workersHint: '0 = auto (CPU cores)',
      keepAlive: 'Keep-Alive Timeout',
      keepAliveHint: 'seconds, 0 = disabled',
      clientRequestTimeout: 'Request Header Timeout',
      clientDisconnectTimeout: 'Disconnect Timeout',
      maxConnections: 'Max Connections',
      maxConnectionsHint: 'per worker',
      backlog: 'TCP Backlog',
      tcpNodelay: 'TCP_NODELAY',
      shutdownTimeout: 'Shutdown Timeout',
      wsMaxFrameSize: 'WS Frame Size',
      wsMaxFrameSizeHint: 'KB',
      wsMaxMessageSize: 'WS Message Size',
      wsMaxMessageSizeHint: 'MB',
      resetDefaults: 'Reset Defaults',
      resetSuccess: 'Reset to defaults, restart to apply',
      collapse: 'Collapse',
      expand: 'Expand',
    },
    // Unmatched-route fallback page (D3 fail-visible: explicit not-found when a
    // retired surface is visited directly)
    notFound: {
      title: 'Page Not Found',
      body: 'The page you visited does not exist or was removed in a version update',
      back: 'Back to Sessions',
    },
    // ==================== Authorization dialogs (security gate, fail-closed) ====================
    // Filesystem authorization (three tiers + remember since ticket 03) +
    // outbound network authorization (ticket 05, origin granularity).
    // Answers ride host-face commands (host credential required); the frontend
    // only renders and relays the decision.
    auth: {
      fsAuthTitle: 'File Access Authorization',
      fsAuthRead: 'read',
      fsAuthWrite: 'write',
      // Authorization records are split by operation — the dialog must say
      // whether this request is for read, write, or both.
      fsAuthReadWrite: 'read & write',
      fsAuthRequest: 'App {plugin} requests {operation} access',
      fsAuthPickerRequest:
        'You just picked these paths in the system picker; {plugin} requests {operation} access',
      fsAuthGrantScopeDir:
        '“Remember” grants the containing folder for {operation}: other files in it will not be asked again',
      fsAuthPath: 'File path',
      fsAuthPaths: 'File paths ({count} directories)',
      // “Remember” now only covers **this request's operations** (read / write / both)
      fsAuthRemember: 'Remember {operation} access to this path',
      fsAuthAllow: 'Allow',
      fsAuthDeny: 'Deny',
      // Three-way answer — the "always ask" tier offers no "Remember", so the
      // allow button can only commit to this one time; "Always deny" lands a
      // deny record (the target and its subtree are denied from then on).
      fsAuthAllowOnce: 'Allow once',
      fsAuthDenyAlways: 'Always deny',
      netAuthTitle: 'Network Access Authorization',
      netAuthRequest: 'App {plugin} requests access to a network address',
      netAuthOrigin: 'Address',
      // Consent scope must be visible: otherwise users can only guess what “Allow” means
      netAuthScope:
        'Once allowed, this address (host and port) will not be asked again; you can revoke it in Settings → App Authorization',
      // Same dialog under the "Always Ask" tier: that tier records nothing, so
      // promising "will not be asked again" would be a lie
      netAuthScopeOnce:
        'This batch of requests only — the app is set to "Always Ask", so the next request will ask again',
      netAuthAllow: 'Allow',
      netAuthDeny: 'Deny',
      netAuthDenyAlways: 'Always deny',
    },
  },
  settings: {
    title: 'Settings',
    linkCrypto: {
      title: 'Link Encryption',
      master: 'Enable Link Encryption',
      masterDesc:
        'End-to-end encryption for LAN traffic; off by default — pair with the mobile end first',
      encryptHttp: 'Encrypt HTTP Payload',
      encryptHttpDesc: 'REST request/response body envelope encryption (terminal input echo etc.)',
      encryptWsTerminal: 'Encrypt Terminal Channel',
      encryptWsTerminalDesc: 'WS terminal frame encryption (PTY output stream)',
      encryptWsEvent: 'Encrypt Event Channel',
      encryptWsEventDesc: 'WS event frame encryption (sync event broadcast)',
      plaintextFallback: 'Allow Plaintext Fallback',
      plaintextFallbackDesc:
        'Let unnegotiated legacy clients through in plaintext; when off, unnegotiated remote requests are rejected',
      fingerprint: 'Local Fingerprint',
      fingerprintDesc:
        'Local identity key fingerprint (first 16 hex of SHA-256); compare manually with the mobile end',
      saveFailed: 'Failed to save link encryption config',
    },
    system: {
      title: 'System Settings',
      preventSleep: 'Prevent System Sleep',
    },
    log: {
      title: 'Logging',
      level: 'Log Level',
      levelDebug: 'Debug',
      levelInfo: 'Info',
      levelWarn: 'Warning',
      levelError: 'Error',
      levelApplied: 'Log level switched',
      format: 'Log Format',
      formatText: 'Text',
      formatJson: 'JSON',
      maxFiles: 'Retained Files',
      capacityMb: 'Capacity Cap (MB)',
      persist: 'Persist Config',
      openDir: 'Open Log Directory',
      save: 'Save Config',
      saved: 'Log config saved',
      saveFailed: 'Failed to save log config',
    },
    // Authorization strategy and records (2026-09-27 authorization-policy enhancement, ticket 01):
    // settings second-level entry "App Authorization" and the management page copy.
    // Tier wording matches spec §4.1 verbatim; resource names match the host
    // read-model resource values (fs / network)
    authorization: {
      title: 'App Authorization',
      entry: 'App Authorization Records',
      back: 'Back to Settings',
      refresh: 'Refresh',
      appCount: '{count} app(s)',
      empty: 'No manageable apps',
      emptyHint: 'Installed and enabled apps will be listed here with their authorization status',
      recordCount: '{count} record(s)',
      records: {
        toggle: 'Expand authorization records',
        fsTitle: 'File Directory Records',
        networkTitle: 'Network Address Records',
        empty: 'No file authorization records for this app yet',
        fsEmpty: 'No file authorization records for this app yet',
        networkEmpty: 'No network authorization records for this app yet',
        revoke: 'Revoke',
        removeDeny: 'Remove Denial',
        revoked: 'Authorization revoked for this directory; subsequent access will be denied',
        networkRevoked:
          'Authorization revoked for this address; subsequent requests will be denied',
        denyRemoved: 'Denial record removed; this directory returns to unauthorized state',
        effect: {
          allow: 'Authorized',
          deny: 'Hard Denied',
        },
        ops: {
          read: 'Read',
          write: 'Write',
          read_write: 'Read & Write',
        },
        source: {
          user: 'User Confirmed',
          always_allow: 'No-Ask Auto-Allowed',
          legacy: 'Legacy',
          user_deny: 'User Denied',
        },
      },
      // Four section titles and empty states (shared by ticket 07 detail page /
      // ticket 08 settings page, spec §9.2): user-granted / no-ask auto-allowed
      // (unconfirmed) / built-in no-ask (first party) / hard denied
      sections: {
        userGranted: 'User Granted',
        autoAllowed: 'No-Ask Auto-Allowed',
        firstParty: 'Built-in No-Ask',
        denied: 'Hard Denied',
        // No-ask auto-allowed records must carry the "unconfirmed" marker and be
        // visually distinct from user-confirmed records (spec §9.4)
        unconfirmed: 'Unconfirmed',
        empty: 'No authorization records',
        // Two shapes of built-in no-ask entries (first-party list: home prefix /
        // named segment of any project)
        firstPartyHome: 'Home Directory',
        firstPartySegment: 'Project Directory',
        revokeHint: 'After revoking, subsequent access to this directory will be denied',
        // Empty state when the app has no built-in no-ask entries (distinct from
        // "has entries": empty is a fact, not missing data)
        firstPartyEmpty: 'This app has no built-in no-ask entries',
        firstPartyRevoked: 'No-ask revoked for this directory; subsequent access will be denied',
      },
      strategy: {
        always_ask: 'Always Ask',
        default: 'Default',
        always_allow: 'Always Allow',
      },
      // Strategy control (three tiers selectable since ticket 03/04): switching to
      // "Always Allow" requires confirmation whose copy must state the tier's
      // semantic boundary (spec §4.3) — switching does NOT grant everything at
      // once; only actually-accessed targets accumulate into records
      // (continuously accumulative, hence the reminder)
      strategyControl: {
        title: '{resource} Request Policy',
        saved: 'Policy updated; the next decision applies immediately',
        hint: {
          // "Always Ask" skips all allow records, so already-authorized targets
          // are asked too — writing "unrecorded targets will be asked" would
          // make users think authorized ones pass silently (ticket 06 fix)
          always_ask: 'Ask on every access (already-authorized targets included)',
          default: 'Allow on record hit; ask only when unrecorded',
          always_allow:
            'Unrecorded targets pass without asking and are auto-recorded (unconfirmed)',
        },
        confirmTitle: 'Switch to "Always Allow"?',
        // The semantic boundary (spec §4.3) must appear in the confirmation:
        // both "one click opens everything" and "nothing will happen" are wrong
        confirmBody:
          '"{name}" {resource} requests will no longer be asked: unrecorded targets pass directly and are recorded as "unconfirmed". Switching does not grant all permissions at once — only targets the app actually accesses accumulate, so the list keeps growing with continued access; revoke individually below at any time.',
        confirmOk: 'Switch to Always Allow',
      },
      resource: {
        fs: 'File',
        network: 'Network',
      },
    },
    ui: {
      title: 'Interface',
    },
    appearance: {
      theme: 'Theme',
      palette: 'Palette',
      paletteWarm: 'Warm Workbench',
      paletteCool: 'Cool Gray',
      paletteForest: 'Forest Green',
      paletteOcean: 'Ocean Teal',
      paletteSunset: 'Sunset Glow',
      paletteViolet: 'Starry Violet',
      paletteDesc: 'Global color style; applies immediately',
      lightMode: 'Light Mode',
      darkMode: 'Dark Mode',
      followSystem: 'Follow System',
      language: 'Language',
      fontSize: 'Font Size',
      animations: 'Animations',
      animationsDesc: 'When off, page transitions and interactive animations are disabled globally',
    },
    about: {
      title: 'About',
      githubRepo: 'GitHub Repository',
      checkUpdate: 'Check for Updates',
      alreadyLatest: 'Already up to date',
      checkingUpdate: 'Checking for updates...',
      checkFailed: 'Update check failed, please try again',
      newVersionAvailable: 'New version available',
      downloadingUpdate: 'Downloading update...',
      downloadComplete: 'Download complete, installing...',
      installingUpdate: 'Installing update...',
      downloadUpdate: 'Update Now',
    },
    reset: {
      title: 'Reset to defaults',
      desc: 'Clears app authorizations and personal preferences, and restores default settings',
      action: 'Reset to defaults',
      confirmTitle: 'Reset to defaults',
      confirmBody:
        'All app authorization records will be cleared, copied custom wallpapers will be deleted, and all settings will be restored to their defaults. This action cannot be undone.',
      confirmOk: 'Reset',
      done: 'Defaults restored',
      failed: 'Reset failed, please try again',
    },
  },
}
