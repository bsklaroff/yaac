import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import clsx from 'clsx'
import { isElectron } from '@/frontend/lib/platform'
import { windowApi } from '@/frontend/components/WindowControls'
import { previewUrl, normalizePreviewNav } from '@/frontend/lib/preview'
import { NavBackIcon, NavForwardIcon, ReloadIcon, OpenLinkIcon, PreviewIcon, LoadingIcon } from '@/frontend/lib/icons'
import type { PortMapping } from '@/shared/types'

/**
 * The subset of Electron's WebviewTag DOM API the preview drives. The element
 * is created imperatively (below), so this is a plain cast target — no JSX
 * intrinsic-element augmentation, which avoids cross-tsconfig type friction.
 */
interface PreviewWebview extends HTMLElement {
  reload(): void
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  getURL(): string
  loadURL(url: string): Promise<void>
}

/**
 * A per-session embedded browser pane pointed at a dev server running inside
 * the session pod (reached over a loopback forwarded port). The chrome —
 * back/forward/reload, an editable address, open-external — follows the app
 * theme; the webview shows the app in its own colors, VS-Code-terminal style.
 *
 * The <webview> is created and driven imperatively in a ref: letting React
 * reconcile it would reload the page (losing scroll/route) on every parent
 * render. Only available in Electron; a browser build shows a fallback link.
 */
export function SessionPreview({
  sessionId,
  ports,
  currentPort,
  onSwitchPort,
}: {
  sessionId: string
  /** Detected, previewable forwarded ports for the session. */
  ports: PortMapping[]
  /** Which container port the pane currently shows. */
  currentPort: number | undefined
  /** Switch the pane to another detected port (the toolbar dropdown). */
  onSwitchPort: (containerPort: number) => void
}): JSX.Element {
  const shownPort = currentPort ?? ports[0]?.containerPort
  const hostPort = ports.find((p) => p.containerPort === shownPort)?.hostPort
  const url = hostPort !== undefined ? previewUrl(hostPort) : null
  const electron = isElectron()

  const hostRef = useRef<HTMLDivElement>(null)
  const wvRef = useRef<PreviewWebview | null>(null)
  const [address, setAddress] = useState(url ?? '')
  const [editing, setEditing] = useState<string | null>(null)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  // Create the webview once per session; wire its navigation events.
  useEffect(() => {
    if (!electron) return
    const host = hostRef.current
    if (!host) return
    const wv = document.createElement('webview') as unknown as PreviewWebview
    wv.setAttribute('partition', `persist:preview-${sessionId}`)
    wv.setAttribute('allowpopups', 'true')
    wv.style.width = '100%'
    wv.style.height = '100%'
    wv.style.border = '0'

    const syncNav = (): void => {
      try {
        setAddress(wv.getURL())
        setCanBack(wv.canGoBack())
        setCanForward(wv.canGoForward())
      } catch {
        // methods throw before the guest attaches; a later event re-syncs
      }
    }
    const onStart = (): void => { setLoading(true); setFailed(false) }
    const onStop = (): void => { setLoading(false); syncNav() }
    const onFail = (e: Event): void => {
      // -3 (ABORTED) fires on ordinary redirects/reloads, not a real failure.
      const code = (e as unknown as { errorCode?: number }).errorCode
      if (code !== undefined && code !== -3) { setFailed(true); setLoading(false) }
    }
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('did-navigate', syncNav)
    wv.addEventListener('did-navigate-in-page', syncNav)
    wv.addEventListener('did-fail-load', onFail)
    host.appendChild(wv)
    wvRef.current = wv

    return () => {
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('did-navigate', syncNav)
      wv.removeEventListener('did-navigate-in-page', syncNav)
      wv.removeEventListener('did-fail-load', onFail)
      wv.remove()
      wvRef.current = null
    }
  }, [electron, sessionId])

  // Point the webview at the current forwarded port when it (re)appears.
  useEffect(() => {
    const wv = wvRef.current
    if (!wv || !url) return
    if (wv.getAttribute('src') !== url) {
      wv.setAttribute('src', url)
      setAddress(url)
    }
  }, [url])

  const reload = (): void => wvRef.current?.reload()
  const goBack = (): void => wvRef.current?.goBack()
  const goForward = (): void => wvRef.current?.goForward()
  const openExternal = (): void => { if (url) windowApi()?.openExternal(address || url) }
  const submitAddress = (): void => {
    const dest = normalizePreviewNav(editing ?? '', hostPort)
    if (dest) void wvRef.current?.loadURL(dest)
    setEditing(null)
  }

  // Browser build (no webview): a plain link to the forwarded port.
  if (!electron) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
        <PreviewIcon size={22} className="text-text-faint" />
        <p className="text-xs text-text-dim">The embedded preview is available in the desktop app.</p>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="rounded bg-surface-2 px-2 py-1 font-mono text-[11px] text-text-dim transition hover:text-text"
          >
            Open localhost:{hostPort}
          </a>
        )}
      </div>
    )
  }

  const iconBtn = 'flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-dim '
    + 'transition hover:bg-surface-2 hover:text-text disabled:opacity-30 disabled:hover:bg-transparent'

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-hairline px-1.5">
        <button onClick={goBack} disabled={!canBack} title="Back" aria-label="Back" className={iconBtn}>
          <NavBackIcon size={13} />
        </button>
        <button onClick={goForward} disabled={!canForward} title="Forward" aria-label="Forward" className={iconBtn}>
          <NavForwardIcon size={13} />
        </button>
        <button onClick={reload} title="Reload" aria-label="Reload" className={iconBtn}>
          <ReloadIcon size={12} />
        </button>
        {ports.length > 1 && (
          <select
            value={shownPort}
            onChange={(e) => onSwitchPort(Number(e.target.value))}
            aria-label="Preview port"
            className="shrink-0 rounded bg-bg px-1 py-0.5 font-mono text-[11px] text-text-dim outline-none"
          >
            {ports.map((p) => (
              <option key={p.containerPort} value={p.containerPort}>:{p.containerPort}</option>
            ))}
          </select>
        )}
        <input
          value={editing ?? address}
          onChange={(e) => setEditing(e.target.value)}
          onFocus={(e) => { setEditing(address); e.currentTarget.select() }}
          onBlur={() => setEditing(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitAddress()
            else if (e.key === 'Escape') { setEditing(null); e.currentTarget.blur() }
          }}
          spellCheck={false}
          aria-label="Preview address"
          className="min-w-0 flex-1 rounded bg-bg px-2 py-0.5 font-mono text-[11px] text-text-dim
            outline-none focus:text-text"
        />
        <button onClick={openExternal} title="Open in browser" aria-label="Open in browser" className={iconBtn}>
          <OpenLinkIcon size={12} />
        </button>
      </div>

      <div className="relative min-h-0 flex-1 bg-white">
        <div ref={hostRef} className="absolute inset-0" />
        {hostPort === undefined ? (
          <PreviewOverlay>
            <LoadingIcon size={18} className="animate-spin text-text-faint" />
            <span>Waiting for the dev server{shownPort ? ` on port ${shownPort}` : ''}…</span>
          </PreviewOverlay>
        ) : failed ? (
          <PreviewOverlay>
            <PreviewIcon size={20} className="text-text-faint" />
            <span>Couldn’t load the preview.</span>
            <button
              onClick={() => { setFailed(false); reload() }}
              className="rounded bg-surface-2 px-2 py-1 text-[11px] text-text-dim transition hover:text-text"
            >
              Retry
            </button>
          </PreviewOverlay>
        ) : loading ? (
          <div className="pointer-events-none absolute right-2 top-2">
            <LoadingIcon size={14} className="animate-spin text-text-faint/70" />
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** Centered message shown over the (blank) webview for waiting/error states. */
function PreviewOverlay({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className={clsx(
      'absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center',
      'bg-surface text-xs text-text-dim',
    )}>
      {children}
    </div>
  )
}
