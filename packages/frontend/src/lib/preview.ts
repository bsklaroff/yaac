/**
 * The preview pane shares the layout with terminals. A workspace has at most
 * one, under the `preview` target; which forwarded port it shows is kept in
 * the store, so switching ports doesn't change the layout.
 */

/** The one layout target a workspace's preview pane uses. */
export const PREVIEW_TARGET = 'preview'

/** Whether a layout target is the preview pane (vs a terminal). */
export function isPreviewTarget(target: string): boolean {
  return target === PREVIEW_TARGET
}

/** Pane/tab label for the preview, e.g. "Preview :5173" (bare when no port). */
export function previewLabel(port: number | undefined): string {
  return port === undefined ? 'Preview' : `Preview :${port}`
}

/**
 * The URL the preview webview loads for a forwarded host port. Always
 * `127.0.0.1`: the listener is held by the desktop app on this machine
 * (docs/port-forward-tunnel.md), and `localhost` may resolve to `::1`.
 * Always http, since forwarded dev-server ports have no TLS.
 */
export function previewUrl(hostPort: number): string {
  return `http://127.0.0.1:${hostPort}/`
}

/**
 * Resolve what the preview URL bar should navigate to. A full http(s) URL is
 * used as-is; anything else is treated as a path on the current forwarded
 * port. Returns null when there's nothing to navigate to.
 */
export function normalizePreviewNav(raw: string, hostPort: number | undefined): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (hostPort === undefined) return null
  return previewUrl(hostPort) + trimmed.replace(/^\//, '')
}
