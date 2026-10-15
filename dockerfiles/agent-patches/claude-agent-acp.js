/**
 * Patches claude-agent-acp (the pinned release, see `ACP_ADAPTERS.claude`).
 *
 *   node claude-agent-acp.js <claude-agent-acp>/dist/acp-agent.js
 *
 * Run by `dockerfiles/Dockerfile.tools` and by the containerless driver's
 * install, right after npm installs claude-agent-acp. A release the edit no
 * longer fits fails the install (`applyEdits`). Bump the patch's `revision`
 * in `@yaac/shared/tool-install` whenever its edits change.
 *
 * One change: a prompt the agent folds into a run it started itself is
 * answered. When a finished background task wakes claude after the user's
 * turn has ended, a message sent during that run is refused as a steer
 * (`noRunningTurn`) and goes as a `session/prompt`, which the CLI then
 * consumes inside the same run. That run's result carries the run's own
 * origin (`task-notification`), and the adapter files every such result as
 * the agent's own work, so the prompt is never answered and yaac shows the
 * conversation working forever. The result does name the messages it
 * consumed (`user_message_uuids`), so one that names a queued prompt is
 * treated as that prompt's result. Goes once a claude-agent-acp release
 * answers such a prompt.
 */

import { applyEdits, patchFileFromArgv } from './apply-edits.js'

const EDITS = [
  {
    name: 'a result that consumed a queued prompt answers it',
    anchor: `const isAutonomousResult = message.origin != null && AUTONOMOUS_RESULT_ORIGINS.has(message.origin.kind);`,
    insert: 'replace',
    text: `const answersQueuedPrompt = (message.user_message_uuids ??
                            (message.user_message_uuid !== undefined ? [message.user_message_uuid] : []))
                            .some((uuid) => findUnsettledTurn(uuid) !== undefined);
                        const isAutonomousResult = !answersQueuedPrompt && message.origin != null && AUTONOMOUS_RESULT_ORIGINS.has(message.origin.kind);`,
  },
]

/** The patched source; see `applyEdits`. */
export function patchClaudeAgentAcp(source) {
  return applyEdits(source, 'claude-agent-acp', EDITS)
}

patchFileFromArgv(import.meta.url, patchClaudeAgentAcp)
