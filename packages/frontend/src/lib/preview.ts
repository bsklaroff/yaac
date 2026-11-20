import type { PortMapping } from '@yaac/shared/types'
import { workspaceHostUrl } from '@yaac/shared/workspace-hosts'

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

/** A forwarded port's label: the workspace's port, e.g. `:5173`. */
export function portLabel(p: PortMapping): string {
  return `:${p.containerPort}`
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
 * Resolve what the preview URL bar should navigate to. A full http(s) URL is
 * used as-is; anything else is treated as a path under the preview's own
 * URL. Returns null when there's nothing to navigate to.
 */
export function normalizePreviewNav(raw: string, home: string | undefined): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (home === undefined) return null
  return home + trimmed.replace(/^\//, '')
}

/**
 * A preview pane's address as another browser can use it. The pane's
 * `localhost:<port>` reaches its workspace only through the pane's own
 * proxy, so a loopback http URL becomes the port's workspace hostname,
 * routed at `routerPort`, with its path, query and fragment kept
 * (docs/workspace-hostnames.md). Anything else, or with nothing routing
 * the names, is returned as it is.
 */
export function shareablePreviewUrl(raw: string, workspaceId: string, routerPort: number | null): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return raw
  }
  if (routerPort === null || url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    return raw
  }
  const host = new URL(workspaceHostUrl(workspaceId, Number(url.port || 80), routerPort))
  url.host = host.host
  return url.href
}
