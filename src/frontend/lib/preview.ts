/**
 * Preview panes live in the same tiling layout tree as terminals, so they are
 * keyed by a `target` string like everything else. A preview target encodes
 * the container port of the dev server it shows: `preview:5173`. These helpers
 * mint and read that convention; SessionView branches on `isPreviewTarget` to
 * render a browser pane instead of a terminal.
 */

const PREVIEW_PREFIX = 'preview:'

/** The layout target for a preview of a given container port. */
export function previewTarget(containerPort: number): string {
  return `${PREVIEW_PREFIX}${containerPort}`
}

/** Whether a layout target is a preview pane (vs a terminal). */
export function isPreviewTarget(target: string): boolean {
  return target.startsWith(PREVIEW_PREFIX)
}

/** The container port a preview target refers to, or null if it isn't one. */
export function previewPort(target: string): number | null {
  if (!isPreviewTarget(target)) return null
  const n = Number(target.slice(PREVIEW_PREFIX.length))
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Pane/tab label for a preview target, e.g. "Preview :5173". */
export function previewLabel(target: string): string {
  const port = previewPort(target)
  return port === null ? 'Preview' : `Preview :${port}`
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
