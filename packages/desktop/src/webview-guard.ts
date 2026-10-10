/**
 * Lockdown helpers for web content: the main window's navigation, and the
 * workspace-preview `<webview>`. The preview shows a
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

/**
 * Whether the main window may follow a navigation its page started: only
 * within the origin it shows. The shell loads every other page itself, so
 * a page cannot take the window, and the preload bridge, somewhere else.
 */
export function isSameOriginNavigation(from: string, to: string): boolean {
  try {
    const origin = new URL(from).origin
    return origin !== 'null' && origin === new URL(to).origin
  } catch {
    return false
  }
}
