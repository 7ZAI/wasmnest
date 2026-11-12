/**
 * Error envelope copy (ADR 0030) — English
 *
 * Top-level namespace `errors.<code>` ↔ envelope code, zero mapping layer
 * (same contract as desktop `host-en.ts`). Moving a code is a breaking change;
 * only mobile-visible mechanism codes + renderer fallback live here — app-domain
 * copy is owned by each app.
 *
 * UI rule: toasts/pages show this friendly copy (params interpolated) only;
 * never render the code, request_id or technical detail.
 */
export default {
  errors: {
    retry: 'Retry',
    host: {
      internal: 'Operation failed, please try again',
      invoke: {
        timeout: 'Operation timed out, please retry',
      },
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
  },
}
