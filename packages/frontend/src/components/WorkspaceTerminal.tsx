import { useEffect, useRef, useState, type JSX } from 'react'
import clsx from 'clsx'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { createSettleGate } from '#lib/attach-settle'
import { clipboardImages, imageFiles, prepareImage, uploadAttachment } from '#lib/attachments'
import { clipboardKeyAction } from '#lib/clipboard'
import { IS_MAC } from '#lib/platform'
import { CloseIcon, LoadingIcon } from '#lib/icons'
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
import { useUiStore } from '#lib/store'
import {
  DISCONNECT_NOTICE_DELAY_MS,
  INITIAL_RECONNECT_DELAY_MS,
  nextReconnectDelay,
} from '#lib/reconnect'

/** Keystroke coalescing window, for bursts faster than a human types
 *  (autorepeat, a paste in pieces, mouse reports). The batcher sends on the
 *  leading edge, so a lone keypress is never delayed. */
const INPUT_BATCH_MS = 4

/**
 * One terminal attached to a workspace's tmux over the server's /pty/attach
 * WebSocket. Binary frames carry raw PTY bytes both ways; text frames carry
 * control messages (resize, ping/pong).
 */
export function WorkspaceTerminal({
  workspaceId,
  target = 'agent',
  visible = true,
  focusKey,
}: {
  workspaceId: string
  /** /pty/attach target: 'agent', 'shell:<name>', or 'window:@<id>'. */
  target?: string
  /** Whether this pane is on-screen. Hidden panes drop their WebGL context
   *  (see createWebglController). */
  visible?: boolean
  /** Focus the terminal whenever this changes to a defined value. The
   *  caller bumps it when the workspace is selected or opened. */
  focusKey?: number
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const webglRef = useRef<WebglController | null>(null)
  // Lets the mount effect read the current visibility without depending on it.
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const themePref = useUiStore((s) => s.themePref)
  // Hidden until the first attach settles (see #lib/attach-settle). Uses
  // opacity rather than display so FitAddon can still measure.
  const [settled, setSettled] = useState(false)
  /** Pasted or dropped images still uploading, and the last upload error,
   *  shown over the pane. */
  const [uploading, setUploading] = useState(0)
  const [uploadError, setUploadError] = useState<string | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    setSettled(false)

    const term = new XTerm({
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      cursorBlink: true,
      // Scrollback lives in tmux. An xterm scrollback would only flash the
      // scrollbar as lines scroll into it.
      scrollback: 0,
      // Alt+click goes to tmux (see patchForcedSelection); don't also
      // send arrow keys for it.
      altClickMovesCursor: false,
      theme: terminalTheme(resolveEffectiveTheme()),
    })

    // Copy/paste with the platform's bindings (see clipboardKeyAction).
    term.attachCustomKeyEventHandler((e: KeyboardEvent): boolean => {
      if (e.type !== 'keydown') return true
      // Cycle chords are handled by window listeners in WorkspaceView and
      // App; don't also send them to the PTY.
      const cycleId = matchShortcut(useUiStore.getState().bindings, e)
      if (cycleId !== null && CYCLE_IDS.has(cycleId)) return false
      const action = clipboardKeyAction(e, IS_MAC)
      if (action === 'copy') {
        // Block the browser's own copy (an empty selection that would
        // overwrite ours) and Chrome's Ctrl+Shift+C devtools shortcut.
        e.preventDefault()
        const sel = term.getSelection()
        if (sel) void navigator.clipboard?.writeText(sel)
        return false
      }
      if (action === 'paste') {
        // Return false without preventDefault: xterm doesn't send the
        // control byte, and the browser's paste event still reaches xterm
        // as a bracketed paste.
        //
        // A Shift paste (Ctrl+Shift+V) pastes plain text only, so read the
        // clipboard for images. If the paste event carried one anyway,
        // `onPaste` has already claimed it and this read skips it.
        if (e.shiftKey) {
          pasteClaimed = false
          void clipboardImages().then((files) => {
            if (files.length > 0 && !pasteClaimed) attach(files)
          })
        }
        return false
      }
      return true
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    // WebGL avoids the DOM renderer's hairline row gaps (see
    // createWebglController); an effect below tracks visibility.
    const webgl = createWebglController(term)
    webglRef.current = webgl
    webgl.setVisible(visibleRef.current)
    // Mouse patches (see #lib/selection, #lib/wheel-pacing, #lib/touch-scroll):
    // plain drag selects, Alt+drag and plain clicks go to tmux, selections
    // survive mouse reports, and wheel and touch scrolling are paced.
    if (!patchForcedSelection(term)) {
      console.warn('xterm internals changed: drag reports to tmux instead of selecting')
    }
    if (!patchKeepSelection(term)) {
      console.warn('xterm internals changed: selection clears eagerly again')
    }
    const disposeClickForwarding = patchClickForwarding(term)
    if (!disposeClickForwarding) {
      console.warn('xterm internals changed: clicks need Alt to reach the TUI again')
    }
    const disposeWheelPacing = patchWheelPacing(term)
    if (!disposeWheelPacing) {
      console.warn('xterm internals changed: wheel reports reach tmux unpaced')
    }
    const disposeTouchScroll = patchTouchScroll(term)
    if (!disposeTouchScroll) {
      console.warn('xterm internals changed: touch no longer scrolls the pane')
    }
    fit.fit()
    termRef.current = term
    // Expose mounted terminals to the Playwright scripts
    // (test-playwright-scripts/), which read buffer state from them.
    const testHooks = window as unknown as { __xterms?: Set<XTerm> }
    testHooks.__xterms ??= new Set()
    testHooks.__xterms.add(term)

    // Whether any visible cell has content, so the gate doesn't reveal a
    // blank screen.
    const hasContent = (): boolean => {
      const buf = term.buffer.active
      for (let y = 0; y < term.rows; y++) {
        const line = buf.getLine(buf.baseY + y)
        if (line && line.translateToString(true).trim().length > 0) return true
      }
      return false
    }
    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let noticeTimer: ReturnType<typeof setTimeout> | undefined
    let pingTimer: ReturnType<typeof setInterval> | undefined
    let reconnectDelay = INITIAL_RECONNECT_DELAY_MS
    let closedByUs = false
    const encoder = new TextEncoder()

    // Batch keystrokes so bursts share a frame instead of one frame per
    // onData. Input pending when the socket drops is discarded, since the
    // send requires an OPEN socket and reconnecting takes far longer than
    // the batch window.
    const input = createOutputBatcher((d) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(d))
    }, { batchMs: INPUT_BATCH_MS })

    const sendResize = (): void => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    }

    const gate = createSettleGate(() => setSettled(true), { hasContent })

    // (Re)attach to the workspace's tmux. tmux outlives client detaches, so
    // reconnecting loses nothing. Backoff is shared with useEvents
    // (#lib/reconnect).
    const connect = (): void => {
      // Send the fitted size so the PTY starts at the right dimensions and
      // full-screen TUIs don't garble on a resize.
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const params = new URLSearchParams({ id: workspaceId, target })
      if (term.cols > 0 && term.rows > 0) {
        params.set('cols', String(term.cols))
        params.set('rows', String(term.rows))
      }
      const sock = new WebSocket(`${scheme}://${window.location.host}/api/pty/attach?${params.toString()}`)
      ws = sock
      sock.binaryType = 'arraybuffer'
      let opened = false

      // Measure the round trip for #lib/link-quality.
      const sendPing = (): void => {
        if (sock.readyState !== WebSocket.OPEN) return
        sock.send(JSON.stringify({ type: 'ping', t: performance.now() }))
      }

      sock.onopen = (): void => {
        opened = true
        // Reconnected before the notice showed; cancel it.
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
          // Control frame: only a timed pong is used.
          const rtt = parsePongRtt(e.data, performance.now())
          if (rtt !== null) recordRtt(rtt)
          return
        }
        gate.onData()
        term.write(new Uint8Array(e.data as ArrayBuffer))
      }
      sock.onclose = (): void => {
        // Ignore a stale socket, before touching the ping timer, which a
        // replacement socket may already own.
        if (closedByUs || sock !== ws) return
        clearInterval(pingTimer)
        pingTimer = undefined
        // CAN (0x18) resets the parser in case the stream died inside an
        // escape sequence, which would otherwise swallow what comes next.
        if (opened) term.write('\x18')
        // Announce only a drop of an opened socket that outlasts
        // DISCONNECT_NOTICE_DELAY_MS; most heal within a second. The reveal
        // happens with the notice, so a half-drawn frame isn't shown
        // unexplained.
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

    // Subscribed on the terminal, so they follow reconnects to the new socket.
    const dataSub = term.onData((d: string): void => input.push(d))
    const resizeSub = term.onResize((): void => sendResize())

    // A pasted or dropped image is uploaded to the workspace and its path
    // pasted instead, which agent TUIs turn into an attachment
    // (docs/agent-modes.md, "Images"). Uploads run one at a time to keep
    // their order. Text pastes go to xterm as usual.
    let attaching = Promise.resolve()
    /** Whether a paste event took images since the last Shift paste chord. */
    let pasteClaimed = false
    const attach = (files: File[]): void => {
      setUploadError(null)
      for (const file of files) {
        setUploading((n) => n + 1)
        attaching = attaching
          .then(async () => {
            const path = await uploadAttachment(workspaceId, await prepareImage(file))
            term.paste(`${path} `)
          })
          .catch((err: unknown) => setUploadError(err instanceof Error ? err.message : String(err)))
          .finally(() => setUploading((n) => n - 1))
      }
    }
    // Capture phase, so the image is claimed before xterm sees the event.
    const onPaste = (e: ClipboardEvent): void => {
      const files = imageFiles(e.clipboardData)
      if (files.length === 0) return
      e.preventDefault()
      e.stopPropagation()
      pasteClaimed = true
      attach(files)
    }
    const onDragOver = (e: DragEvent): void => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
    }
    const onDrop = (e: DragEvent): void => {
      const files = imageFiles(e.dataTransfer)
      if (files.length === 0) return
      e.preventDefault()
      attach(files)
      term.focus()
    }
    el.addEventListener('paste', onPaste, true)
    el.addEventListener('dragover', onDragOver)
    el.addEventListener('drop', onDrop)

    // Let the mobile key bar type into this pane (see #lib/ptyInput).
    const unregisterInput = registerPtyInput(paneKey(workspaceId, target), (d) => term.input(d))

    // A suspended laptop drops the socket silently, so reattach right away
    // when the tab is shown again or the network returns.
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
      // After a system sleep the WebGL canvas can be blank without a
      // contextlost event; a full refresh from the buffer restores it.
      term.refresh(0, term.rows - 1)
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', reconnectNow)

    // Defer the first connect one tick. React StrictMode mounts, unmounts
    // and remounts synchronously, and a socket closed while CONNECTING can
    // leak its server-side PTY, so the throwaway mount never connects.
    const connectTimer = setTimeout(connect, 0)

    // Refit on any container size change, at most once per frame.
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
      // Send any pending input before closing the socket below.
      input.flush()
      input.dispose()
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', reconnectNow)
      observer.disconnect()
      cancelAnimationFrame(fitRaf)
      dataSub.dispose()
      resizeSub.dispose()
      el.removeEventListener('paste', onPaste, true)
      el.removeEventListener('dragover', onDragOver)
      el.removeEventListener('drop', onDrop)
      unregisterInput()
      testHooks.__xterms?.delete(term)
      disposeWheelPacing?.()
      disposeTouchScroll?.()
      disposeClickForwarding?.()
      if (ws) {
        // Drop handlers so a late event can't touch the disposed terminal.
        // If still CONNECTING, close again once open so the server-side
        // PTY is torn down.
        ws.onmessage = null
        ws.onclose = null
        if (ws.readyState === WebSocket.CONNECTING) {
          const sock = ws
          sock.onopen = () => sock.close()
        }
        ws.close()
      }
      // Before term.dispose(), so a late context-loss callback can't touch it.
      webgl.dispose()
      webglRef.current = null
      term.dispose()
      termRef.current = null
    }
  }, [workspaceId, target])

  // Track visibility for the WebGL controller after mount.
  useEffect(() => {
    webglRef.current?.setVisible(visible)
  }, [visible])

  // Focus xterm's textarea directly. A synthesized click would clear the
  // selection and be forwarded to the TUI.
  useEffect(() => {
    if (focusKey === undefined) return
    termRef.current?.focus()
  }, [focusKey])

  // Follow theme changes: themePref for the user's choice, matchMedia for
  // the OS switching while on 'system'.
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
      {/* Shown while the terminal is hidden by the settle gate. */}
      {!settled && (
        <div className="pointer-events-none absolute inset-0 flex animate-fade-in items-center
          justify-center gap-2 text-xs text-text-faint">
          <LoadingIcon size={13} className="animate-spin" />
          Connecting…
        </div>
      )}
      {(uploading > 0 || uploadError !== null) && (
        <div className="absolute right-2 bottom-2 flex items-center gap-1.5 rounded-md border
          border-hairline bg-surface-2 px-2 py-1 text-xs text-text-dim">
          {uploading > 0 ? (
            <>
              <LoadingIcon size={12} className="animate-spin" />
              Uploading image…
            </>
          ) : (
            <>
              <span className="text-[#f85149]">Image not attached: {uploadError}</span>
              <button type="button" aria-label="Dismiss" onClick={() => setUploadError(null)} className="hover:text-text">
                <CloseIcon size={12} />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
