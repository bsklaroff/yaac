import { useEffect, useRef, type JSX } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { clipboardKeyAction } from '@/frontend/lib/clipboard'

// iPadOS reports as "Macintosh" in modern Safari; both want the ⌘ bindings.
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)

/**
 * One embedded terminal attached to a session's tmux via the daemon's
 * /pty/attach WebSocket. Binary frames carry raw PTY bytes both ways;
 * text frames carry control (resize). Same-origin, so the session cookie
 * rides the upgrade.
 */
export function SessionTerminal({
  sessionId,
  target = 'agent',
  focusKey,
}: {
  sessionId: string
  /** /pty/attach target: 'agent', 'shell:<name>', or 'window:@<id>'. */
  target?: string
  /** When this changes to a defined value, drop keyboard focus into the
   *  terminal. The caller bumps it on selecting/opening the session; leaving
   *  it undefined (panes that shouldn't grab focus) is a no-op. */
  focusKey?: number
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const term = new XTerm({
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      cursorBlink: true,
      // tmux runs with `mouse on`, so a plain drag is forwarded to tmux as a
      // mouse event rather than selecting text. xterm only does a local
      // selection when "forced" with a modifier: Shift+drag on Linux/Windows
      // (built in), or Option+drag on macOS — but only when this is enabled.
      macOptionClickForcesSelection: true,
      // Matches --color-bg: the terminal sits in its own dark rounded block
      // inset within the surface card.
      theme: {
        background: '#0b0b0d',
        foreground: '#e7e7ea',
        // A clearly visible highlight for mouse selections to copy from.
        selectionBackground: '#3a3d4d',
      },
    })

    // Copy/paste. xterm never copies a selection on its own, so wire the
    // platform-standard bindings: ⌘C/⌘V on mac, Ctrl+Shift+C/V elsewhere.
    term.attachCustomKeyEventHandler((e: KeyboardEvent): boolean => {
      if (e.type !== 'keydown') return true
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
    fit.fit()
    termRef.current = term

    let ws: WebSocket | null = null
    let dataSub: { dispose(): void } | null = null
    let resizeSub: { dispose(): void } | null = null

    // Defer the connection one tick: React dev StrictMode mounts, cleans up,
    // and remounts synchronously, and a WS aborted while still CONNECTING
    // doesn't reliably tear down the proxied upstream — the daemon-side PTY
    // then leaks (observed holding grouped view sessions open forever). The
    // canceled timer means the throwaway first mount never connects at all.
    const connectTimer = setTimeout(() => {
      // Send the fitted size up-front so the daemon spawns the PTY at the
      // right dimensions — the tmux window and this grid agree from the
      // first frame, avoiding the cold-start resize that garbles
      // full-screen TUIs.
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const params = new URLSearchParams({ id: sessionId, target })
      if (term.cols > 0 && term.rows > 0) {
        params.set('cols', String(term.cols))
        params.set('rows', String(term.rows))
      }
      const sock = new WebSocket(`${scheme}://${window.location.host}/pty/attach?${params.toString()}`)
      ws = sock
      sock.binaryType = 'arraybuffer'
      const encoder = new TextEncoder()

      const sendResize = (): void => {
        if (sock.readyState === WebSocket.OPEN) {
          sock.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
        }
      }

      sock.onopen = (): void => {
        fit.fit()
        sendResize()
      }
      sock.onmessage = (e: MessageEvent): void => {
        if (typeof e.data === 'string') return // control frame (error/pong)
        term.write(new Uint8Array(e.data as ArrayBuffer))
      }
      sock.onclose = (): void => {
        term.write('\r\n\x1b[2m[disconnected]\x1b[0m\r\n')
      }

      dataSub = term.onData((d: string): void => {
        if (sock.readyState === WebSocket.OPEN) sock.send(encoder.encode(d))
      })
      resizeSub = term.onResize((): void => sendResize())
    }, 0)

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
      clearTimeout(connectTimer)
      observer.disconnect()
      cancelAnimationFrame(fitRaf)
      dataSub?.dispose()
      resizeSub?.dispose()
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
      term.dispose()
      termRef.current = null
    }
  }, [sessionId, target])

  // Move keyboard focus into the terminal when the session is selected/opened.
  // This focuses xterm's hidden textarea only — it deliberately does NOT
  // synthesize a click on the screen, which (tmux mouse mode is on) would be
  // forwarded as a mouse event and could trigger an action in the TUI.
  useEffect(() => {
    if (focusKey === undefined) return
    termRef.current?.focus()
  }, [focusKey])

  return <div ref={containerRef} className="h-full w-full" />
}
