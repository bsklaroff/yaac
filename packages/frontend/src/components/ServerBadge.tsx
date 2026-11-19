import type { JSX } from 'react'
import { ServerIcon } from '#lib/icons'
import { windowApi } from '#lib/platform'
import { useUiStore } from '#lib/store'
import { YButton } from '#ui'

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
    <YButton
      variant="ghost"
      size="sm"
      onClick={() => useUiStore.getState().navigate(showServers)}
      title={`Connected to ${origin} — choose a server`}
      aria-label="Choose a server"
      // The first badge in the row to give up room, down to its icon (a
      // square button).
      className="min-w-6 shrink-[1000] px-1"
    >
      <ServerIcon size={11} className="shrink-0" />
      <span className="truncate">{serverLabel(origin)}</span>
    </YButton>
  )
}

/**
 * The mobile projects screen's Servers row. It also names the server, since
 * that screen has no status row for the badge.
 */
export function ServersButton(): JSX.Element | null {
  const showServers = windowApi()?.showServers
  if (!showServers) return null
  return (
    <YButton
      variant="bare"
      onClick={() => useUiStore.getState().navigate(showServers)}
      aria-label="Servers"
      className="flex w-full items-center gap-3 px-3 py-3 text-left text-base text-muted transition active:bg-selected"
    >
      <ServerIcon size={18} className="shrink-0" />
      <span>Servers</span>
      <span className="min-w-0 flex-1 truncate text-right text-md text-subtle">
        {serverLabel(window.location.origin)}
      </span>
    </YButton>
  )
}
