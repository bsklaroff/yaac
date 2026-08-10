// The public interface of the agents feature. Everything outside this
// directory imports `#features/agents`; the SEALED_FOLDERS lint rule stops
// src from reaching past this file. Modules in here import each other by
// relative path, which is why they are unaffected by that rule.
//
// This feature owns *what yaac knows about a coding agent*: how each tool
// is launched inside tmux, how the server talks to it, where it writes its
// transcript, how its busy/idle state is read, and how it announces the
// conversations it starts. Nothing here knows a session exists — no pod
// lifecycle, no database, no status store. That is the whole point of the
// seal: the per-tool grammars (claude's Braille spinner titles, opencode's
// busy markers, codex's rollout filenames) and the per-protocol wire
// details (ACP's `session/update` variants) are the most volatile
// knowledge in the server, and they change without any caller changing.
//
// There are two dispatch tables, on two axes, and a caller should reach
// for one of them before anything else:
//
//  - `agent-tools.ts` takes an `AgentTool` — which agent is running.
//  - `drivers.ts` takes an `AgentMode` — which protocol drives it. The
//    `AgentDriver` it returns is how a conversation is launched and
//    observed, so `tui` (tmux control mode) and `acp` (JSON-RPC under
//    acpd) stay interchangeable to every caller.
//
// A name only belongs below when the answer genuinely cannot be given
// tool- or mode-agnostically.
//
// Adding a name here widens the interface and obliges a unit test in
// packages/server/test/features/agents/. Modules not re-exported are
// internal: `jsonl.ts` is exercised through the transcript readers, the
// per-tool classifiers through `classifyAgentObservation`, `control-mode.ts`
// and the `acp-*` protocol modules through their drivers.

export {
  agentDriver,
  type AgentConnectDeps,
  type AgentObservation,
  type DrivenWorktree,
  type LiveAgent,
} from './drivers'
export { acpAdapterFor } from './acp-driver'
export { attachAcp, type AcpSocket } from './acp-bridge'
export { acpConversation } from './acp-registry'
export { readAcpFirstPrompt } from './acp-log'
export type { AcpConversation } from './acp-client'
export {
  agentStatusFormat,
  agentWindowName,
  agentWindowTool,
  classifyAgentObservation,
  getAgentSessionFirstMessage,
  normalizeTool,
  type AgentPaneStatus,
} from './agent-tools'
export {
  TMUX,
  agentWindowTarget,
  buildAgentCmd,
  initWindowCommand,
  resolveInitWindows,
  typeInitialPrompt,
  verifyAgentWindowAlive,
  type InitWindow,
} from './agent-command'
export { ensureClaudeHooks } from './claude'
export { removeLegacyCodexHook } from './codex'
export { ensureOpencodeConfigJson } from './opencode'
export {
  buildUpstreamExec,
  buildWindowsExec,
  buildWorktreeLinkExec,
  validateInitWindows,
  type AgentWindowSpec,
} from './setup-commands'
export {
  resolveProjectPath,
  sessionTranscriptPath,
  toProjectRelative,
  transcriptLastActiveMs,
} from './transcripts'
