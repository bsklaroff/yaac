import type { JSX } from 'react'
import { ServerIcon } from '#lib/icons'
import { serverBridge } from '#lib/desktopServer'
import { useUiStore } from '#lib/store'

/** host[:port] of the origin, or the origin as-is if it doesn't parse. */
export function serverLabel(origin: string): string {
  try {
    return new URL(origin).host || origin
  } catch {
    return origin
  }
}

/**
 * Sidebar-header badge naming the connected server; opens Settings → Server.
 * Desktop app only: it has no address bar, and the server switcher needs the
 * desktop bridge. The window is loaded from the server, so
 * `location.origin` names it.
 */
export function ServerBadge(): JSX.Element | null {
  const openSettings = useUiStore((s) => s.openSettings)
  if (!serverBridge()) return null

  const origin = window.location.origin
  return (
    <button
      type="button"
      onClick={() => openSettings('server')}
      title={`Connected to ${origin} — open server settings`}
      aria-label="Open server settings"
      // The only shrinkable badge in the row: it truncates only when space
      // runs out.
      className="flex min-w-0 items-center gap-1 rounded bg-surface-2 px-1 py-0.5 text-xs
        font-medium text-text-dim transition hover:bg-surface-3 hover:text-text"
    >
      <ServerIcon size={11} className="shrink-0" />
      <span className="truncate">{serverLabel(origin)}</span>
    </button>
  )
}
