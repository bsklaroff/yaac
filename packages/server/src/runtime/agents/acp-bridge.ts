/**
 * The `/acp/attach` bridge: one browser pane to one live ACP conversation.
 * Shaped like the PTY bridge (a disposable per-client view onto an agent
 * that outlives it), with these differences:
 *
 *  - Frames are JSON text (`AcpServerMessage` / `AcpClientMessage`).
 *  - Attaching replays: `hello` carries the conversation record so far, and
 *    the same record tail feeds all later content. The live subscription
 *    adds only turn boundaries, errors and the queue of messages waiting
 *    for the turn to end, none of which the record carries.
 *  - Detaching only unsubscribes; the driver's connection owns the
 *    conversation (which is why acpd exists).
 *
 * Several panes (tabs) may attach to one conversation at once.
 */

import { acpConversation } from './acp-registry'
import { tailAcpLog } from './acp-log'
import { serverLog } from '#log'
import { MAX_ATTACHMENT_BYTES, sniffImage } from '@yaac/shared/attachments'
import type { AcpClientMessage, AcpEvent, AcpImage, AcpServerMessage, AcpTask } from '@yaac/shared/acp'

/** The socket this bridge needs; same shape as the PTY bridge's, kept
 *  separate so the features stay decoupled. */
export interface AcpSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  onMessage(cb: (data: string | Buffer | ArrayBuffer, isBinary: boolean) => void): void
  onClose(cb: () => void): void
}

function toText(data: string | Buffer | ArrayBuffer): string {
  if (typeof data === 'string') return data
  return Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8')
}

/**
 * Validate a prompt's images like the terminal upload route does: by
 * sniffing the bytes, not the declared type, with the size cap applied to
 * the whole message. Returns the first refusal as a string, and the message
 * is then dropped rather than sent without the image. The re-encoded bytes
 * are forwarded, since base64 decoding skips invalid characters.
 */
function promptImages(raw: unknown): AcpImage[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return 'malformed images'
  const images: AcpImage[] = []
  let total = 0
  for (const entry of raw as Array<Partial<AcpImage> | null>) {
    if (typeof entry?.data !== 'string') return 'malformed image'
    const bytes = Buffer.from(entry.data, 'base64')
    total += bytes.byteLength
    if (total > MAX_ATTACHMENT_BYTES) return 'its images are over the 5 MB limit'
    const kind = sniffImage(bytes)
    if (!kind) return 'an image is not a PNG, JPEG, GIF or WebP'
    images.push({ type: 'image', mimeType: kind.mimeType, data: bytes.toString('base64') })
  }
  return images
}

/**
 * Whether `file` is where claude writes a background task's output
 * (`…/tasks/<id>.output`). The path comes from the agent and is read by a
 * shell in the workspace, so the bridge reads nothing else.
 */
function isTaskOutputPath(file: string, taskId: string): boolean {
  return file.startsWith('/')
    && file.endsWith(`/tasks/${taskId}.output`)
    && !file.split('/').includes('..')
}

/**
 * Attach `sock` to the conversation, or close it if none is live. That is
 * normal (the workspace may be booting or reconnecting); the pane retries,
 * like `WorkspaceTerminal` does on a dropped PTY.
 */
export function attachAcp(
  slug: string,
  workspaceId: string,
  agentSessionId: string,
  sock: AcpSocket,
): void {
  const conversation = acpConversation(slug, workspaceId, agentSessionId)
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

  // All content comes from the record. The live socket carries the same
  // `session/update` notifications, but ACP gives them no ids, so merging
  // the two sources would duplicate or drop the overlap.
  let seq = 0
  let detached = false
  /** The model ids the record last offered this pane. A switch is accepted
   *  only to one of them, so the id the session row may record is one the
   *  adapter named, never arbitrary browser input. */
  let offeredModels = new Set<string>()
  /** The background tasks the record announced, by id. Like the models, a
   *  pane may stop (when the adapter can) or read only these, and an output
   *  path is never taken from the browser. */
  let tasks = new Map<string, AcpTask>()
  const tail = tailAcpLog(
    { slug, workspaceId, agentSessionId },
    (events, reset) => {
      // A read already in progress still reports after close.
      if (detached) return
      if (reset) {
        offeredModels = new Set()
        tasks = new Map()
      }
      for (const event of events) {
        if (event.type === 'models') offeredModels = new Set(event.models.map((m) => m.id))
        if (event.type === 'task') tasks.set(event.task.id, event.task)
      }
      if (reset) {
        // The first read, or a new agent life that truncated the record:
        // the pane replaces what it holds.
        seq = 0
        send({
          type: 'hello',
          agentSessionId,
          busy: conversation.isBusy,
          queued: conversation.queuedPrompts,
          events: events.map((event) => ({ ...event, seq: seq++ }) as AcpEvent),
        })
        // Standing notices from the handshake (e.g. the adapter running in a
        // looser mode than requested) predate any pane, so replay them after
        // every `hello`.
        for (const notice of conversation.standingNotices) {
          send({ type: 'event', event: { ...notice, seq: seq++ } as AcpEvent })
        }
        return
      }
      for (const event of events) send({ type: 'event', event: { ...event, seq: seq++ } as AcpEvent })
    },
  )

  // Turn boundaries and errors come from the live subscription; they never
  // overlap the record. Flush the record first so a turn does not appear
  // to end before its last words. Returning the delivery lets the queue hold
  // its next message until the pane has this turn's end.
  const unsubscribe = conversation.subscribe((event) =>
    tail.flush()
      .catch(() => { /* the next pass retries */ })
      .then(() => {
        // The pane may have left during the flush.
        if (detached) return
        send({ type: 'event', event: { ...event, seq: seq++ } as AcpEvent })
      }),
  )
  // Flushed like turn boundaries, so a message leaving the queue to start a
  // turn is already in the record the pane shows.
  const unsubscribeQueue = conversation.onQueue((queued) => {
    void tail.flush()
      .catch(() => { /* the next pass retries */ })
      .then(() => {
        if (!detached) send({ type: 'queue', queued })
      })
  })
  // The pane is bound to this conversation object. When it closes, close
  // the socket too: a replacement under the same `acp:<id>` is a different
  // object, and the pane re-attaches to it with backoff.
  const unsubscribeClose = conversation.onClosed(() => {
    send({ type: 'health', connected: false })
    sock.close(1011, 'conversation closed')
  })

  sock.onMessage((data, isBinary) => {
    // The pane sends JSON only; drop binary frames.
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
    if (msg.type === 'unqueue' && typeof msg.id === 'string') {
      conversation.unqueue(msg.id)
      return
    }
    if (msg.type === 'permission' && typeof msg.requestId === 'string') {
      // Nothing to echo: the recorded reply comes back through the tail as
      // `permission-resolved`, so the pane cannot get ahead of the agent.
      conversation.answerPermission(
        msg.requestId,
        typeof msg.optionId === 'string' ? msg.optionId : undefined,
      )
      return
    }
    if (msg.type === 'model' && typeof msg.modelId === 'string' && offeredModels.has(msg.modelId)) {
      // The reply is recorded, so the pane learns the new model as a
      // `models` event from the tail.
      void conversation.switchModel(msg.modelId)
      return
    }
    if (msg.type === 'stop-task' && typeof msg.taskId === 'string' && tasks.get(msg.taskId)?.canStop === true) {
      void conversation.stopTask(msg.taskId).catch((err: unknown) => {
        serverLog(`[server] acp attach ${workspaceId}/${agentSessionId}: stopping task ${msg.taskId} failed: ${String(err)}`)
      })
      return
    }
    if (msg.type === 'task-output' && typeof msg.taskId === 'string') {
      const taskId = msg.taskId
      const file = tasks.get(taskId)?.outputFile
      const reply = (r: { text: string } | { error: string }): void => {
        if (!detached) send({ type: 'task-output', taskId, ...r })
      }
      if (file === undefined || !isTaskOutputPath(file, taskId)) {
        reply({ error: 'this task has no output file' })
        return
      }
      conversation.readTaskOutput(file).then(
        (text) => reply({ text }),
        (err: unknown) => reply({ error: err instanceof Error ? err.message : String(err) }),
      )
      return
    }
    if (msg.type === 'prompt' && typeof msg.text === 'string') {
      const images = promptImages(msg.images)
      if (typeof images === 'string') {
        // Tell the pane, which is waiting for this message's echo.
        send({ type: 'event', event: { type: 'error', message: `message not sent: ${images}`, seq: seq++ } })
        return
      }
      const text = msg.text.trim() === '' ? '' : msg.text
      if (text === '' && images.length === 0) return
      // Not awaited, so the socket stays responsive to a cancel.
      void conversation.prompt(text, images).catch((err: unknown) => {
        serverLog(`[server] acp attach ${workspaceId}/${agentSessionId}: prompt failed: ${String(err)}`)
      })
    }
  })

  sock.onClose(() => {
    detached = true
    tail.close()
    unsubscribe()
    unsubscribeQueue()
    unsubscribeClose()
  })
}
