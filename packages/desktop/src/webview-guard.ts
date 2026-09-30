/**
 * Lockdown helpers for the workspace-preview `<webview>`. The preview shows a
 * workspace dev server through a port this app forwards on loopback
 * (forwarder.ts). The guest gets no Node access or preload and may only load
 * loopback URLs; anything else (an OAuth hop, a `target=_blank`) opens in the
 * system browser.
 */

/**
 * Whether a URL is one a preview webview may load or navigate to: an http(s)
 * URL on loopback. Everything else (external hosts, file:, javascript:,
 * about:) is rejected.
 */
export function isAllowedPreviewUrl(raw: string): boolean {
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
  return isAllowedPreviewUrl(src) ? src : 'about:blank'
}
