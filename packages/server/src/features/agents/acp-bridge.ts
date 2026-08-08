/**
 * The `/acp/attach` bridge: one browser pane ⇄ one live ACP conversation.
 *
 * Deliberately the same shape as the PTY bridge, because it plays the same
 * role — a per-client, disposable view onto an agent that outlives it. The
 * differences are all consequences of the payload being structured events
 * rather than bytes:
 *
 *  - Every frame is JSON text (`AcpServerMessage` / `AcpClientMessage`), not
 *    binary, so the pane never parses a wire format.
 *  - Attaching *replays*: xterm keeps its own scrollback in the browser, but a
 *    chat pane reconnecting to an existing conversation has nothing until the
 *    server hands it one. `hello` carries the record's contents as of the
 *    attach, and the same tail feeds everything after it — content has one
 *    source, and the live subscription contributes only turn boundaries and
 *    errors, which the record cannot carry.
 *  - Detaching is free. A PTY attach creates and kills a tmux view session;
 *    here the conversation is owned by the driver's connection and a closing
 *    socket unsubscribes and nothing more. That is the whole reason acpd
 *    exists.
 *
 * Several panes may attach to one conversation at once (two tabs), which the
 * subscription set handles without any of them being special.
 */

import { acpConversation } from './acp-registry'
import { tailAcpLog } from './acp-log'
import { acpLogDir } from '@yaac/shared/project-paths'
import path from 'node:path'
import { serverLog } from '#log'
import type { AcpClientMessage, AcpEvent, AcpServerMessage } from '@yaac/shared/acp'

/** The minimal socket this bridge needs — structurally the same object the
 *  PTY bridge takes, without coupling the two features. */
export interface AcpSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  onMessage(cb: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): void
  onClose(cb: () => void): void
}

function toText(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8')
}

/**
 * Attach `sock` to the conversation, or close it with an error when there is
 * none live. "None live" is a normal state, not a fault: the worktree may
 * still be booting, or its connection may be mid-respawn — so the pane is told
 * plainly and retries, exactly as `SessionTerminal` does on a dropped PTY.
 */
export function attachAcp(
  slug: string,
  worktreeId: string,
  agentSessionId: string,
  sock: AcpSocket,
): void {
  const conversation = acpConversation(slug, worktreeId, agentSessionId)
  const send = (msg: AcpServerMessage): void => {
    try {
      sock.send(JSON.stringify(msg))
    } catch {
      // The pane went away mid-write; the close handler unsubscribes.
    }
  }

  if (conversation === undefined) {
    send({ type: 'health', connected: false })
    sock.close(1011, 'no live conversation')
    return
  }

  // Content comes from the record and nothing else. The socket carries the
  // RPC half but not a rendered message, because the two carry the same
  // `session/update` notifications and ACP gives notifications no identity —
  // joining them at an unknown point would duplicate the overlap or drop it.
  // One source has no join, so there is nothing here to get wrong.
  let seq = 0
  const tail = tailAcpLog(
    path.join(acpLogDir(slug, worktreeId), `${agentSessionId}.jsonl`),
    (events, reset) => {
      if (reset) {
        // A fresh read of the whole record — the first pass, or a new agent
        // life that truncated it. Either way the pane replaces what it holds.
        seq = 0
        send({
          type: 'hello',
          agentSessionId,
          busy: conversation.isBusy,
          events: events.map((event) => ({ ...event, seq: seq++ }) as AcpEvent),
        })
        return
      }
      for (const event of events) send({ type: 'event', event: { ...event, seq: seq++ } as AcpEvent })
    },
  )

  // Turn boundaries and errors are the only events the record cannot carry:
  // they describe what is happening now, not what was said. Disjoint from the
  // tail's output, so the two streams can never deliver the same thing twice.
  // Flushed behind the record first, or a turn would appear to end above the
  // last words of the answer it ended.
  const unsubscribe = conversation.subscribe((event) => {
    void tail.flush()
      .catch(() => { /* the next pass retries */ })
      .then(() => send({ type: 'event', event: { ...event, seq: seq++ } as AcpEvent }))
  })
  const unsubscribeClose = conversation.onClosed(() => {
    send({ type: 'health', connected: false })
  })

  sock.onMessage((data, isBinary) => {
    // The pane speaks JSON only. A binary frame is a client bug, not a
    // protocol variant — dropping it beats forwarding garbage to the agent.
    if (isBinary) return
    let msg: AcpClientMessage
    try {
      msg = JSON.parse(toText(data)) as AcpClientMessage
    } catch {
      return
    }
    if (msg.type === 'cancel') {
      conversation.cancel()
      return
    }
    if (msg.type === 'prompt' && typeof msg.text === 'string' && msg.text.trim() !== '') {
      // Not awaited: the turn's progress is the event stream's business, and
      // the socket must stay responsive to a cancel while it runs.
      void conversation.prompt(msg.text).catch((err: unknown) => {
        serverLog(`[server] acp attach ${worktreeId}/${agentSessionId}: prompt failed: ${String(err)}`)
      })
    }
  })

  sock.onClose(() => {
    tail.close()
    unsubscribe()
    unsubscribeClose()
  })
}
