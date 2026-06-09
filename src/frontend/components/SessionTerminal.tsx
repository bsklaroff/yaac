import { useEffect, useRef, type JSX } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

/**
 * One embedded terminal attached to a session's tmux via the daemon's
 * /pty/attach WebSocket. Binary frames carry raw PTY bytes both ways;
 * text frames carry control (resize). Same-origin, so the session cookie
 * rides the upgrade.
 */
export function SessionTerminal({ sessionId }: { sessionId: string }): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const term = new XTerm({
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      cursorBlink: true,
      // Matches --color-surface so the terminal blends into the floating pane.
      theme: { background: '#141417', foreground: '#e7e7ea' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    fit.fit()

    // Send the fitted size up-front so the daemon spawns the PTY at the right
    // dimensions — the tmux window and this grid agree from the first frame,
    // avoiding the cold-start resize that garbles full-screen TUIs.
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const params = new URLSearchParams({ id: sessionId })
    if (term.cols > 0 && term.rows > 0) {
      params.set('cols', String(term.cols))
      params.set('rows', String(term.rows))
    }
    const ws = new WebSocket(`${scheme}://${window.location.host}/pty/attach?${params.toString()}`)
    ws.binaryType = 'arraybuffer'
    const encoder = new TextEncoder()

    const sendResize = (): void => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    }

    ws.onopen = (): void => {
      fit.fit()
      sendResize()
    }
    ws.onmessage = (e: MessageEvent): void => {
      if (typeof e.data === 'string') return // control frame (error/pong)
      term.write(new Uint8Array(e.data as ArrayBuffer))
    }
    ws.onclose = (): void => {
      term.write('\r\n\x1b[2m[disconnected]\x1b[0m\r\n')
    }

    const dataSub = term.onData((d: string): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(d))
    })
    const resizeSub = term.onResize((): void => sendResize())

    const onWindowResize = (): void => fit.fit()
    window.addEventListener('resize', onWindowResize)

    return (): void => {
      window.removeEventListener('resize', onWindowResize)
      dataSub.dispose()
      resizeSub.dispose()
      ws.close()
      term.dispose()
    }
  }, [sessionId])

  return <div ref={containerRef} className="h-full w-full" />
}
