import { WebglAddon } from '@xterm/addon-webgl'
import type { Terminal } from '@xterm/xterm'

/**
 * Manages xterm's WebGL renderer for one terminal, bound to whether that
 * terminal is actually visible — both within the app (its pane is on-screen)
 * and at the browser level (its tab is frontmost).
 *
 * Why gate on visibility: each terminal that turns on the WebGL renderer holds
 * its own live WebGL2 context, and browsers cap how many contexts a page may
 * keep (~16 in Chrome, fewer in Safari). This app keeps every session/pane
 * ever opened mounted — hidden ones parked off-screen for instant switch-back
 * and a live PTY — so a handful of sessions' worth of agent + shell panes pile
 * up past the cap. The browser then force-evicts the least-recently-used
 * context (`webglcontextlost`), leaving that terminal a blank canvas that
 * reads as a black box until it's poked back to life — the "scroll up and down
 * to see it again" symptom. A hidden pane is never painted, so WebGL buys it
 * nothing: dropping its context while hidden holds the live count at roughly
 * the visible-pane count, comfortably under the cap. See xterm.js#4379.
 *
 * Why *also* gate on the tab (document.visibilityState): a backgrounded tab
 * gets its GPU context reclaimed by the browser too, but there rAF is paused,
 * so the addon can neither repaint on recovery nor even reliably run its
 * restoration timer — and the pane's on-screen `setVisible(true)` state is
 * unchanged, so nothing tells the renderer to rebuild. The result is a
 * context that died in the background and stays a blank box on return until
 * fresh PTY output happens to repaint it (the WebSocket often survives a brief
 * backgrounding, so no reconnect-driven redraw fires either). Treating a
 * hidden tab exactly like a hidden pane fixes both ends: we drop the context
 * on background (rather than burn the loss budget re-acquiring one the browser
 * keeps taking back while nothing can paint), and rebuild it with a full
 * repaint the moment the tab returns.
 *
 * The fallback (xterm's DOM renderer) positions each row on the CSS-pixel grid
 * independently of the device-pixel grid, so at fractional devicePixelRatios
 * it leaves hairline seams between rows in solid-colored output — which is why
 * *visible* panes want WebGL and why the context comes back on show. Call
 * `setVisible` after `term.open()`.
 */
export interface WebglController {
  /** Mark this pane on-screen (or not) within the app. Combined with the tab's
   *  own visibility to decide whether to hold a WebGL context. Idempotent. */
  setVisible(visible: boolean): void
  /** Tear down for good; call before `term.dispose()`. */
  dispose(): void
}

/**
 * Give up re-establishing WebGL after this many context losses within one
 * visible stretch and stay on the DOM renderer, rather than thrashing the GPU
 * to re-create a context the browser keeps evicting. A fresh show resets the
 * count, so a later switch-back tries WebGL again.
 */
const MAX_CONTEXT_LOSSES = 3

export function createWebglController(term: Terminal): WebglController {
  let addon: WebglAddon | null = null
  // On-screen within the app (the caller's setVisible) vs. the tab being
  // frontmost; WebGL is held only when both are true (see `shouldRender`).
  let paneVisible = false
  let disposed = false
  // Latches when WebGL2 is unavailable (activation throws): never retry.
  let webglUnavailable = false
  // Context losses since rendering last (re)started (thrash guard above).
  let losses = 0

  const tabVisible = (): boolean =>
    typeof document === 'undefined' || document.visibilityState === 'visible'
  // Hold a WebGL context only when the pane is on-screen AND its tab is
  // frontmost: a backgrounded tab can't paint (rAF is paused), so a context
  // there is pure liability — the browser reclaims it and we can't recover.
  const shouldRender = (): boolean => paneVisible && tabVisible()

  const load = (): void => {
    if (addon || webglUnavailable || disposed) return
    const next = new WebglAddon()
    next.onContextLoss(() => {
      // Fired once the context was lost and NOT restored within the addon's
      // own grace window. Drop the dead addon; if this pane should still be
      // rendering, bring WebGL back with a fresh context and repaint — leaving
      // it on the DOM renderer would reintroduce the hairline row gaps. Bounded
      // by MAX_CONTEXT_LOSSES so a browser that keeps evicting us doesn't spin;
      // gated on shouldRender() so a loss while backgrounded just drops the
      // context (the tab-return handler rebuilds it) instead of burning the
      // budget re-acquiring one nothing can paint.
      next.dispose()
      if (addon === next) addon = null
      if (!shouldRender() || disposed || ++losses > MAX_CONTEXT_LOSSES) return
      load()
      term.refresh(0, term.rows - 1)
    })
    try {
      term.loadAddon(next)
    } catch {
      // loadAddon registers the addon before activating it, so unregister the
      // half-loaded instance rather than leaving it for term.dispose(). A
      // throw means WebGL2 is unavailable here — don't keep retrying.
      next.dispose()
      webglUnavailable = true
      console.warn('WebGL2 unavailable: DOM renderer may show hairline gaps between rows')
      return
    }
    addon = next
  }

  const unload = (): void => {
    addon?.dispose()
    addon = null
  }

  // Reconcile the live context with shouldRender(): acquire + full-repaint when
  // we should be rendering and aren't, release when we shouldn't. Driven by
  // both setVisible (in-app pane flips) and the tab's visibilitychange.
  const sync = (): void => {
    if (disposed) return
    if (shouldRender()) {
      if (addon) return
      // Fresh start (first show, switch-back, or tab-return): the old context
      // was thrown away, so reset the thrash budget and force a full repaint —
      // the re-activated renderer must redraw the whole viewport, and even a
      // DOM-renderer fallback benefits from the clean redraw.
      losses = 0
      load()
      term.refresh(0, term.rows - 1)
    } else {
      unload()
    }
  }

  // A backgrounded tab loses its GPU context with rAF paused, so it can neither
  // recover nor signal the pane to rebuild; mirror the tab's visibility so we
  // drop the context on background and rebuild+repaint on return.
  const onTabVisibility = (): void => sync()
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onTabVisibility)
  }

  return {
    setVisible(nextVisible: boolean): void {
      if (disposed || nextVisible === paneVisible) return
      paneVisible = nextVisible
      sync()
    },
    dispose(): void {
      disposed = true
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onTabVisibility)
      }
      unload()
    },
  }
}
