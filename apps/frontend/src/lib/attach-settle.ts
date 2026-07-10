/**
 * Reveal gate for a freshly mounted terminal pane (SessionTerminal).
 *
 * Attaching to a session's tmux repaints the whole screen at the client's
 * size: the window is created oversized so TUIs shrink-then-render (see
 * session-create), and on attach tmux reflows it down to the browser's grid
 * — a frame of rewrapped garbage — before the agent's SIGWINCH repaint
 * settles the screen. On cold (non-prewarmed) sessions the agent's own
 * startup renders interleave too. Watching that settle live is the flash on
 * every new session, so the terminal stays invisible until the attach burst
 * goes quiet and only the settled frame is revealed.
 *
 * The gate settles exactly once, on the earliest of:
 *  - quiet gap: `quietMs` passed with no output after some output arrived —
 *    the attach repaint is done;
 *  - cap: `capMs` after the first output — startup screens that animate
 *    continuously (spinners) never go quiet, and past this point the churn
 *    is the agent legitimately rendering, not attach garbage;
 *  - close-after-open: the socket dropped, so the disconnect notice the
 *    terminal writes must be visible;
 *  - fallback: `fallbackMs` after open with nothing else firing — a safety
 *    net so no edge case can leave a terminal permanently invisible.
 * A close before open stays hidden: nothing was written, and the reconnect
 * loop retries silently.
 *
 * Quiet-gap and cap reveals additionally require `hasContent()` (when
 * given): a cold session's attach can land before the agent has painted
 * anything, so the first burst is only tmux's attach preamble — revealing
 * on it would show a blank screen and then the agent's first paint as a
 * pop. A contentless quiet/cap fire defers instead; the next output re-arms
 * the quiet gap, and the fallback still reveals unconditionally.
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

/** Create a gate that calls `onSettle` once, per the policy above. All
 *  methods are no-ops after settling, so one gate spans reconnects: only
 *  the first attach of a mounted terminal is masked. */
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

  // Quiet/cap fires defer while the screen is still blank; the fallback
  // (and close-after-open) settle regardless.
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
