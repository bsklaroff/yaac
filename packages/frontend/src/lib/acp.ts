/**
 * Client side of an ACP conversation: one WebSocket per mounted chat pane,
 * reconnecting like the SPA's other sockets (`reconnectingSocket`). The
 * server translates ACP into the small `AcpEvent` union, so this module only
 * handles transport and ordering.
 *
 * History is the record acpd writes, and each attach sends its last page
 * (`page`; the pages before it are read with `useTranscriptPages`). So the
 * pane replaces its list on `hello` rather than merging, and a dropped
 * connection costs only a repaint. After that the server numbers each event
 * it sends on this socket after the last, in send order, so live events are
 * appended as they come.
 */

import { useEffect, useRef, useState } from 'react'
import { reconnectingSocket, type ReconnectingSocket } from '#lib/reconnect'
import type { AcpClientMessage, AcpEvent, AcpEventInit, AcpQueuedPrompt, AcpServerMessage } from '@yaac/shared/acp'
import type { PermissionMode } from '@yaac/shared/types'

export interface AcpStream {
  /** The page `events` start at; later ones follow it there as the
   *  conversation compacts. */
  page: number
  /** The agent life the pages are numbered for (`AcpTranscriptPage.life`). */
  life: string | undefined
  events: AcpEvent[]
  /** A prompt turn is in flight (the agent is working). */
  busy: boolean
  /** The conversation is a `tui` one followed through its tool's history
   *  (`/acp/observe`), which reports no turns, so `busy` says nothing. */
  history: boolean
  /** Messages the server holds until the running turn ends. */
  queued: AcpQueuedPrompt[]
  /** The pane has a live connection to the conversation. False while
   *  reconnecting, or when the workspace has no live conversation yet. */
  connected: boolean
  /** The server has closed a socket of this pane's without greeting it,
   *  after holding it for the conversation to come up: the conversation is
   *  missing rather than starting. */
  refused: boolean
  /** False when the socket wasn't open, so the caller can keep the user's
   *  text rather than clearing an input whose message went nowhere. */
  send: (msg: AcpClientMessage) => boolean
  /** The latest answer to each `task-output` request, by task id. */
  taskOutputs: Record<string, TaskOutput>
  /** The answer to each `subagent-transcript` request, by subagent id. */
  subagentTranscripts: Record<string, SubagentTranscript>
  /** The conversation's posture and the ones it can be switched to. */
  permissionModes: { current?: PermissionMode; available: PermissionMode[] }
  /** The conversation's effort level and the ones its model offers. */
  efforts: { current?: string; available: Array<{ value: string; name: string }> }
}

/** The end of a background task's output, or why it could not be read. */
export interface TaskOutput { text?: string; error?: string }

/** A subagent's thread from its own transcript, or why it could not be
 *  read. */
export interface SubagentTranscript { events?: AcpEventInit[]; error?: string }

/**
 * Attach to one conversation for as long as the pane is mounted, or with
 * `observe`, watch it as a reader who cannot drive it (`/acp/observe`): the
 * server then answers only reads. Nothing is dialed while `enabled` is
 * false.
 *
 * A hidden pane keeps its socket, as a hidden terminal keeps its PTY: each
 * attach re-sends the whole conversation in its `hello` frame, which is slow
 * on a poor link, so it shouldn't be repeated on every tab switch.
 * `WorkspaceView` decides which panes stay mounted.
 */
export function useAcpStream(
  workspaceId: string,
  conversationId: string,
  { observe = false, enabled = true }: { observe?: boolean; enabled?: boolean } = {},
): AcpStream {
  const [page, setPage] = useState(0)
  const [life, setLife] = useState<string>()
  const [events, setEvents] = useState<AcpEvent[]>([])
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState(false)
  const [queued, setQueued] = useState<AcpQueuedPrompt[]>([])
  const [connected, setConnected] = useState(false)
  const [refused, setRefused] = useState(false)
  const [taskOutputs, setTaskOutputs] = useState<Record<string, TaskOutput>>({})
  const [subagentTranscripts, setSubagentTranscripts] = useState<Record<string, SubagentTranscript>>({})
  const [permissionModes, setPermissionModes] = useState<AcpStream['permissionModes']>({ available: [] })
  const [efforts, setEfforts] = useState<AcpStream['efforts']>({ available: [] })
  const socketRef = useRef<ReconnectingSocket | null>(null)

  useEffect(() => {
    if (!enabled) return
    const params = new URLSearchParams({ id: workspaceId, session: conversationId })
    /** Whether the current socket has been greeted. */
    let greeted = false
    const sock = reconnectingSocket(() => `/api/acp/${observe ? 'observe' : 'attach'}?${params}`, {
      open: () => {
        greeted = false
      },
      message: (data) => {
        const msg = JSON.parse(data as string) as AcpServerMessage
        if (msg.type === 'hello') {
          greeted = true
          // Replace, don't merge: each attach resends the last page.
          setPage(msg.page)
          setLife(msg.life)
          setEvents(msg.events)
          setBusy(msg.busy)
          setHistory(msg.history === true)
          setQueued(msg.queued)
          setConnected(true)
          // Only a hello is healthy: with no live conversation the server
          // sends a health frame and closes.
          return true
        }
        if (msg.type === 'event') {
          setEvents((prev) => [...prev, msg.event])
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
        if (msg.type === 'permission-mode') {
          const { type: _, ...modes } = msg
          setPermissionModes(modes)
          return false
        }
        if (msg.type === 'effort') {
          const { type: _, ...next } = msg
          setEfforts(next)
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
      close: (opened) => {
        setConnected(false)
        if (opened && !greeted) setRefused(true)
      },
    })
    socketRef.current = sock
    return () => {
      sock.close()
      socketRef.current = null
    }
  }, [workspaceId, conversationId, observe, enabled])

  return {
    page,
    life,
    events,
    busy,
    history,
    queued,
    connected,
    refused,
    taskOutputs,
    subagentTranscripts,
    permissionModes,
    efforts,
    send: (msg) => socketRef.current?.send(JSON.stringify(msg)) ?? false,
  }
}
