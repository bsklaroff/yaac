import { WebglAddon } from '@xterm/addon-webgl'
import type { Terminal } from '@xterm/xterm'

/**
 * Turns xterm's WebGL renderer on only while its terminal is visible.
 *
 * Each WebGL terminal holds its own WebGL2 context, and browsers cap how many
 * a page may keep (~16 in Chrome, fewer in Safari). The app keeps every
 * opened pane mounted, so the count would pass the cap and the browser would
 * evict the oldest context, leaving that terminal blank. Hidden panes are
 * never painted, so they drop their context (see xterm.js#4379).
 *
 * Visible panes need WebGL because xterm's DOM renderer leaves hairline gaps
 * between rows at fractional devicePixelRatios. Call `setVisible` after
 * `term.open()`.
 */
export interface WebglController {
  /** Turn WebGL on when `visible`, free its context when not. Idempotent. */
  setVisible(visible: boolean): void
  /** Tear down for good; call before `term.dispose()`. */
  dispose(): void
}

/**
 * After this many context losses in one burst, stay on the DOM renderer
 * instead of re-creating a context the browser keeps evicting. Showing the
 * pane again resets the count.
 */
const MAX_CONTEXT_LOSSES = 3

/**
 * Losses further apart than this start a new burst, so occasional losses
 * (sleep/wake, GPU reset) on a long-visible pane never reach the cap.
 */
const LOSS_BURST_WINDOW_MS = 30_000

export function createWebglController(term: Terminal): WebglController {
  let addon: WebglAddon | null = null
  let visible = false
  let disposed = false
  // Set when activation throws (no WebGL2); never retry after that.
  let webglUnavailable = false
  let losses = 0
  let lastLossAt = 0

  const load = (): void => {
    if (addon || webglUnavailable || disposed) return
    const next = new WebglAddon()
    next.onContextLoss(() => {
      // The context was lost and not restored. If the pane is still visible,
      // reload WebGL with a fresh context, up to MAX_CONTEXT_LOSSES per burst.
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
      // loadAddon registers the addon before activating it, so dispose the
      // half-loaded instance here.
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
        // The context was discarded while hidden, so redraw everything.
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
