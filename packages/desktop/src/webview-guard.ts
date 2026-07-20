/**
 * Lockdown helpers for the session-preview `<webview>`. The preview embeds a
 * dev server running inside a session pod, reached over a forwarded port on
 * the server host — loopback for a local server, the tailnet name for a
 * remote one. These keep the guest constrained to that: no Node access, no
 * rogue preload, and pinned to loopback or the attached server's host —
 * anything else (an OAuth hop, a `target=_blank`) is bounced to the system
 * browser instead of rendered.
 */

/**
 * Whether a URL is one a preview webview may load or navigate to: an http(s)
 * URL on loopback, or on `appHost` — the host the shell window itself is
 * attached to (a remote server's forwarded ports live there). Everything
 * else (external hosts, file:, javascript:, about:) is rejected.
 */
export function isAllowedPreviewUrl(raw: string, appHost?: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (appHost !== undefined && appHost !== '' && url.hostname === appHost) return true
  const host = url.hostname.replace(/^\[|\]$/g, '') // strip IPv6 brackets
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

/**
 * The hostname the shell window is currently attached to, from its loaded
 * URL — undefined for non-network pages (the splash data: URL, about:blank),
 * so the guard falls back to loopback-only.
 */
export function appHostFromUrl(raw: string): string | undefined {
  try {
    return new URL(raw).hostname || undefined
  } catch {
    return undefined
  }
}

/**
 * Force safe webPreferences on a webview guest before it attaches, regardless
 * of attributes set on the DOM element. Mutates the object Electron passes to
 * the `will-attach-webview` handler.
 */
export function hardenGuestWebPreferences(prefs: Record<string, unknown>): void {
  delete prefs.preload
  delete prefs.preloadURL
  prefs.nodeIntegration = false
  prefs.nodeIntegrationInSubFrames = false
  prefs.contextIsolation = true
}

/** Clamp a webview's requested src to an allowed preview host, else blank it. */
export function sanitizeWebviewSrc(src: string, appHost?: string): string {
  return isAllowedPreviewUrl(src, appHost) ? src : 'about:blank'
}
