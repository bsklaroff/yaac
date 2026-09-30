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

import type { AcpConversation } from './acp-client'

const byName = new Map<string, AcpConversation>()

function sessionKey(slug: string, workspaceId: string, agentSessionId: string): string {
  return `${slug}/${workspaceId}/id:${agentSessionId}`
}

function handleKey(slug: string, workspaceId: string, handle: string): string {
  return `${slug}/${workspaceId}/handle:${handle}`
}

/**
 * Publish a conversation. A fresh one is registered by handle alone, then
 * again once `session/new` supplies its id.
 */
export function registerAcpConversation(
  slug: string,
  workspaceId: string,
  names: { handle: string; agentSessionId?: string },
  conversation: AcpConversation,
): void {
  byName.set(handleKey(slug, workspaceId, names.handle), conversation)
  if (names.agentSessionId !== undefined) {
    byName.set(sessionKey(slug, workspaceId, names.agentSessionId), conversation)
  }
}

export function unregisterAcpConversation(
  slug: string,
  workspaceId: string,
  names: { handle: string; agentSessionId?: string },
): void {
  byName.delete(handleKey(slug, workspaceId, names.handle))
  if (names.agentSessionId !== undefined) {
    byName.delete(sessionKey(slug, workspaceId, names.agentSessionId))
  }
}

/** The live conversation for a pane's `acp:<id>` target, or undefined when
 *  none is connected (booting, or reconnecting). */
export function acpConversation(
  slug: string,
  workspaceId: string,
  agentSessionId: string,
): AcpConversation | undefined {
  return byName.get(sessionKey(slug, workspaceId, agentSessionId))
}

/** The same, by the driver's handle. */
export function acpConversationByHandle(
  slug: string,
  workspaceId: string,
  handle: string,
): AcpConversation | undefined {
  return byName.get(handleKey(slug, workspaceId, handle))
}

/** Test-only: drop every entry. */
export function _resetAcpRegistryForTests(): void {
  byName.clear()
  launchModels.clear()
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
