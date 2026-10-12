import type { JSX } from 'react'
import { ServerIcon } from '#lib/icons'
import { windowApi } from '#components/WindowControls'

/** host[:port] of the origin, or the origin as-is if it doesn't parse. */
export function serverLabel(origin: string): string {
  try {
    return new URL(origin).host || origin
  } catch {
    return origin
  }
}

/*
 * The SPA's two ways into the desktop shell's Servers page, where the app's
 * server is chosen. It belongs to the shell, so the server list stays
 * reachable when no server answers. Neither renders outside the shell, where
 * a tab is tied to the origin that served it.
 */

/**
 * Sidebar-header badge naming the connected server. The desktop app has no
 * address bar, and the window is loaded from the server, so
 * `location.origin` names it.
 */
export function ServerBadge(): JSX.Element | null {
  const showServers = windowApi()?.showServers
  if (!showServers) return null

  const origin = window.location.origin
  return (
    <button
      type="button"
      onClick={() => showServers()}
      title={`Connected to ${origin} — choose a server`}
      aria-label="Choose a server"
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

/** The rail's Servers button, above Settings. */
export function ServersButton(): JSX.Element | null {
  const showServers = windowApi()?.showServers
  if (!showServers) return null
  return (
    <button
      onClick={() => showServers()}
      title="Servers"
      aria-label="Servers"
      className="flex h-10 w-10 items-center justify-center rounded-[20px] text-text-faint transition-all
        hover:rounded-xl hover:text-text-dim"
    >
      <ServerIcon size={18} />
    </button>
  )
}
