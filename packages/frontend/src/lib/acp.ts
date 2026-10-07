/**
 * Client side of an ACP conversation: one WebSocket per mounted chat pane,
 * reconnecting like the SPA's other sockets (`reconnectingSocket`). The
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
import { reconnectingSocket, type ReconnectingSocket } from '#lib/reconnect'
import type { AcpClientMessage, AcpEvent, AcpEventInit, AcpQueuedPrompt, AcpServerMessage } from '@yaac/shared/acp'

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
  /** The latest answer to each `task-output` request, by task id. */
  taskOutputs: Record<string, TaskOutput>
  /** The answer to each `subagent-transcript` request, by subagent id. */
  subagentTranscripts: Record<string, SubagentTranscript>
}

/** The end of a background task's output, or why it could not be read. */
export interface TaskOutput { text?: string; error?: string }

/** A subagent's thread from its own transcript, or why it could not be
 *  read. */
export interface SubagentTranscript { events?: AcpEventInit[]; error?: string }

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
  const [taskOutputs, setTaskOutputs] = useState<Record<string, TaskOutput>>({})
  const [subagentTranscripts, setSubagentTranscripts] = useState<Record<string, SubagentTranscript>>({})
  const socketRef = useRef<ReconnectingSocket | null>(null)

  useEffect(() => {
    if (workspaceId === '' || agentSessionId === '') return
    const params = new URLSearchParams({ id: workspaceId, session: agentSessionId })
    const sock = reconnectingSocket(() => `/api/acp/attach?${params}`, {
      message: (data) => {
        if (typeof data !== 'string') return false
        let msg: AcpServerMessage
        try {
          msg = JSON.parse(data) as AcpServerMessage
        } catch {
          return false
        }
        if (msg.type === 'hello') {
          // Replace, don't merge: each attach renumbers history from zero.
          setEvents(msg.events)
          setBusy(msg.busy)
          setQueued(msg.queued)
          setConnected(true)
          // Only a hello is healthy: with no live conversation the server
          // sends a health frame and closes.
          return true
        }
        if (msg.type === 'event') {
          setEvents((prev) => mergeEvents(prev, [msg.event]))
          // Only explicit boundaries set `busy`. A `user` event can't be used:
          // `session/load` replays past messages as live updates with no
          // closing boundary, which would leave a restarted workspace stuck
          // at "working…".
          if (msg.event.type === 'turn-end' || msg.event.type === 'error') setBusy(false)
          if (msg.event.type === 'turn-start') setBusy(true)
          return false
        }
        if (msg.type === 'queue') {
          setQueued(msg.queued)
          return false
        }
        if (msg.type === 'health') setConnected(msg.connected)
        if (msg.type === 'task-output') {
          const { taskId, ...output } = msg
          setTaskOutputs((prev) => ({ ...prev, [taskId]: output }))
        }
        if (msg.type === 'subagent-transcript') {
          const { subagentId, ...transcript } = msg
          setSubagentTranscripts((prev) => ({ ...prev, [subagentId]: transcript }))
        }
        return false
      },
      close: () => setConnected(false),
    })
    socketRef.current = sock
    return () => {
      sock.close()
      socketRef.current = null
    }
  }, [workspaceId, agentSessionId])

  return {
    events,
    busy,
    queued,
    connected,
    taskOutputs,
    subagentTranscripts,
    send: (msg) => socketRef.current?.send(JSON.stringify(msg)) ?? false,
  }
}
