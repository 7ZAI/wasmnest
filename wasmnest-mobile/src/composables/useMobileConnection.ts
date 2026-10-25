//! useMobileConnection 门面（2026-10-25 拆分为 mobile-connection/ 目录，路径保持兼容）
//!
//! 导出面与拆分前逐项一致；实现按域分布：state（单例状态）/ connection（连接生命周期
//! 与事件装配）/ sessions（会话域）/ history（历史与配对设备）。

export * from './mobile-connection'
