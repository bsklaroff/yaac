/**
 * The launcher's user-visible state machine. Pure data + pure text mapping,
 * with a tiny DOM renderer — the only part that touches a document, kept
 * separate so everything else tests without jsdom.
 */

export type LauncherErrorKind =
  | 'no-cli'
  | 'server-start-failed'
  | 'no-server'
  | 'unreachable-remote'
  | 'bad-token'

export type LauncherStatus =
  | { phase: 'resolving' }
  | { phase: 'starting-server' }
  | { phase: 'connecting', baseUrl: string }
  | { phase: 'navigating', baseUrl: string }
  | { phase: 'error', kind: LauncherErrorKind, detail?: string }

export interface StatusText {
  title: string
  /** Verbatim machine output (e.g. `yaac server start` stderr). */
  detail?: string
  /** Recovery instructions for error states. */
  hint?: string
}

export function statusText(status: LauncherStatus): StatusText {
  switch (status.phase) {
    case 'resolving':
      return { title: 'Locating yaac server…' }
    case 'starting-server':
      return { title: 'Starting the local yaac server…' }
    case 'connecting':
      return { title: `Connecting to ${status.baseUrl}…` }
    case 'navigating':
      return { title: `Opening ${status.baseUrl}…` }
    case 'error':
      return { ...errorText(status.kind), detail: status.detail }
  }
}

function errorText(kind: LauncherErrorKind): StatusText {
  switch (kind) {
    case 'no-cli':
      return {
        title: 'yaac CLI not found',
        hint: 'Install yaac and make sure it is on PATH, then relaunch the app.',
      }
    case 'server-start-failed':
      return {
        title: 'yaac server failed to start',
        hint: 'Fix the reported problem (or run `yaac server start` in a terminal), then relaunch the app.',
      }
    case 'no-server':
      return {
        title: 'yaac server did not become reachable',
        hint: 'Start it with `yaac server start`, then relaunch the app.',
      }
    case 'unreachable-remote':
      return {
        title: 'Cannot reach the configured remote server',
        hint: 'Check it with `yaac remote status`, or switch back to the local server with `yaac remote off`, then relaunch the app.',
      }
    case 'bad-token':
      // Mirrors the remote BAD_BEARER wording in @yaac/shared/server-client.
      return {
        title: 'Remote server rejected the token',
        hint: 'Mint a new one on the server (yaac auth token create <name>) and run: '
          + 'yaac remote set <url> --token <token> — then relaunch the app.',
      }
  }
}

/** Replace `el`'s children with the rendered status. textContent only — `detail` carries raw stderr. */
export function renderStatus(el: HTMLElement, status: LauncherStatus): void {
  const { title, detail, hint } = statusText(status)
  const doc = el.ownerDocument
  el.replaceChildren()
  const titleEl = doc.createElement('div')
  titleEl.className = 'title'
  titleEl.textContent = title
  el.appendChild(titleEl)
  if (detail) {
    const detailEl = doc.createElement('pre')
    detailEl.className = 'detail'
    detailEl.textContent = detail
    el.appendChild(detailEl)
  }
  if (hint) {
    const hintEl = doc.createElement('div')
    hintEl.className = 'hint'
    hintEl.textContent = hint
    el.appendChild(hintEl)
  }
}
