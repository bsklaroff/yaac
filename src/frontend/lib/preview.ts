/**
 * Preview panes live in the same tiling layout tree as terminals, keyed by a
 * `target` string. There is at most one preview pane per session — the single
 * `preview` target — and which forwarded port it shows lives in the store
 * (so a port switch is a state change, not a leaf swap, and never a new split).
 * SessionView branches on `isPreviewTarget` to render a browser pane.
 */

/** The one layout target a session's preview pane uses. */
export const PREVIEW_TARGET = 'preview'

/** Whether a layout target is the preview pane (vs a terminal). */
export function isPreviewTarget(target: string): boolean {
  return target === PREVIEW_TARGET
}

/** Pane/tab label for the preview, e.g. "Preview :5173" (bare when no port). */
export function previewLabel(port: number | undefined): string {
  return port === undefined ? 'Preview' : `Preview :${port}`
}

/** The loopback URL the preview webview loads for a forwarded host port. */
export function previewUrl(hostPort: number): string {
  return `http://localhost:${hostPort}/`
}

/**
 * Resolve what the preview URL bar should navigate to. A full http(s) URL is
 * used as-is; anything else is treated as a path (or bare host) on the current
 * forwarded port. Returns null when there's nothing to navigate to.
 */
export function normalizePreviewNav(raw: string, hostPort: number | undefined): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (hostPort === undefined) return null
  const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return `http://localhost:${hostPort}${path}`
}

/** The first detected (previewable) container port among forwarded ports. */
export function firstDetectedPort(ports: { containerPort: number; detected?: boolean }[]): number | null {
  const found = ports.find((p) => p.detected)
  return found ? found.containerPort : null
}
