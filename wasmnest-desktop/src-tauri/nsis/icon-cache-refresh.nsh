; ============================================================================
; 安装 / 卸载完成后刷新 Windows 图标缓存
;
; 背景：
;   桌面快捷方式(.lnk)的图标由 Explorer 的图标缓存(IconCache.db / thumbcache)渲染，
;   重新安装 / 卸载后 NSIS 会重建 / 删除 .lnk，但 Explorer 仍从缓存显示旧的渲染
;   结果，造成「任务栏新图标、桌面旧图标」或卸载后开始菜单图标残留的不一致。
;   任务栏图标来自运行中 exe 的窗口图标（每次启动实时读取嵌入资源），因此总是最新的。
;
; 修复：
;   NSIS_HOOK_POSTINSTALL（安装 / 升级，桌面快捷方式创建之后）——
;   NSIS_HOOK_POSTUNINSTALL（卸载，快捷方式删除之后）——
;   1. ie4uinit.exe -show —— Windows 官方图标缓存刷新命令（Win8/10/11）
;   2. SHChangeNotify(SHCNE_ASSOCCHANGED) —— 通知 Explorer 关联/图标已变化，强制重绘
;
; 两个 hook 宏共用同一段刷新逻辑，为避免跨宏符号依赖，直接内联两份。
; ============================================================================

!macro NSIS_HOOK_POSTINSTALL
  ; 存在 ie4uinit.exe 时刷新图标缓存；nsExec::Exec 不阻塞安装流程
  IfFileExists "$WINDIR\System32\ie4uinit.exe" 0 +3
    nsExec::Exec '"$WINDIR\System32\ie4uinit.exe" -show'
    ; SHCNE_ASSOCCHANGED = 0x08000000，强制 Explorer 立即刷新快捷方式图标
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 卸载后同样刷新：删掉快捷方式后 Explorer 可能残留旧图标
  IfFileExists "$WINDIR\System32\ie4uinit.exe" 0 +3
    nsExec::Exec '"$WINDIR\System32\ie4uinit.exe" -show'
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend