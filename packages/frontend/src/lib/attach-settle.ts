/**
 * Decides when a newly mounted terminal pane (WorkspaceTerminal) becomes
 * visible.
 *
 * The tmux window is created larger than any real terminal, so on attach
 * tmux shrinks it to the browser's size. That produces a frame of rewrapped
 * garbage before the agent repaints. The terminal stays hidden until this
 * burst of output settles, so the user sees only the final frame.
 *
 * The gate settles once, on the earliest of:
 *  - quiet: `quietMs` with no output after some output arrived;
 *  - cap: `capMs` after the first output, since animated startup screens
 *    (spinners) never go quiet;
 *  - close after open: the disconnect notice must be visible;
 *  - fallback: `fallbackMs` after open, so a terminal is never left hidden.
 * A close before open stays hidden while the reconnect loop retries.
 *
 * Quiet and cap also require `hasContent()` when given: on a cold workspace
 * the first burst may be only tmux's attach preamble, and revealing a blank
 * screen would make the agent's first paint pop. The next output re-arms
 * the quiet timer, and the fallback reveals regardless.
 */

export const SETTLE_QUIET_MS = 200
export const SETTLE_CAP_MS = 700
export const SETTLE_FALLBACK_MS = 3000

export interface SettleTimings {
  quietMs: number
  capMs: number
  fallbackMs: number
}

export interface SettleGate {
  /** Socket opened: arm the fallback timer. */
  onOpen(): void
  /** PTY output arrived: (re)arm the quiet gap; the first chunk arms the cap. */
  onData(): void
  /** Socket closed: settle if it had opened, so the disconnect notice shows. */
  onClose(): void
  /** Whether the gate has settled (the terminal is revealed). */
  settled(): boolean
  /** Cancel pending timers without settling (component unmount). */
  dispose(): void
}

/** Create a gate that calls `onSettle` once. All methods are no-ops after
 *  that, so only the first attach of a mounted terminal is hidden. */
export function createSettleGate(
  onSettle: () => void,
  opts: { hasContent?: () => boolean; timings?: SettleTimings } = {},
): SettleGate {
  const timings = opts.timings ?? {
    quietMs: SETTLE_QUIET_MS,
    capMs: SETTLE_CAP_MS,
    fallbackMs: SETTLE_FALLBACK_MS,
  }
  let done = false
  let opened = false
  let sawData = false
  let quietTimer: ReturnType<typeof setTimeout> | undefined
  let capTimer: ReturnType<typeof setTimeout> | undefined
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined

  const clearTimers = (): void => {
    clearTimeout(quietTimer)
    clearTimeout(capTimer)
    clearTimeout(fallbackTimer)
  }

  const settle = (): void => {
    if (done) return
    done = true
    clearTimers()
    onSettle()
  }

  const settleIfContent = (): void => {
    if (done) return
    if (opts.hasContent && !opts.hasContent()) return
    settle()
  }

  return {
    onOpen(): void {
      if (done) return
      opened = true
      clearTimeout(fallbackTimer)
      fallbackTimer = setTimeout(settle, timings.fallbackMs)
    },
    onData(): void {
      if (done) return
      if (!sawData) {
        sawData = true
        capTimer = setTimeout(settleIfContent, timings.capMs)
      }
      clearTimeout(quietTimer)
      quietTimer = setTimeout(settleIfContent, timings.quietMs)
    },
    onClose(): void {
      if (done) return
      if (opened) settle()
    },
    settled(): boolean {
      return done
    },
    dispose(): void {
      done = true
      clearTimers()
    },
  }
}
