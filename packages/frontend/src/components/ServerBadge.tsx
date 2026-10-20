import type { JSX } from 'react'
import { ServerIcon } from '#lib/icons'
import { windowApi } from '#lib/platform'
import { useUiStore } from '#lib/store'

/** host[:port] of the origin, or the origin as-is if it doesn't parse. */
export function serverLabel(origin: string): string {
  try {
    return new URL(origin).host || origin
  } catch {
    return origin
  }
}

/*
 * The SPA's two ways into a native shell's server list (the desktop app's
 * Servers page, or the iPhone app's), where the app's server is chosen. It
 * belongs to the shell, so the server list stays reachable when no server
 * answers. Neither renders outside a shell, where a tab is tied to the
 * origin that served it.
 */

/**
 * Status-row badge naming the connected server, in the desktop sidebar and
 * on the phone layout's workspaces screen. The native apps have no
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
      onClick={() => useUiStore.getState().navigate(showServers)}
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

/**
 * The Servers button above Settings: 'rail' is the desktop rail's 40px chip;
 * 'row' is the mobile project screen's full-width row, which also names the
 * server, since that screen has no status row for the badge.
 */
export function ServersButton({ variant = 'rail' }: { variant?: 'rail' | 'row' } = {}): JSX.Element | null {
  const showServers = windowApi()?.showServers
  if (!showServers) return null
  if (variant === 'row') {
    return (
      <button
        onClick={() => useUiStore.getState().navigate(showServers)}
        aria-label="Servers"
        className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm text-text-dim transition
          active:bg-surface-2"
      >
        <ServerIcon size={18} className="shrink-0" />
        <span>Servers</span>
        <span className="min-w-0 flex-1 truncate text-right text-xs text-text-faint">
          {serverLabel(window.location.origin)}
        </span>
      </button>
    )
  }
  return (
    <button
      onClick={() => useUiStore.getState().navigate(showServers)}
      title="Servers"
      aria-label="Servers"
      className="flex h-10 w-10 items-center justify-center rounded-[20px] text-text-faint transition-all
        hover:rounded-xl hover:text-text-dim"
    >
      <ServerIcon size={18} />
    </button>
  )
}
