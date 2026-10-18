import { resolve } from 'node:path'

// 应用仓根（三仓拆分 §5-E7）：app 源码住独立应用仓；宿主 CSS 仍要覆盖 app 用到的
// Tailwind 类，故 content 扫描面经本常量指向 `<appsRoot>/apps/*/mobile/src`
// （R1 布局推导；CI / 非常规布局可用 WASMNEST_APPS_ROOT 覆盖）。
const APPS_ROOT = process.env.WASMNEST_APPS_ROOT ?? resolve(process.cwd(), '../../wasmnest-apps')

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{vue,js,ts,jsx,tsx}",
    // 内置 wasm 应用前端源码（三仓拆分 §5-E7：app 源码住独立应用仓）：插件 SFC 使用
    // 宿主 Tailwind 工具类，运行时注入宿主 CSS，需纳入扫描否则类缺失
    // （插件 dist 不携带编译后的 Tailwind）。路径按 R1 布局推导，可用
    // WASMNEST_APPS_ROOT 覆盖。
    `${APPS_ROOT}/apps/*/mobile/src/**/*.{vue,js,ts,jsx,tsx}`,
    // 共享 SDK 组件：宿主/插件共用（@binblink/wasmnest-plugin-sdk-mobile/ui）
    "./packages/plugin-sdk-mobile/src/**/*.{vue,js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Custom color palette for the app
        primary: {
          50: '#f0f9ff',
          100: '#e0f2fe',
          200: '#bae6fd',
          300: '#7dd3fc',
          400: '#38bdf8',
          500: '#0ea5e9',
          600: '#0284c7',
          700: '#0369a1',
          800: '#075985',
          900: '#0c4a6e',
          950: '#082f49',
        },
        dark: {
          50: '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          300: '#cbd5e1',
          400: '#94a3b8',
          500: '#64748b',
          600: '#475569',
          650: '#3d4f63',
          700: '#334155',
          750: '#2d3a4f',
          800: '#1e293b',
          850: '#172033',
          900: '#0f172a',
          950: '#020617',
        },
        // 移动端语义别名 - 映射 --mobile-* token 到 Tailwind utility
        mobile: {
          bg: {
            primary: 'var(--mobile-bg-primary)',
            secondary: 'var(--mobile-bg-secondary)',
            tertiary: 'var(--mobile-bg-tertiary)',
            card: 'var(--mobile-bg-card)',
            elevated: 'var(--mobile-bg-elevated)',
          },
          text: {
            primary: 'var(--mobile-text-primary)',
            secondary: 'var(--mobile-text-secondary)',
            muted: 'var(--mobile-text-muted)',
            disabled: 'var(--mobile-text-disabled)',
            onAccent: 'var(--mobile-text-on-accent)',
          },
          accent: 'var(--mobile-accent)',
          accentMuted: 'var(--mobile-accent-muted)',
          accentSecondary: 'var(--mobile-accent-secondary)',
          border: 'var(--mobile-border)',
          borderHover: 'var(--mobile-border-hover)',
          borderActive: 'var(--mobile-border-active)',
          success: 'var(--mobile-success)',
          successMuted: 'var(--mobile-success-muted)',
          warning: 'var(--mobile-warning)',
          warningMuted: 'var(--mobile-warning-muted)',
          error: 'var(--mobile-error)',
          errorMuted: 'var(--mobile-error-muted)',
          overlay: 'var(--mobile-overlay)',
          overlayHeavy: 'var(--mobile-overlay-heavy)',
          overlayLight: 'var(--mobile-overlay-light)',
          navBg: 'var(--mobile-nav-bg)',
          navBorder: 'var(--mobile-nav-border)',
          navActive: 'var(--mobile-nav-active)',
          navInactive: 'var(--mobile-nav-inactive)',
          inputBg: 'var(--mobile-input-bg)',
          inputBorder: 'var(--mobile-input-border)',
          inputFocus: 'var(--mobile-input-focus)',
          inputPlaceholder: 'var(--mobile-input-placeholder)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['Consolas', 'Monaco', 'monospace'],
      },
      boxShadow: {
        'xs': '0 1px 2px 0 rgb(0 0 0 / 0.04)',
      },
    },
  },
  plugins: [],
}
