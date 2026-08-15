/**
 * Client half of the ACP conversation stream: one WebSocket per attached chat
 * pane, mirroring `WorktreeTerminal`'s PTY socket (same reconnect-with-backoff,
 * same "the agent outlives this tab" assumption).
 *
 * The pane never sees ACP itself — the server projects every `session/update`
 * into the small `AcpEvent` union before it reaches the wire — so everything
 * here is about *transport* and *ordering*, not protocol.
 *
 * Ordering is the one subtlety. History does not live in the server — it is
 * the record acpd writes as it relays — so every attach reads that record and
 * numbers it from zero. A pane therefore REPLACES its list on `hello` rather
 * than merging into it: the record is authoritative and complete, so what it
 * says supersedes whatever the pane was holding, and a dropped connection
 * costs nothing but a repaint. Live events append behind it, merged by `seq`
 * so an out-of-order or repeated delivery cannot double a message.
 */

import { useEffect, useRef, useState } from 'react'
import { INITIAL_RECONNECT_DELAY_MS, nextReconnectDelay } from '#lib/reconnect'
import type { AcpClientMessage, AcpEvent, AcpServerMessage } from '@yaac/shared/acp'

export interface AcpStream {
  events: AcpEvent[]
  /** A prompt turn is in flight — the agent is working. */
  busy: boolean
  /** The pane has a live connection to the conversation. False while
   *  reconnecting, or when the worktree has no live conversation yet. */
  connected: boolean
  /** False when the socket wasn't open, so the caller can keep the user's
   *  text rather than clearing an input whose message went nowhere. */
  send: (msg: AcpClientMessage) => boolean
}

/**
 * Merge a batch of events into the list, keyed by `seq`. Exported for its own
 * test: this is where a reconnect's replay either de-duplicates cleanly or
 * silently doubles the whole conversation.
 */
export function mergeEvents(existing: AcpEvent[], incoming: AcpEvent[]): AcpEvent[] {
  if (incoming.length === 0) return existing
  const bySeq = new Map(existing.map((e) => [e.seq, e]))
  for (const e of incoming) bySeq.set(e.seq, e)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

/**
 * Attach to one conversation, for as long as the pane is mounted.
 *
 * Mounting is the whole gate: a hidden pane keeps its socket, exactly as a
 * hidden terminal keeps its PTY. What there is to keep warm is not the
 * conversation — that lives on the server and replays on any attach — but the
 * *transport*: an attach costs a WebSocket handshake and then the entire
 * conversation as one `hello` frame, which on a slow or lossy link is the
 * "Connecting to the agent…" wait, and re-paying it on every tab switch is the
 * one cost a pane can simply not incur. `WorktreeView` decides which panes stay
 * mounted; there is nothing left for this hook to second-guess.
 */
export function useAcpStream(
  worktreeId: string,
  agentSessionId: string,
): AcpStream {
  const [events, setEvents] = useState<AcpEvent[]>([])
  const [busy, setBusy] = useState(false)
  const [connected, setConnected] = useState(false)
  const socketRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (worktreeId === '' || agentSessionId === '') return
    let closed = false
    let delay = INITIAL_RECONNECT_DELAY_MS
    let retry: ReturnType<typeof setTimeout> | undefined

    const connect = (): void => {
      if (closed) return
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const params = new URLSearchParams({ id: worktreeId, session: agentSessionId })
      const sock = new WebSocket(`${scheme}://${window.location.host}/acp/attach?${params}`)
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
          // Replace, never merge: `events` is the conversation as recorded,
          // renumbered from zero for this attach, so the numbers a pane already
          // holds refer to a different numbering of the same history.
          setEvents(msg.events)
          setBusy(msg.busy)
          setConnected(true)
          delay = INITIAL_RECONNECT_DELAY_MS
          return
        }
        if (msg.type === 'event') {
          setEvents((prev) => mergeEvents(prev, [msg.event]))
          // Explicit boundaries only. A `user` event looks like a turn
          // beginning and mostly is, but it is also what a *replay* is made of:
          // `session/load` re-emits every past message as a live update, and
          // the record carries no boundary to close them with — so inferring
          // from it leaves a restarted worktree pinned at `working…` with a
          // Stop button and no turn to stop. `turn-start` has no such second
          // meaning: the server emits it when a turn actually begins, including
          // one it recovered on reattaching to a working agent.
          if (msg.event.type === 'turn-end' || msg.event.type === 'error') setBusy(false)
          if (msg.event.type === 'turn-start') setBusy(true)
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
    // A tab returning to the foreground, or a machine coming back online,
    // reattaches immediately rather than waiting out the backoff.
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
  }, [worktreeId, agentSessionId])

  return {
    events,
    busy,
    connected,
    send: (msg) => {
      const sock = socketRef.current
      if (sock?.readyState !== WebSocket.OPEN) return false
      sock.send(JSON.stringify(msg))
      return true
    },
  }
}
