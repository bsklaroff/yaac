/**
 * Preview panes live in the same tiling layout tree as terminals, keyed by a
 * `target` string. There is at most one preview pane per worktree — the single
 * `preview` target — and which forwarded port it shows lives in the store
 * (so a port switch is a state change, not a leaf swap, and never a new split).
 * WorktreeView branches on `isPreviewTarget` to render a browser pane.
 */

/** The one layout target a worktree's preview pane uses. */
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
 * loopback, whatever host the app was served from: the server binds no
 * forwarded port (docs/port-forward-tunnel.md), and the listener the webview
 * reaches is the one the desktop app itself holds — on `127.0.0.1` only, so
 * not `localhost`, which may resolve to `::1` first. Always plain http:
 * forwarded dev-server ports carry no TLS even when the app is served over
 * https.
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
