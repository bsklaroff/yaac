import { WebglAddon } from '@xterm/addon-webgl'
import type { Terminal } from '@xterm/xterm'

/**
 * Manages xterm's WebGL renderer for one terminal, bound to whether that
 * terminal is actually visible.
 *
 * Why gate on visibility: each terminal that turns on the WebGL renderer holds
 * its own live WebGL2 context, and browsers cap how many contexts a page may
 * keep (~16 in Chrome, fewer in Safari). This app keeps every session/pane
 * ever opened mounted — hidden ones held invisible at a frozen rect for
 * instant, resize-free switch-back and a live PTY — so a handful of sessions'
 * worth of agent + shell panes pile up past the cap. The browser then force-evicts the least-recently-used
 * context (`webglcontextlost`), leaving that terminal a blank canvas that
 * reads as a black box until it's poked back to life — the "scroll up and down
 * to see it again" symptom. A hidden pane is never painted, so WebGL buys it
 * nothing: dropping its context while hidden holds the live count at roughly
 * the visible-pane count, comfortably under the cap. See xterm.js#4379.
 *
 * The fallback (xterm's DOM renderer) positions each row on the CSS-pixel grid
 * independently of the device-pixel grid, so at fractional devicePixelRatios
 * it leaves hairline seams between rows in solid-colored output — which is why
 * *visible* panes want WebGL and why the context comes back on show. Call
 * `setVisible` after `term.open()`.
 */
export interface WebglController {
  /** Turn WebGL on when `visible`, free its context when not. Idempotent. */
  setVisible(visible: boolean): void
  /** Tear down for good; call before `term.dispose()`. */
  dispose(): void
}

/**
 * Give up re-establishing WebGL after this many context losses in quick
 * succession and stay on the DOM renderer, rather than thrashing the GPU to
 * re-create a context the browser keeps evicting. A fresh show resets the
 * count, so a later switch-back tries WebGL again.
 */
const MAX_CONTEXT_LOSSES = 3

/**
 * Losses further apart than this are independent incidents (a sleep/wake or
 * GPU reset hours apart), not eviction thrash: the budget refills, so a pane
 * left visible for days isn't permanently downgraded to the DOM renderer by
 * slowly accumulating losses. Only a rapid burst counts toward the cap.
 */
const LOSS_BURST_WINDOW_MS = 30_000

export function createWebglController(term: Terminal): WebglController {
  let addon: WebglAddon | null = null
  let visible = false
  let disposed = false
  // Latches when WebGL2 is unavailable (activation throws): never retry.
  let webglUnavailable = false
  // Context losses in the current burst (thrash guard above).
  let losses = 0
  let lastLossAt = 0

  const load = (): void => {
    if (addon || webglUnavailable || disposed) return
    const next = new WebglAddon()
    next.onContextLoss(() => {
      // Fired once the context was lost and NOT restored within the addon's
      // own grace window. Drop the dead addon; if this pane is still visible,
      // bring WebGL back with a fresh context and repaint — leaving it on the
      // DOM renderer would reintroduce the hairline row gaps. Bounded by
      // MAX_CONTEXT_LOSSES per burst so a browser that keeps evicting us
      // doesn't spin.
      next.dispose()
      if (addon === next) addon = null
      if (!visible || disposed) return
      const now = Date.now()
      if (now - lastLossAt > LOSS_BURST_WINDOW_MS) losses = 0
      lastLossAt = now
      if (++losses > MAX_CONTEXT_LOSSES) return
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

  return {
    setVisible(nextVisible: boolean): void {
      if (disposed || nextVisible === visible) return
      visible = nextVisible
      if (visible) {
        losses = 0
        load()
        // Force a full repaint on show: the context was thrown away while
        // hidden, so the re-activated renderer must redraw the whole viewport
        // (and even a DOM-renderer fallback benefits from the clean redraw).
        term.refresh(0, term.rows - 1)
      } else {
        unload()
      }
    },
    dispose(): void {
      disposed = true
      unload()
    },
  }
}
