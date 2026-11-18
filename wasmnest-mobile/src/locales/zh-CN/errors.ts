/**
 * 错误信封文案（ADR 0030）— 简体中文
 *
 * 顶层命名空间 `errors.<code>` ↔ 信封 code，零映射层（与桌面端
 * `wasmnest-desktop/src/i18n/host-zh-CN.ts` 的 `errors` 块同口径）。
 * 改码 = 破坏性变更；只取移动端可见面（宿主机制码 + 前端兜底），
 * 应用业务文案归各应用自持。
 *
 * UI 呈现规则：toast / 页面只显示这里的友好文案（params 插值），
 * 永不显示 code / request_id / 技术详情（详情只进日志）。
 */
export default {
  errors: {
    retry: '重试',
    host: {
      internal: '操作未完成，请稍后重试',
      invoke: {
        timeout: '操作超时，请重试',
      },
      // 机制码（ADR 0030 注册表 v0）：应用管理面机制失败 + 运行时段
      // ——同一 kind 对用户是同一件事；插值参数只允许应用显示名
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
  },
}
