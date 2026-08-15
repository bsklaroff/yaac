import { useEffect, useRef, useState, type JSX } from 'react'
import clsx from 'clsx'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { createSettleGate } from '#lib/attach-settle'
import { clipboardKeyAction } from '#lib/clipboard'
import { LoadingIcon } from '#lib/icons'
import { paneKey, registerPtyInput } from '#lib/ptyInput'
import { patchClickForwarding, patchForcedSelection, patchKeepSelection } from '#lib/selection'
import { patchTouchScroll } from '#lib/touch-scroll'
import { patchWheelPacing } from '#lib/wheel-pacing'
import { CYCLE_IDS, matchShortcut } from '#lib/shortcuts'
import { createWebglController, type WebglController } from '#lib/webgl-renderer'
import {
  parsePongRtt,
  recordRtt,
  RTT_PROBE_INTERVAL_MS,
} from '#lib/link-quality'
import { createOutputBatcher } from '@yaac/shared/batcher'
import { resolveEffectiveTheme } from '#lib/theme'
import { terminalTheme } from '#lib/terminalTheme'
import { useUiStore } from '#store'
import {
  DISCONNECT_NOTICE_DELAY_MS,
  INITIAL_RECONNECT_DELAY_MS,
  nextReconnectDelay,
} from '#lib/reconnect'

// iPadOS reports as "Macintosh" in modern Safari; both want the ⌘ bindings.
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)

/** Keystroke coalescing window. Half the output batcher's, because input is
 *  a trickle next to output and the only thing worth catching is a burst that
 *  is already faster than a human — autorepeat, a paste arriving in pieces,
 *  a TUI's mouse reports. Under a leading-edge policy a lone keypress is
 *  never delayed by it at all. */
const INPUT_BATCH_MS = 4

/**
 * One embedded terminal attached to a worktree's tmux via the server's
 * /pty/attach WebSocket. Binary frames carry raw PTY bytes both ways;
 * text frames carry control (resize). Same-origin, so the worktree cookie
 * rides the upgrade.
 */
export function WorktreeTerminal({
  worktreeId,
  target = 'agent',
  visible = true,
  focusKey,
}: {
  worktreeId: string
  /** /pty/attach target: 'agent', 'shell:<name>', or 'window:@<id>'. */
  target?: string
  /** Whether this pane is on-screen. Drives the WebGL renderer's lifetime:
   *  hidden (kept-alive) panes drop their WebGL context so a page full of
   *  terminals can't exhaust the browser's context budget (see
   *  createWebglController). Defaults to visible for standalone use. */
  visible?: boolean
  /** When this changes to a defined value, drop keyboard focus into the
   *  terminal. The caller bumps it on selecting/opening the worktree; leaving
   *  it undefined (panes that shouldn't grab focus) is a no-op. */
  focusKey?: number
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const webglRef = useRef<WebglController | null>(null)
  // Read the live visibility inside the mount effect (which is keyed on the
  // worktree/target, not visibility) without staling its closure.
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  // Re-render the terminal's palette when the user switches theme (below).
  const themePref = useUiStore((s) => s.themePref)
  // Invisible until the first attach settles: tmux redraws the whole screen
  // on attach (shrinking the oversized worktree window to this grid), and
  // revealing only the settled frame is what keeps a fresh worktree from
  // flashing mid-reflow garbage. Opacity (not display) so FitAddon can
  // measure and size the PTY while hidden.
  const [settled, setSettled] = useState(false)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    setSettled(false)

    const term = new XTerm({
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      cursorBlink: true,
      // Alt is our hand-the-mouse-to-tmux modifier (see patchForcedSelection
      // below); don't let xterm also fake arrow-key presses on Alt+click.
      altClickMovesCursor: false,
      // Follows the app theme (dark terminal on the dark shell, light on the
      // light one) and matches --color-bg so it's seamless with its wrapper.
      // Kept in step with live theme changes by the effect below.
      theme: terminalTheme(resolveEffectiveTheme()),
    })

    // Copy/paste. xterm never copies a selection on its own, so wire the
    // platform-standard bindings: ⌘C/⌘V on mac, Ctrl+Shift+C/V elsewhere.
    term.attachCustomKeyEventHandler((e: KeyboardEvent): boolean => {
      if (e.type !== 'keydown') return true
      // The terminal- and worktree-cycle chords belong to the workspace
      // (window-capture listeners in WorktreeView and App act on them before
      // they ever get here); returning false keeps xterm from also sending
      // the ESC-sequence bytes to the PTY should one slip through.
      const cycleId = matchShortcut(useUiStore.getState().bindings, e)
      if (cycleId !== null && CYCLE_IDS.has(cycleId)) return false
      const action = clipboardKeyAction(e, IS_MAC)
      if (action === 'copy') {
        // preventDefault stops the browser's own copy (which would clobber
        // our clipboard write with the hidden textarea's empty selection)
        // and Chrome's Ctrl+Shift+C devtools shortcut.
        e.preventDefault()
        const sel = term.getSelection()
        if (sel) void navigator.clipboard?.writeText(sel)
        return false
      }
      if (action === 'paste') {
        // Returning false (without preventDefault) keeps xterm from emitting
        // the control byte while still letting the browser fire its native
        // paste event, which xterm's textarea handler turns into a properly
        // bracketed paste — no clipboard-read permission needed.
        return false
      }
      return true
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    // The DOM renderer's per-row CSS-pixel rounding leaves hairline gaps
    // between rows at fractional devicePixelRatios, slicing up solid-colored
    // output; the WebGL renderer tiles rows exactly on the device-pixel grid.
    // Its context is bound to visibility (see createWebglController): enable it
    // now only if this pane mounted on-screen; the effect below tracks flips.
    const webgl = createWebglController(term)
    webglRef.current = webgl
    webgl.setVisible(visibleRef.current)
    // tmux runs with `mouse on`, so stock xterm reports a plain drag to tmux
    // as mouse events and only selects text locally behind a modifier key.
    // Invert that: plain drag selects (copy/paste just works), Alt+drag
    // (Option on macOS) goes to tmux for TUIs that want to drag. A plain click
    // (no drag) is forwarded to tmux separately by patchClickForwarding below,
    // so single-clicking a TUI button needs no modifier either.
    if (!patchForcedSelection(term)) {
      console.warn('xterm internals changed: drag reports to tmux instead of selecting')
    }
    // Keep a selection made to copy from alive until a new one replaces it.
    // Without this xterm drops it on the first keystroke, on a bare mouse
    // move (when the TUI in the pane tracks motion), and on the mouse-mode
    // re-asserts tmux emits on redraws.
    if (!patchKeepSelection(term)) {
      console.warn('xterm internals changed: selection clears eagerly again')
    }
    // Forward a plain click (no drag) to tmux so TUI buttons are clickable
    // without the Alt modifier, while a plain drag still selects for copy.
    const disposeClickForwarding = patchClickForwarding(term)
    if (!disposeClickForwarding) {
      console.warn('xterm internals changed: clicks need Alt to reach the TUI again')
    }
    // Scrolling is a remote operation (tmux redraws per wheel report), so
    // pace reports onto animation frames with a bounded backlog — a flick's
    // momentum tail must not keep the pane scrolling after the gesture ends.
    const disposeWheelPacing = patchWheelPacing(term)
    if (!disposeWheelPacing) {
      console.warn('xterm internals changed: wheel reports reach tmux unpaced')
    }
    // xterm has no touch handling and a touch pan synthesizes no wheel event,
    // so without this a swipe over a pane on a phone scrolls nothing at all.
    const disposeTouchScroll = patchTouchScroll(term)
    if (!disposeTouchScroll) {
      console.warn('xterm internals changed: touch no longer scrolls the pane')
    }
    fit.fit()
    termRef.current = term
    // Expose mounted terminals for the Playwright scripts
    // (test-playwright-scripts/): xterm no longer mirrors scroll state into
    // DOM scroll positions, so scripts asserting on scrollback pinning need
    // the buffer's viewportY/baseY straight from the Terminal object.
    const testHooks = window as unknown as { __xterms?: Set<XTerm> }
    testHooks.__xterms ??= new Set()
    testHooks.__xterms.add(term)

    // Reveal only once the attach has drawn something: a cold worktree's
    // attach can land before the agent paints, and the preamble-only burst
    // must not reveal a blank screen (the gate defers until output that
    // leaves visible cells goes quiet, bounded by its fallback).
    const hasContent = (): boolean => {
      const buf = term.buffer.active
      for (let y = 0; y < term.rows; y++) {
        const line = buf.getLine(buf.baseY + y)
        if (line && line.translateToString(true).trim().length > 0) return true
      }
      return false
    }
    // No scroll pinning is needed at reveal: the tmux client runs in the
    // alternate screen buffer for the whole attach, so there is no xterm
    // scrollback to be unpinned from (viewportY === baseY === 0 always).
    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let noticeTimer: ReturnType<typeof setTimeout> | undefined
    let pingTimer: ReturnType<typeof setInterval> | undefined
    let reconnectDelay = INITIAL_RECONNECT_DELAY_MS
    let closedByUs = false
    const encoder = new TextEncoder()

    // Keystrokes ride a micro-batcher rather than one WebSocket frame each.
    // Autorepeat, a fast typist and a paste that arrives in pieces all emit
    // onData far faster than a slow link can carry that many frames, and each
    // one costs its own WebSocket header and TLS record. The leading-edge
    // policy means a keystroke after any quiet still goes out immediately, so
    // ordinary typing is not delayed at all — only bursts coalesce.
    //
    // Nothing needs clearing when a socket drops: the send below is gated on
    // an OPEN socket, and the reconnect that follows is orders of magnitude
    // slower than the flush window, so pending input can never be replayed
    // into the next socket. It is dropped, exactly as it was before batching.
    const input = createOutputBatcher((d) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(d))
    }, { batchMs: INPUT_BATCH_MS })

    const sendResize = (): void => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    }

    // Re-pin the tmux window to our current grid once the attach settles. The
    // window is pinned server-side by the attach's own resize-window at the
    // size we connected with (window-size manual, see pty-bridge attachArgs) —
    // but a worktree that opened straight into a split resized this pane right
    // after connecting, and that pre-split resize-window can land after the
    // client's follow-up resize frame, leaving the agent window stuck wider
    // than the pane (its output clipped on the right, its bottom prompt wrong)
    // until the next resize. Settle fires well after the attach, so re-sending
    // the settled size here lands last and wins, matching the window to the
    // pane the moment it's revealed.
    const gate = createSettleGate(() => {
      setSettled(true)
      fit.fit()
      sendResize()
    }, { hasContent })

    // (Re)attach to the worktree's tmux. The tmux server in the pod is
    // persistent and survives client detaches, so a fresh socket re-attaches
    // to the same worktree with scrollback intact — which is what makes
    // auto-reconnect lossless here. Backoff mirrors the /events socket
    // (useEvents): 500ms doubling to a 10s cap, reset on open.
    const connect = (): void => {
      // Send the fitted size up-front so the server spawns the PTY at the
      // right dimensions — the tmux window and this grid agree from the
      // first frame, avoiding the cold-start resize that garbles
      // full-screen TUIs.
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const params = new URLSearchParams({ id: worktreeId, target })
      if (term.cols > 0 && term.rows > 0) {
        params.set('cols', String(term.cols))
        params.set('rows', String(term.rows))
      }
      const sock = new WebSocket(`${scheme}://${window.location.host}/pty/attach?${params.toString()}`)
      ws = sock
      sock.binaryType = 'arraybuffer'
      let opened = false

      // Probe the round trip: the server echoes the stamp back, and the
      // difference is what the link-quality store reports. One tiny frame per
      // pane per interval, and it doubles as evidence the socket is alive.
      const sendPing = (): void => {
        if (sock.readyState !== WebSocket.OPEN) return
        sock.send(JSON.stringify({ type: 'ping', t: performance.now() }))
      }

      sock.onopen = (): void => {
        opened = true
        // Back before the pending notice could fire: the drop healed, so it
        // was never worth telling the user about.
        clearTimeout(noticeTimer)
        noticeTimer = undefined
        reconnectDelay = INITIAL_RECONNECT_DELAY_MS
        gate.onOpen()
        fit.fit()
        sendResize()
        sendPing()
        clearInterval(pingTimer)
        pingTimer = setInterval(sendPing, RTT_PROBE_INTERVAL_MS)
      }
      sock.onmessage = (e: MessageEvent): void => {
        if (typeof e.data === 'string') {
          // Control frame: a pong carrying our stamp is a link measurement,
          // anything else (an error, a stamp-less pong) is not for us.
          const rtt = parsePongRtt(e.data, performance.now())
          if (rtt !== null) recordRtt(rtt)
          return
        }
        gate.onData()
        term.write(new Uint8Array(e.data as ArrayBuffer))
      }
      sock.onclose = (): void => {
        // Ignore a stale socket we've already torn down or replaced. Note
        // this precedes stopping the probe: a replacement socket has already
        // installed its own timer over ours, so a late close here must not
        // clear the live pane's.
        if (closedByUs || sock !== ws) return
        clearInterval(pingTimer)
        pingTimer = undefined
        // CAN (0x18) goes out now whether or not anything is ever announced:
        // a stream that died mid-escape-sequence leaves the parser inside
        // that sequence, where it would swallow the notice and the reattach
        // redraw as garbage — CAN returns it to ground from any state.
        if (opened) term.write('\x18')
        // Only announce a drop the user actually had — a connect that never
        // opened (e.g. pod gone) shouldn't spam the screen on every retry —
        // and only one that outlasts a reconnect. A recycled relay transport
        // server-side drops every terminal at once and they all re-attach
        // within a second onto a full tmux repaint, so announcing those made
        // the whole workspace flicker over a blip nobody needed to see. The
        // reveal rides along, so a first-attach drop can't unmask a
        // half-drawn frame with no explanation on it.
        if (opened && noticeTimer === undefined) {
          noticeTimer = setTimeout(() => {
            noticeTimer = undefined
            gate.onClose()
            term.write('\r\n\x1b[2m[disconnected, reconnecting…]\x1b[0m\r\n')
          }, DISCONNECT_NOTICE_DELAY_MS)
        }
        reconnectTimer = setTimeout(connect, reconnectDelay)
        reconnectDelay = nextReconnectDelay(reconnectDelay)
      }
    }

    // Tap the terminal (not a single socket) so input/resize keep flowing to
    // whichever socket is current after a reconnect.
    const dataSub = term.onData((d: string): void => input.push(d))
    const resizeSub = term.onResize((): void => sendResize())

    // Let the mobile accessory key bar type into this pane. Routed through
    // xterm's own input() so a bar-pressed Esc takes exactly the path a typed
    // one does (onData → this socket), including while it's reconnecting.
    const unregisterInput = registerPtyInput(paneKey(worktreeId, target), (d) => term.input(d))

    // A suspended laptop drops the socket silently; the browser often doesn't
    // surface the close until the tab is refocused or the network returns.
    // These wake events re-attach immediately instead of waiting out backoff.
    const reconnectNow = (): void => {
      if (closedByUs) return
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectDelay = INITIAL_RECONNECT_DELAY_MS
      connect()
    }
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return
      reconnectNow()
      // Repaint from the buffer: returning to the tab after a system sleep
      // can leave the WebGL canvas silently blanked (no contextlost fires,
      // so the controller can't see it). The buffer is intact, so one full
      // refresh restores the frame.
      term.refresh(0, term.rows - 1)
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', reconnectNow)

    // Defer the first connection one tick: React dev StrictMode mounts, cleans
    // up, and remounts synchronously, and a WS aborted while still CONNECTING
    // doesn't reliably tear down the proxied upstream — the server-side PTY
    // then leaks (observed holding grouped view worktrees open forever). The
    // canceled timer means the throwaway first mount never connects at all.
    const connectTimer = setTimeout(connect, 0)

    // Refit on any container size change (window resizes, but also split
    // panes opening/closing and divider drags), coalesced to one fit per
    // frame.
    let fitRaf = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(fitRaf)
      fitRaf = requestAnimationFrame(() => fit.fit())
    })
    observer.observe(el)

    return (): void => {
      closedByUs = true
      gate.dispose()
      clearTimeout(connectTimer)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      clearTimeout(noticeTimer)
      clearInterval(pingTimer)
      // Unmount is the one teardown where the tail of a burst can still be
      // delivered: the socket below is closed after this, so it is open now,
      // and the send's OPEN guard makes the flush a no-op if it isn't. (A
      // socket *drop* is the other case, and there the pending input must
      // stay dropped — see the batcher's construction.)
      input.flush()
      input.dispose()
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', reconnectNow)
      observer.disconnect()
      cancelAnimationFrame(fitRaf)
      dataSub.dispose()
      resizeSub.dispose()
      unregisterInput()
      testHooks.__xterms?.delete(term)
      disposeWheelPacing?.()
      disposeTouchScroll?.()
      disposeClickForwarding?.()
      if (ws) {
        // Drop handlers so a late close event can't touch the disposed
        // terminal; if still CONNECTING, close again once open so the
        // proxied upstream is reliably torn down.
        ws.onmessage = null
        ws.onclose = null
        if (ws.readyState === WebSocket.CONNECTING) {
          const sock = ws
          sock.onopen = () => sock.close()
        }
        ws.close()
      }
      // Free the WebGL context before the terminal so a late context-loss
      // callback can't touch a disposed terminal.
      webgl.dispose()
      webglRef.current = null
      term.dispose()
      termRef.current = null
    }
  }, [worktreeId, target])

  // Bind the WebGL context to visibility: a pane going off-screen releases its
  // context (freeing a slot in the browser's limited pool), and coming back
  // re-acquires one and repaints. The mount effect sets the initial state; this
  // tracks later flips.
  useEffect(() => {
    webglRef.current?.setVisible(visible)
  }, [visible])

  // Move keyboard focus into the terminal when the worktree is selected/opened.
  // This focuses xterm's hidden textarea only — it deliberately does NOT
  // synthesize a click on the screen, which would clobber any selection in
  // progress (and, now that plain clicks forward, would reach the TUI as a
  // click).
  useEffect(() => {
    if (focusKey === undefined) return
    termRef.current?.focus()
  }, [focusKey])

  // Repaint the terminal in the app's theme when it changes. themePref covers
  // manual System/Light/Dark switches; the matchMedia listener covers the OS
  // flipping while in 'system'. xterm applies options.theme live.
  useEffect(() => {
    const apply = (): void => {
      if (termRef.current) termRef.current.options.theme = terminalTheme(resolveEffectiveTheme())
    }
    apply()
    const mq = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null
    mq?.addEventListener('change', apply)
    return () => mq?.removeEventListener('change', apply)
  }, [themePref])

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className={clsx('h-full w-full', !settled && 'opacity-0')} />
      {/* While the gate holds the terminal invisible, a connecting notice. */}
      {!settled && (
        <div className="pointer-events-none absolute inset-0 flex animate-fade-in items-center
          justify-center gap-2 text-xs text-text-faint">
          <LoadingIcon size={13} className="animate-spin" />
          Connecting…
        </div>
      )}
    </div>
  )
}
