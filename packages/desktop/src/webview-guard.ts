/**
 * Lockdown helpers for the session-preview `<webview>`. The preview embeds a
 * dev server running inside a session pod, reached over a loopback forwarded
 * port. These keep the guest constrained to that: no Node access, no rogue
 * preload, and pinned to loopback origins — anything else (an OAuth hop, a
 * `target=_blank`) is bounced to the system browser instead of rendered.
 */

/**
 * Whether a URL is a loopback http(s) URL — the only origin a preview webview
 * may load or navigate to (a session's forwarded dev-server port). Everything
 * else (external hosts, file:, javascript:, about:) is rejected.
 */
export function isLocalPreviewUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.replace(/^\[|\]$/g, '') // strip IPv6 brackets
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
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

/** Clamp a webview's requested src to loopback, else blank it. */
export function sanitizeWebviewSrc(src: string): string {
  return isLocalPreviewUrl(src) ? src : 'about:blank'
}
