import { isElectron } from '#lib/platform'
import type { PortMapping } from '@yaac/shared/types'

/**
 * Preview panes share the layout with terminals. A workspace has one per
 * forwarded port it previews, each a `preview:<containerPort>` target, so
 * the saved layout keeps which port each pane shows across reloads and
 * server switches.
 */

const PREVIEW_PREFIX = 'preview:'

/** The layout target of the preview pane on one workspace port. */
export function previewTarget(containerPort: number): string {
  return `${PREVIEW_PREFIX}${containerPort}`
}

/**
 * Whether a layout target is a preview pane (vs a terminal). Strict, so a
 * malformed saved target counts as a dead terminal and the window sync
 * drops it.
 */
export function isPreviewTarget(target: string): boolean {
  return /^preview:\d+$/.test(target)
}

/** The workspace port a preview target shows. */
export function previewTargetPort(target: string): number {
  return Number(target.slice(PREVIEW_PREFIX.length))
}

/**
 * A forwarded port's label: the workspace's port, then in the desktop app
 * the local one it holds when that differs (`:3000→:3001`,
 * docs/port-forward-tunnel.md). The iPhone app holds a port only while its
 * own preview is open and labels that preview itself, so here it gets the
 * workspace port alone.
 */
export function portLabel(p: PortMapping): string {
  return isElectron() && p.hostPort !== p.containerPort ? `:${p.containerPort}→:${p.hostPort}` : `:${p.containerPort}`
}

/**
 * Pane/tab label for a preview, e.g. "Preview :5173": bare when no port, and
 * the workspace port alone when given only that (a pane whose port is not
 * forwarded right now).
 */
export function previewLabel(port: PortMapping | number | undefined): string {
  if (port === undefined) return 'Preview'
  return `Preview ${typeof port === 'number' ? `:${port}` : portLabel(port)}`
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
