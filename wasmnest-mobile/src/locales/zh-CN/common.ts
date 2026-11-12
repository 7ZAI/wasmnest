export default {
  common: {
    button: {
      confirm: '确认',
      cancel: '取消',
      open: '打开',
    },
    notification: {
      connectionDisconnected: '连接已断开: {reason}',
      reconnectFailed: '重连失败: {reason}，请手动重新连接',
      connectionInterrupted: '连接中断，正在自动重连: {reason}',
      reconnected: '连接已恢复',
      // M1/ADR 0031：认证类致命关闭（4001/4003）——需重新配对/认证后再连
      authFailedRePair: '身份认证已失效，请重新配对后再连接: {reason}',
      // 协议/策略层不可重试关闭（1002/1003/1007/1008/1009/1010）——重连必然同样
      // 失败，正确动作是升级其中一端。必须与 authFailedRePair 分开：否则用户会
      // 按「重新配对」反复折腾，却解决不了版本/协议不匹配
      protocolIncompatible: '连接协议不兼容，已停止自动重连，请升级应用后重试: {reason}',
      // 用户关掉自动重连后的断连：不提示的话用户分不清「正在自愈」与「不会自愈」，
      // 只能干等退避耗尽（3 轮 + 认证超时）才发现没人会救
      autoReconnectDisabled: '连接已断开，自动重连已关闭，请手动重新连接',
    },
  },
}
