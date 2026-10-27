export default {
  common: {
    button: {
      confirm: 'Confirm',
      cancel: 'Cancel',
      open: 'Open',
    },
    notification: {
      connectionDisconnected: 'Connection lost: {reason}',
      reconnectFailed: 'Reconnect failed: {reason}. Please reconnect manually',
      connectionInterrupted: 'Connection interrupted. Auto-reconnecting: {reason}',
      reconnected: 'Connection restored',
      // M1/ADR 0031: auth-fatal close (4001/4003) — re-pair needed before reconnecting
      authFailedRePair: 'Authentication invalidated. Please re-pair before reconnecting: {reason}',
      // Protocol/policy non-retryable close (1002/1003/1007/1008/1009/1010):
      // reconnecting with identical parameters cannot succeed — the fix is
      // upgrading an endpoint. Kept separate from authFailedRePair so users are
      // not sent to re-pair for what is really a version mismatch.
      protocolIncompatible: 'Connection protocol incompatible. Auto-reconnect stopped; please update the app and retry: {reason}',
      // Disconnect while the user has auto-reconnect turned off: without this the
      // UI shows a generic "connection lost" and users cannot tell "recovering"
      // from "nobody is coming", so they just wait out the full backoff
      autoReconnectDisabled: 'Connection lost. Auto-reconnect is off; please reconnect manually',
    },
  },
}
