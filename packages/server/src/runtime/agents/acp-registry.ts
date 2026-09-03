/**
 * Registry of the live `AcpConversation` objects, so anything holding a
 * conversation's *name* can reach the connection driving it.
 *
 * The same shape as the tmux control-stream registry, and for the same reason:
 * the connection is owned by the long-lived status watcher, but the things
 * that need it — a WebSocket handler, a prompt delivery — are created per
 * client and cannot own the agent's lifetime. An entry is a *borrow*, never a
 * handle to close; the driver that registered it is the only thing allowed to.
 *
 * A conversation has two names and is indexed under both, because the two
 * callers legitimately hold different ones. A pane addresses it by ACP session
 * id (its `acp:<id>` target, which survives a restart because the database
 * remembers it); the driver addresses it by handle — the tmux window / acpd
 * socket name — which is what it knows before the handshake has produced an id.
 */

import type { AcpConversation } from './acp-client'

const byName = new Map<string, AcpConversation>()

function sessionKey(slug: string, worktreeId: string, agentSessionId: string): string {
  return `${slug}/${worktreeId}/id:${agentSessionId}`
}

function handleKey(slug: string, worktreeId: string, handle: string): string {
  return `${slug}/${worktreeId}/handle:${handle}`
}

/**
 * Publish a conversation. `agentSessionId` is absent until the handshake
 * produces one, so a fresh conversation is first registered by handle alone
 * and re-registered once `session/new` answers.
 */
export function registerAcpConversation(
  slug: string,
  worktreeId: string,
  names: { handle: string; agentSessionId?: string },
  conversation: AcpConversation,
): void {
  byName.set(handleKey(slug, worktreeId, names.handle), conversation)
  if (names.agentSessionId !== undefined) {
    byName.set(sessionKey(slug, worktreeId, names.agentSessionId), conversation)
  }
}

export function unregisterAcpConversation(
  slug: string,
  worktreeId: string,
  names: { handle: string; agentSessionId?: string },
): void {
  byName.delete(handleKey(slug, worktreeId, names.handle))
  if (names.agentSessionId !== undefined) {
    byName.delete(sessionKey(slug, worktreeId, names.agentSessionId))
  }
}

/** The live conversation a pane's `acp:<id>` target names, or undefined when
 *  none is connected right now (the worktree is booting, or its connection is
 *  mid-respawn). */
export function acpConversation(
  slug: string,
  worktreeId: string,
  agentSessionId: string,
): AcpConversation | undefined {
  return byName.get(sessionKey(slug, worktreeId, agentSessionId))
}

/** The same, by the driver's in-pod handle. */
export function acpConversationByHandle(
  slug: string,
  worktreeId: string,
  handle: string,
): AcpConversation | undefined {
  return byName.get(handleKey(slug, worktreeId, handle))
}

/** Test-only: drop every entry. */
export function _resetAcpRegistryForTests(): void {
  byName.clear()
  launchModels.clear()
}

/**
 * The model a conversation was launched to run, for the adapters that can only
 * be told one over the protocol (`modelVia: 'protocol'`).
 *
 * A launch command is authored in one place and the handshake that must carry
 * its model runs in another, seconds later and driven by a different object —
 * so the value is parked here between them rather than threaded through a
 * launch spec, a database column and a connection dep that nothing else would
 * use. Keyed by the conversation's launch id, which is unique by construction:
 * a fresh conversation is launched under its worktree's id, a resumed one under
 * the id the agent minted.
 *
 * Taken once, then forgotten: a reattach must NOT re-send it. The adapter is
 * already holding the model from the first attach, and the user may have
 * changed it since — re-asserting the launch value on a relay hiccup would
 * silently undo their choice. A server that restarts between the launch and the
 * first attach therefore loses the override and the conversation runs the
 * adapter's default, which is logged.
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
