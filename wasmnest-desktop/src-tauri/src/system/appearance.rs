//! 窗口外观：把 `AppConfig.ui.theme` 交给窗口，让**首帧**就用对深浅色（2026-10-29 立）
//!
//! ## 为什么这件事必须落在宿主 Rust 侧
//!
//! 桌面启动的第一帧是 `index.html` 里的静态首屏（`public/splash.css`）——它早于
//! 任何 JS，只认 CSS 的 `prefers-color-scheme`。而应用内的深浅色设置真源是
//! `AppConfig.ui.theme`（AppData 下的 config.properties），前端要经 invoke 异步
//! 取回，静态首屏等不到。两者的落差表现为：应用设成深色而系统是浅色（或反之）时，
//! 启动会先闪一帧错色，再被品牌开屏（`SplashLoading.vue`）纠正。
//!
//! 窗口主题恰好是**绘制之前**就能设定的量：
//!
//! - WebKitGTK 的 `prefers-color-scheme` 由 GTK 的 `gtk-application-prefer-dark-theme`
//!   驱动（WebKit `SystemSettingsManagerProxyGtk` 监听该 property，WebKit bug 196685
//!   即此实现），tao 的 `set_theme` 在 Linux 上正是写这个 property
//!   （`tao/src/platform_impl/linux/event_loop.rs`）；
//! - macOS / Windows 上窗口主题同样驱动 webview 的 `prefers-color-scheme`。
//!
//! 所以「窗口主题 = 应用设置」之后，静态首屏、品牌开屏、壳三段的深浅色同源，
//! 用户不再看到交接处的跳色。
//!
//! ## 边界（AGENTS §2 宿主薄壳）
//!
//! 只做一次**机制翻译**：`ui.theme` 字符串 → 窗口主题枚举。不解释产品语义、
//! 不缓存产品事实、不产生新的产品默认值——`ui.theme` 本来就是宿主自己的外观偏好，
//! 这个键在 AppConfig 里唯一消费者就是宿主 chrome。
//!
//! ## 调用时序（两处，缺一不可）
//!
//! 1. `bootstrap` 的 setup：webview 首次绘制**之前**应用一次（解决首帧）；
//! 2. `save_app_settings` 存盘后：设置页改完立刻生效。**这一处不是冗余**——
//!    用户从「深色」切回「跟随系统」时必须把窗口主题复位成 `None`，否则
//!    `matchMedia('(prefers-color-scheme: dark)')` 仍报被强制的主题，前端
//!    `useTheme()` 的 `isSystemDark` 会跟着错，界面卡在旧的深浅色里出不来。

use tauri::window::Color;
use tauri::{Theme, WebviewWindow};

/// 开屏深色底：品牌 ink 渐变起点，镜像 `SplashLoading.vue` 的 `--splash-bg-from`
///
/// 窗口底色只在 webview 首次绘制前可见（几帧），取值与静态首屏同源即可无缝。
const SPLASH_BG_DARK: Color = Color(0x16, 0x18, 0x1c, 0xff);

/// 开屏浅色底：镜像 `src/style.css` 浅色 token `--bg-page`
const SPLASH_BG_LIGHT: Color = Color(0xf5, 0xf4, 0xf0, 0xff);

/// `ui.theme` → 窗口主题；`None` = 交回平台决定
///
/// 三值语义与前端 `useTheme()` 逐字对齐（`light` / `dark` / `system`）：
/// 只有显式的 light / dark 才强制窗口主题，`system` 与任何未知值都复位为
/// `None`（配置被手改成别的字符串时按「跟随系统」处理，与前端回退到
/// `theme === 'system'` 之外一律按浅色的行为不冲突——前端此时拿到的是 false，
/// 而窗口跟随系统，最多是首帧与壳不一致，不会卡死）。
pub fn resolve_theme(theme: &str) -> Option<Theme> {
    match theme {
        "dark" => Some(Theme::Dark),
        "light" => Some(Theme::Light),
        _ => None,
    }
}

/// 把当前设置应用到窗口：窗口主题（驱动 `prefers-color-scheme`）+ 窗口底色
///
/// 失败只记日志不向上传播：外观不一致是观感问题，让启动因为一次 `set_theme`
/// 失败而中断才是真故障（fail-visible ≠ fail-fatal）。
pub fn apply_window_appearance(window: &WebviewWindow, theme: &str) {
    let resolved = resolve_theme(theme);

    if let Err(e) = window.set_theme(resolved) {
        tracing::warn!("应用窗口主题失败（ui.theme={theme}）: {e}");
    }

    // 跟随系统时窗口主题是 None，底色要问平台当前深浅色；问不到就按深色兜底
    // （深色是品牌开屏的主形态，兜底错一帧浅色界面的代价小于错一帧深色界面）
    let effective = resolved.or_else(|| window.theme().ok());
    let background = match effective {
        Some(Theme::Light) => SPLASH_BG_LIGHT,
        _ => SPLASH_BG_DARK,
    };
    if let Err(e) = window.set_background_color(Some(background)) {
        tracing::warn!("应用窗口底色失败: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 三值语义：只有显式 light / dark 强制窗口主题，其余一律交回平台
    #[test]
    fn resolve_theme_maps_three_values() {
        assert_eq!(resolve_theme("dark"), Some(Theme::Dark));
        assert_eq!(resolve_theme("light"), Some(Theme::Light));
        assert_eq!(resolve_theme("system"), None);
        // 未知值/空串按跟随系统处理（配置文件被手改时的收敛方向：交给平台 >
        // 猜一个固定主题——后者会让用户无法通过改回 system 自救）
        assert_eq!(resolve_theme("solarized"), None);
        assert_eq!(resolve_theme(""), None);
    }
}
