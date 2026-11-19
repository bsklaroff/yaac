import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import clsx from 'clsx'
import { useFindChord } from '#components/ConversationFind'
import { PaneFindBar, useFindQuery } from '#components/FindPanel'
import { windowApi } from '#lib/platform'
import { normalizePreviewNav } from '#lib/preview'
import {
  NavBackIcon, NavForwardIcon, ReloadIcon, OpenLinkIcon, PreviewIcon, LoadingIcon,
  MoreIcon, HomeIcon, CopyIcon, DevToolsIcon, MobileIcon, TabletIcon, DesktopIcon,
  CheckIcon, CloseIcon,
} from '#lib/icons'
import { YButton, YChip, YInput, YMenu, YMenuItem, YMenuLabel, YMenuPopup, YMenuSeparator } from '#ui'

/**
 * The part of Electron's WebviewTag API the preview uses. The element is
 * created imperatively, so this is just a cast target. Methods are called
 * with `?.()` so a call outside Electron can't throw.
 */
interface PreviewWebview extends HTMLElement {
  reload(): void
  reloadIgnoringCache(): void
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  getURL(): string
  loadURL(url: string): Promise<void>
  openDevTools(): void
  getWebContentsId(): number
  findInPage(text: string, options: { forward?: boolean; findNext?: boolean; matchCase?: boolean }): number
  stopFindInPage(action: 'clearSelection' | 'keepSelection'): void
}

/** A page search's latest result: how many matches, and which (1-based) is
 *  selected, 0 for none. */
interface PageFound { matches: number; active: number }
const NOT_FOUND: PageFound = { matches: 0, active: 0 }

/*
 * A hidden preview follows Chrome's background-tab lifecycle
 * (docs/preview-lifecycle.md): it is frozen after FREEZE_AFTER_MS hidden,
 * and discarded after DISCARD_AFTER_MS hidden unless it has been shown again
 * more than MAX_REVISITS_TO_DISCARD times. Under critical memory pressure,
 * one hidden for at least PRESSURE_PROTECTION_MS may be discarded sooner.
 */
const FREEZE_AFTER_MS = 5 * 60_000
const DISCARD_AFTER_MS = 4 * 60 * 60_000
const MAX_REVISITS_TO_DISCARD = 15
const PRESSURE_PROTECTION_MS = 10 * 60_000

/** A hidden preview: when it was hidden, and its discard, which resolves
 *  whether the page went. */
interface HiddenPreview { since: number; discard: () => Promise<boolean> }

/*
 * Every hidden preview, so that each critical memory pressure signal
 * discards one: the longest hidden that may go, as Chrome picks a tab. The
 * desktop app watches for pressure only while one is listed.
 */
const hiddenPreviews = new Set<HiddenPreview>()
let stopPressureWatch: (() => void) | undefined

async function discardLongestHidden(): Promise<void> {
  const now = Date.now()
  const candidates = [...hiddenPreviews]
    .filter((p) => now - p.since >= PRESSURE_PROTECTION_MS)
    .sort((a, b) => a.since - b.since)
  for (const p of candidates) if (await p.discard()) return
}

function listHidden(p: HiddenPreview): () => void {
  hiddenPreviews.add(p)
  stopPressureWatch ??= windowApi()?.onMemoryPressure?.(() => void discardLongestHidden())
  return () => {
    hiddenPreviews.delete(p)
    if (hiddenPreviews.size > 0) return
    stopPressureWatch?.()
    stopPressureWatch = undefined
  }
}

/** A mounted preview's find bar opener, and how to read its guest's id. */
interface FindTarget { guestId: () => number | undefined; open: () => void }

/*
 * Every mounted preview, so that one subscription routes the find chord the
 * desktop app forwards from inside a page to the pane showing that page.
 */
const findTargets = new Set<FindTarget>()
let stopFindWatch: (() => void) | undefined

function listFindTarget(t: FindTarget): () => void {
  findTargets.add(t)
  stopFindWatch ??= windowApi()?.onPreviewFind?.((id) => {
    for (const f of findTargets) if (f.guestId() === id) f.open()
  })
  return () => {
    findTargets.delete(t)
    if (findTargets.size > 0) return
    stopFindWatch?.()
    stopFindWatch = undefined
  }
}

/** Viewport-width presets for the responsive control. `null` = fill the pane. */
const DEVICE_PRESETS: { label: string; width: number | null; Icon: typeof DesktopIcon }[] = [
  { label: 'Full', width: null, Icon: DesktopIcon },
  { label: 'Mobile', width: 375, Icon: MobileIcon },
  { label: 'Tablet', width: 768, Icon: TabletIcon },
]

/**
 * An embedded browser pane showing a dev server in the workspace through
 * one forwarded port, with navigation controls, an address
 * bar, a menu (home, copy URL, responsive widths, hard reload, devtools,
 * stop forwarding) and Cmd/Ctrl-F find, which is Chromium's own find in
 * the page. A chord pressed inside the page reaches the pane through the
 * desktop app, and only when the page has no use for it
 * (packages/desktop/src/menu.ts).
 *
 * The <webview> is managed imperatively through a ref, because letting React
 * reconcile it would reload the page on every parent render. While the pane
 * is hidden the page is frozen and later discarded, and showing the pane
 * again thaws it or reloads it at the URL it was on. Electron only: the
 * iPhone app previews in a native view, and a browser in a new tab.
 */
export function WorkspacePreview({
  workspaceId,
  containerPort,
  url,
  visible,
  focused = false,
  onStopForwarding,
}: {
  workspaceId: string
  /** The workspace port the pane shows. */
  containerPort: number
  /** Where this machine reaches it (its workspace hostname); undefined
   *  while it is not reachable yet. */
  url: string | undefined
  /** Whether the pane is on screen. */
  visible: boolean
  /** Whether it is the pane the user is in, so Cmd/Ctrl-F opens its find. */
  focused?: boolean
  /** Stop forwarding the shown port; omitted where there is no forward to
   *  stop. */
  onStopForwarding?: (containerPort: number) => void
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const wvRef = useRef<PreviewWebview | null>(null)
  const [address, setAddress] = useState(url ?? '')
  const [editing, setEditing] = useState<string | null>(null)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  // Constrain the webview to a device width to check responsive layouts.
  const [deviceWidth, setDeviceWidth] = useState<number | null>(null)
  const [discarded, setDiscarded] = useState(false)
  const find = useFindQuery()
  const [found, setFound] = useState(NOT_FOUND)
  // Bumped by each document load, so an open find bar searches the new page.
  const [pageLoads, setPageLoads] = useState(0)

  const guestId = (): number | undefined => {
    try {
      return wvRef.current?.getWebContentsId()
    } catch {
      return undefined // not attached yet
    }
  }

  // Create the webview once per pane, and again after a discard; wire its
  // navigation events.
  useEffect(() => {
    const host = hostRef.current
    if (!host || discarded) return
    const wv = document.createElement('webview') as unknown as PreviewWebview
    wv.setAttribute('partition', `persist:preview-${workspaceId}`)
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
        // Throws before the guest attaches; a later event re-syncs.
      }
    }
    const onStart = (): void => { setLoading(true); setFailed(false) }
    const onStop = (): void => { setLoading(false); syncNav() }
    const onFound = (e: Event): void => {
      const { result } = e as unknown as { result: { matches: number; activeMatchOrdinal: number } }
      setFound({ matches: result.matches, active: result.activeMatchOrdinal })
    }
    const onLoad = (): void => setPageLoads((n) => n + 1)
    const onFail = (e: Event): void => {
      // -3 (ABORTED) fires on ordinary redirects and reloads.
      const code = (e as unknown as { errorCode?: number }).errorCode
      if (code !== undefined && code !== -3) { setFailed(true); setLoading(false) }
    }
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('did-navigate', syncNav)
    wv.addEventListener('did-navigate-in-page', syncNav)
    wv.addEventListener('did-fail-load', onFail)
    wv.addEventListener('found-in-page', onFound)
    wv.addEventListener('did-finish-load', onLoad)
    host.appendChild(wv)
    wvRef.current = wv

    return () => {
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('did-navigate', syncNav)
      wv.removeEventListener('did-navigate-in-page', syncNav)
      wv.removeEventListener('did-fail-load', onFail)
      wv.removeEventListener('found-in-page', onFound)
      wv.removeEventListener('did-finish-load', onLoad)
      wv.remove()
      wvRef.current = null
    }
  }, [workspaceId, discarded])

  // Point the webview at the forwarded port when it changes, or a new
  // webview back at the page it was discarded on. Compared with the last
  // port URL applied rather than `src`, which Electron rewrites on every
  // navigation: a port that drops and comes back must not reset the page
  // the user navigated to.
  const appliedUrl = useRef<string | null>(null)
  const resumeUrl = useRef<string | null>(null)
  useEffect(() => {
    const wv = wvRef.current
    if (!wv || !url) return
    const dest = appliedUrl.current === url ? resumeUrl.current : url
    if (dest === null) return
    appliedUrl.current = url
    resumeUrl.current = null
    wv.setAttribute('src', dest)
    setAddress(dest)
  }, [url, discarded])

  // While hidden, freeze the page and later discard it, as Chrome does a
  // background tab. A page revisited often is not discarded on the timer.
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const freezeRequested = useRef(false)
  const revisits = useRef(0)
  const wasHidden = useRef(false)
  useEffect(() => {
    const bridge = windowApi()
    if (visible) {
      if (wasHidden.current) revisits.current++
      wasHidden.current = false
      setDiscarded(false)
      const id = guestId()
      if (freezeRequested.current && id !== undefined) void bridge?.setPreviewFrozen?.(id, false)
      freezeRequested.current = false
      return
    }
    wasHidden.current = true
    const freeze = setTimeout(() => {
      const id = guestId()
      if (id === undefined || !bridge?.setPreviewFrozen) return
      freezeRequested.current = true
      void bridge.setPreviewFrozen(id, true)
    }, FREEZE_AFTER_MS)
    const discard = async (): Promise<boolean> => {
      const id = guestId()
      if (id === undefined || !bridge?.canDiscardPreview) return false
      const wv = wvRef.current
      if (!(await bridge.canDiscardPreview(id)) || visibleRef.current || !wv || wv !== wvRef.current) return false
      try {
        resumeUrl.current = wv.getURL() || null
      } catch {
        resumeUrl.current = null
      }
      if (resumeUrl.current === null) appliedUrl.current = null
      freezeRequested.current = false
      wvRef.current = null
      setDiscarded(true)
      return true
    }
    const discardTimer = revisits.current > MAX_REVISITS_TO_DISCARD
      ? undefined
      : setTimeout(() => void discard(), DISCARD_AFTER_MS)
    const unlist = listHidden({ since: Date.now(), discard })
    return () => { clearTimeout(freeze); clearTimeout(discardTimer); unlist() }
  }, [visible])

  // Find: the chord from the pane's own DOM, or from inside its page, which
  // the desktop app forwards with the page's id.
  useFindChord(focused, find.open)
  // find.open only sets state, so the first render's lasts the pane's life.
  useEffect(() => listFindTarget({ guestId, open: find.open }), [])
  const { isOpen: findOpen, spec } = find
  useEffect(() => {
    if (!findOpen) return
    try {
      if (spec.search === '') wvRef.current?.stopFindInPage?.('clearSelection')
      else wvRef.current?.findInPage?.(spec.search, { findNext: true, matchCase: spec.caseSensitive })
    } catch {
      // Throws before the guest attaches.
    }
    if (spec.search === '') setFound(NOT_FOUND)
  }, [findOpen, spec.search, spec.caseSensitive, pageLoads])
  const stepFind = (dir: 1 | -1): void => {
    if (spec.search !== '') wvRef.current?.findInPage?.(spec.search, { forward: dir === 1, matchCase: spec.caseSensitive })
  }
  const closeFind = (): void => {
    try {
      wvRef.current?.stopFindInPage?.('keepSelection')
    } catch {
      // Not attached: nothing to clear.
    }
    find.close()
    setFound(NOT_FOUND)
    wvRef.current?.focus()
  }
  // The page reports only how many matches it has; the bar reads no more.
  const pageMatches = { froms: Array<number>(found.matches).fill(0), tos: [], capped: false }

  const reload = (): void => wvRef.current?.reload?.()
  const hardReload = (): void => wvRef.current?.reloadIgnoringCache?.()
  const goBack = (): void => wvRef.current?.goBack?.()
  const goForward = (): void => wvRef.current?.goForward?.()
  const goHome = (): void => { if (url) void wvRef.current?.loadURL?.(url) }
  const openDevTools = (): void => wvRef.current?.openDevTools?.()
  const copyUrl = (): void => { void navigator.clipboard?.writeText(address || url || '') }
  const openExternal = (): void => { if (url) windowApi()?.openExternal(address || url) }
  const submitAddress = (): void => {
    const dest = normalizePreviewNav(editing ?? '', url)
    if (dest) void wvRef.current?.loadURL?.(dest)
    setEditing(null)
  }

  const activePreset = DEVICE_PRESETS.find((p) => p.width === deviceWidth)

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-1.5">
        <YButton variant="ghost" size="sm" icon={NavBackIcon} onClick={goBack} disabled={!canBack} title="Back" aria-label="Back" />
        <YButton
          variant="ghost"
          size="sm"
          icon={NavForwardIcon}
          onClick={goForward}
          disabled={!canForward}
          title="Forward"
          aria-label="Forward"
        />
        <YButton variant="ghost" size="sm" icon={ReloadIcon} onClick={reload} title="Reload" aria-label="Reload" />
        <YInput
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
          className="flex-1 font-mono not-focus:text-muted"
        />
        {/* The active responsive width, clickable to reset to full. */}
        {activePreset && activePreset.width !== null && (
          <YChip selected onClick={() => setDeviceWidth(null)} title="Reset to full width" aria-label="Reset width">
            {activePreset.label} {activePreset.width}
            <CloseIcon size={9} />
          </YChip>
        )}
        <YButton variant="ghost" size="sm" icon={OpenLinkIcon} onClick={openExternal} title="Open in browser" aria-label="Open in browser" />

        <YMenu.Root>
          <YMenu.Trigger render={<YButton variant="ghost" size="sm" icon={MoreIcon} aria-label="Preview menu" title="More" />} />
          <YMenuPopup side="bottom" align="end" sideOffset={6} className="min-w-[180px]">
            <YMenuItem icon={HomeIcon} onClick={goHome}>Home</YMenuItem>
            <YMenuItem icon={CopyIcon} onClick={copyUrl}>Copy URL</YMenuItem>
            <YMenuSeparator />
            <YMenuLabel>Responsive</YMenuLabel>
            {DEVICE_PRESETS.map((p) => (
              <YMenuItem key={p.label} icon={p.Icon} onClick={() => setDeviceWidth(p.width)}>
                <span className="flex-1">{p.label}{p.width ? ` · ${p.width}` : ''}</span>
                {deviceWidth === p.width && <CheckIcon size={13} />}
              </YMenuItem>
            ))}
            <YMenuSeparator />
            <YMenuItem icon={ReloadIcon} onClick={hardReload}>Reload ignoring cache</YMenuItem>
            <YMenuItem icon={DevToolsIcon} onClick={openDevTools}>Open DevTools</YMenuItem>
            {onStopForwarding && url !== undefined && (
              <>
                <YMenuSeparator />
                <YMenuItem icon={CloseIcon} onClick={() => onStopForwarding(containerPort)}>
                  Stop forwarding :{containerPort}
                </YMenuItem>
              </>
            )}
          </YMenuPopup>
        </YMenu.Root>
      </div>

      {findOpen && (
        <PaneFindBar
          find={find}
          matches={pageMatches}
          current={found.active - 1}
          onStep={stepFind}
          onClose={closeFind}
          caseOnly
        />
      )}
      <div className="relative min-h-0 flex-1 bg-sunken">
        {/* Center the device frame; bg-sunken shows on the sides when narrowed. */}
        <div className="absolute inset-0 flex justify-center overflow-hidden">
          <div
            ref={hostRef}
            style={{ width: deviceWidth ?? '100%' }}
            className={clsx('h-full bg-white', deviceWidth !== null && 'border-x border-line-strong')}
          />
        </div>
        {url === undefined ? (
          <PreviewOverlay>
            <LoadingIcon size={18} className="animate-spin text-subtle" />
            <span>Waiting for the dev server on :{containerPort}…</span>
          </PreviewOverlay>
        ) : failed ? (
          <PreviewOverlay>
            <PreviewIcon size={20} className="text-subtle" />
            <span>Couldn’t load the preview.</span>
            <YButton size="sm" onClick={() => { setFailed(false); reload() }}>Retry</YButton>
          </PreviewOverlay>
        ) : loading ? (
          <div className="pointer-events-none absolute right-2 top-2">
            <LoadingIcon size={14} className="animate-spin text-subtle/70" />
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
      'bg-surface text-md text-muted',
    )}>
      {children}
    </div>
  )
}
