import { rpc } from './rpc'
import type { SessionTerminalEntry } from '@yaac/shared/types'

/** Terminals a session's container offers beyond the agent view: the other
 *  windows of the `yaac` tmux session (initCommands dev servers, scratch
 *  shells, …). */
export async function getSessionTerminals(sessionId: string): Promise<SessionTerminalEntry[]> {
  return rpc.session[':id'].terminals.$get({ param: { id: sessionId } }).then((r) => r.json())
}

/** Create a scratch-shell window in the session's `yaac` tmux session.
 *  Returns the new entry so a pane can open without waiting for the next
 *  terminals poll. */
export async function createShellTerminal(sessionId: string): Promise<SessionTerminalEntry> {
  return rpc.session[':id'].terminals.$post({ param: { id: sessionId } }).then((r) => r.json())
}

/** Kill a window terminal — and whatever runs in it. The server refuses
 *  the agent window. */
export async function killSessionTerminal(sessionId: string, target: string): Promise<void> {
  await rpc.session[':id'].terminals.close.$post({ param: { id: sessionId }, json: { target } })
}
