/**
 * Registry of live `AcpConversation`s, so per-client code (a WebSocket
 * handler, prompt delivery) can reach a conversation owned by the
 * long-lived status watcher. Like the tmux control-stream registry, an
 * entry is borrowed; only the registering driver may close it.
 *
 * Indexed by two names: panes use the ACP session id (their `acp:<id>`
 * target, remembered in the DB across restarts), and the driver uses the
 * handle (tmux window / acpd socket name), known before the handshake.
 */

import type { AcpConversation, QueuedTurn } from './acp-client'

const byName = new Map<string, AcpConversation>()
/** Handle keys whose conversation has a session id. */
const named = new Set<string>()
/** Callers of `whenAcpConversation` waiting on a handle key. */
const waiters = new Map<string, Set<(conversation: AcpConversation) => void>>()

function sessionKey(projectId: string, workspaceId: string, agentSessionId: string): string {
  return `${projectId}/${workspaceId}/id:${agentSessionId}`
}

function handleKey(projectId: string, workspaceId: string, handle: string): string {
  return `${projectId}/${workspaceId}/handle:${handle}`
}

/**
 * Publish a conversation. A fresh one is registered by handle alone, then
 * again once `session/new` supplies its id.
 */
export function registerAcpConversation(
  projectId: string,
  workspaceId: string,
  names: { handle: string; agentSessionId?: string },
  conversation: AcpConversation,
): void {
  const handle = handleKey(projectId, workspaceId, names.handle)
  byName.set(handle, conversation)
  if (names.agentSessionId === undefined) return
  byName.set(sessionKey(projectId, workspaceId, names.agentSessionId), conversation)
  named.add(handle)
  for (const wake of waiters.get(handle) ?? []) wake(conversation)
  waiters.delete(handle)
}

export function unregisterAcpConversation(
  projectId: string,
  workspaceId: string,
  names: { handle: string; agentSessionId?: string },
): void {
  byName.delete(handleKey(projectId, workspaceId, names.handle))
  named.delete(handleKey(projectId, workspaceId, names.handle))
  if (names.agentSessionId !== undefined) {
    byName.delete(sessionKey(projectId, workspaceId, names.agentSessionId))
  }
}

/** The live conversation for a pane's `acp:<id>` target, or undefined when
 *  none is connected (booting, or reconnecting). */
export function acpConversation(
  projectId: string,
  workspaceId: string,
  agentSessionId: string,
): AcpConversation | undefined {
  return byName.get(sessionKey(projectId, workspaceId, agentSessionId))
}

/** The live conversation by the driver's handle, which a fresh one has
 *  before its handshake mints an id. */
export function acpConversationByHandle(
  projectId: string,
  workspaceId: string,
  handle: string,
): AcpConversation | undefined {
  return byName.get(handleKey(projectId, workspaceId, handle))
}

/**
 * The conversation on `handle` once it has a session id: at once for a
 * resumed one, after `session/new` for a fresh one. Resolves `undefined`
 * if none is registered within `timeoutMs`.
 */
export function whenAcpConversation(
  projectId: string,
  workspaceId: string,
  handle: string,
  timeoutMs: number,
): Promise<AcpConversation | undefined> {
  const key = handleKey(projectId, workspaceId, handle)
  const found = byName.get(key)
  if (found !== undefined && named.has(key)) return Promise.resolve(found)
  return new Promise((resolve) => {
    const wake = (conversation: AcpConversation | undefined): void => {
      clearTimeout(timer)
      pending.delete(wake)
      if (pending.size === 0 && waiters.get(key) === pending) waiters.delete(key)
      resolve(conversation)
    }
    const pending = waiters.get(key) ?? new Set()
    waiters.set(key, pending)
    pending.add(wake)
    const timer = setTimeout(() => wake(undefined), timeoutMs)
  })
}

/** Test-only: drop every entry. */
export function _resetAcpRegistryForTests(): void {
  byName.clear()
  named.clear()
  waiters.clear()
  launchModels.clear()
  parkedQueues.clear()
}

/**
 * Queues of conversations whose connection dropped, held for the
 * conversation that replaces them (`AcpConversation.takeQueue`). Keyed by
 * session id rather than handle, since a restart can shift window names
 * onto other conversations. A dropped connection parks its queue; the
 * workspace's status watcher stopping, or the window closing, discards it
 * (`dropAcpQueues`). In memory only, so a server restart loses them.
 */
const parkedQueues = new Map<string, QueuedTurn[]>()

export function parkAcpQueue(projectId: string, workspaceId: string, agentSessionId: string, queue: QueuedTurn[]): void {
  if (queue.length === 0) return
  const key = sessionKey(projectId, workspaceId, agentSessionId)
  parkedQueues.set(key, [...(parkedQueues.get(key) ?? []), ...queue])
}

/**
 * Discard a workspace's parked queues except those of `keep`, rejecting each
 * message so its sender logs it. Used when the workspace stops and when a
 * conversation's window is gone, since nothing will reattach to take them.
 */
export function dropAcpQueues(projectId: string, workspaceId: string, keep: ReadonlySet<string> = new Set()): void {
  for (const [key, queue] of parkedQueues) {
    if (!key.startsWith(`${projectId}/${workspaceId}/id:`) || keep.has(key.slice(key.indexOf('/id:') + 4))) continue
    parkedQueues.delete(key)
    for (const turn of queue) turn.reject(new Error('the conversation ended before the queued message was sent'))
  }
}

export function takeAcpQueue(projectId: string, workspaceId: string, agentSessionId: string): QueuedTurn[] {
  const key = sessionKey(projectId, workspaceId, agentSessionId)
  const queue = parkedQueues.get(key) ?? []
  parkedQueues.delete(key)
  return queue
}

/**
 * Launch models for adapters told their model over the protocol
 * (`modelVia: 'set_config_option'`), parked between building the launch
 * command and the handshake seconds later. Keyed by launch id: the
 * workspace id for a fresh conversation, the agent's id for a resumed one.
 *
 * Taken once: a reattach must not re-send it, since the user may have
 * changed the model. If the server restarts between launch and first
 * attach the override is lost and the driver logs it.
 */
const launchModels = new Map<string, string>()

export function stashAcpLaunchModel(launchId: string, model: string): void {
  launchModels.set(launchId, model)
}

export function takeAcpLaunchModel(launchId: string): string | undefined {
  const model = launchModels.get(launchId)
  launchModels.delete(launchId)
  return model
}
