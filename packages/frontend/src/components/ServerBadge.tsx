import type { JSX } from 'react'
import { ServerIcon } from '#lib/icons'
import { serverBridge } from '#lib/desktopServer'
import { useUiStore } from '#store'

/** The chit's text: host[:port] of the origin, since the scheme is noise at
 *  this size. Anything unparseable is shown verbatim rather than hidden. */
export function serverLabel(origin: string): string {
  try {
    return new URL(origin).host || origin
  } catch {
    return origin
  }
}

/**
 * Sidebar-header chit naming the server this window is attached to, and the
 * way into Settings → Server to point it somewhere else.
 *
 * Desktop-shell only, on both halves of that: the shell has no address bar,
 * so which server it's on is otherwise invisible, and the switcher this opens
 * exists only behind the same bridge — a browser tab is already attached to
 * the origin that served it, and shows it in the URL bar.
 *
 * The origin is read off the window rather than the bridge: the shell lands
 * the window on the server it attaches to, so `location` is the answer for a
 * remote and a local server alike, with no async round-trip.
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
      className="flex min-w-0 max-w-40 items-center gap-1 rounded bg-surface-2 px-1 py-0.5 text-xs
        font-medium text-text-dim transition hover:bg-surface-3 hover:text-text"
    >
      <ServerIcon size={11} className="shrink-0" />
      <span className="truncate">{serverLabel(origin)}</span>
    </button>
  )
}
