/**
 * Client side of an ACP conversation: one WebSocket per mounted chat pane,
 * with the same reconnect backoff as `WorkspaceTerminal`'s PTY socket. The
 * server translates ACP into the small `AcpEvent` union, so this module only
 * handles transport and ordering.
 *
 * History is the record acpd writes, and each attach numbers it from zero.
 * So the pane replaces its list on `hello` rather than merging, and a
 * dropped connection costs only a repaint. Live events after that are
 * merged by `seq`, so a repeated or out-of-order delivery can't duplicate a
 * message.
 */

import { useEffect, useRef, useState } from 'react'
import { INITIAL_RECONNECT_DELAY_MS, nextReconnectDelay } from '#lib/reconnect'
import type { AcpClientMessage, AcpEvent, AcpQueuedPrompt, AcpServerMessage } from '@yaac/shared/acp'

export interface AcpStream {
  events: AcpEvent[]
  /** A prompt turn is in flight (the agent is working). */
  busy: boolean
  /** Messages the server holds until the running turn ends. */
  queued: AcpQueuedPrompt[]
  /** The pane has a live connection to the conversation. False while
   *  reconnecting, or when the workspace has no live conversation yet. */
  connected: boolean
  /** False when the socket wasn't open, so the caller can keep the user's
   *  text rather than clearing an input whose message went nowhere. */
  send: (msg: AcpClientMessage) => boolean
}

/** Merge a batch of events into the list, keyed by `seq`, so a replayed
 *  event replaces its earlier copy instead of duplicating it. */
export function mergeEvents(existing: AcpEvent[], incoming: AcpEvent[]): AcpEvent[] {
  if (incoming.length === 0) return existing
  const bySeq = new Map(existing.map((e) => [e.seq, e]))
  for (const e of incoming) bySeq.set(e.seq, e)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

/**
 * Attach to one conversation for as long as the pane is mounted.
 *
 * A hidden pane keeps its socket, as a hidden terminal keeps its PTY: each
 * attach re-sends the whole conversation in its `hello` frame, which is slow
 * on a poor link, so it shouldn't be repeated on every tab switch.
 * `WorkspaceView` decides which panes stay mounted.
 */
export function useAcpStream(
  workspaceId: string,
  agentSessionId: string,
): AcpStream {
  const [events, setEvents] = useState<AcpEvent[]>([])
  const [busy, setBusy] = useState(false)
  const [queued, setQueued] = useState<AcpQueuedPrompt[]>([])
  const [connected, setConnected] = useState(false)
  const socketRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (workspaceId === '' || agentSessionId === '') return
    let closed = false
    let delay = INITIAL_RECONNECT_DELAY_MS
    let retry: ReturnType<typeof setTimeout> | undefined

    const connect = (): void => {
      if (closed) return
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const params = new URLSearchParams({ id: workspaceId, session: agentSessionId })
      const sock = new WebSocket(`${scheme}://${window.location.host}/api/acp/attach?${params}`)
      socketRef.current = sock

      sock.onmessage = (e) => {
        if (typeof e.data !== 'string') return
        let msg: AcpServerMessage
        try {
          msg = JSON.parse(e.data) as AcpServerMessage
        } catch {
          return
        }
        if (msg.type === 'hello') {
          // Replace, don't merge: each attach renumbers history from zero.
          setEvents(msg.events)
          setBusy(msg.busy)
          setQueued(msg.queued)
          setConnected(true)
          delay = INITIAL_RECONNECT_DELAY_MS
          return
        }
        if (msg.type === 'event') {
          setEvents((prev) => mergeEvents(prev, [msg.event]))
          // Only explicit boundaries set `busy`. A `user` event can't be used:
          // `session/load` replays past messages as live updates with no
          // closing boundary, which would leave a restarted workspace stuck
          // at "working…".
          if (msg.event.type === 'turn-end' || msg.event.type === 'error') setBusy(false)
          if (msg.event.type === 'turn-start') setBusy(true)
          return
        }
        if (msg.type === 'queue') {
          setQueued(msg.queued)
          return
        }
        if (msg.type === 'health') setConnected(msg.connected)
      }
      sock.onclose = () => {
        socketRef.current = null
        setConnected(false)
        if (closed) return
        retry = setTimeout(connect, delay)
        delay = nextReconnectDelay(delay)
      }
      sock.onerror = () => sock.close()
    }

    connect()
    // Reattach right away when the tab returns to the foreground or the
    // machine comes back online, instead of waiting out the backoff.
    const wake = (): void => {
      if (closed || socketRef.current) return
      if (retry) clearTimeout(retry)
      delay = INITIAL_RECONNECT_DELAY_MS
      connect()
    }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake)

    return () => {
      closed = true
      if (retry) clearTimeout(retry)
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', wake)
      socketRef.current?.close()
      socketRef.current = null
    }
  }, [workspaceId, agentSessionId])

  return {
    events,
    busy,
    queued,
    connected,
    send: (msg) => {
      const sock = socketRef.current
      if (sock?.readyState !== WebSocket.OPEN) return false
      sock.send(JSON.stringify(msg))
      return true
    },
  }
}
