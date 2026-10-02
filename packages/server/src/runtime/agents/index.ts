// Barrel for `#runtime/agents`: what yaac knows about each coding agent
// (how it is launched in tmux, how the server talks to it, where it writes
// its transcript, how busy/idle is read, how it announces conversations).
// It knows nothing of workspace lifecycle, the DB or the status store, so
// the volatile per-tool and per-protocol details stay contained here.
//
// Two dispatch tables, which callers should reach for first:
//
//  - `agent-tools.ts`, keyed by `AgentTool` (which agent).
//  - `drivers.ts`, keyed by `AgentMode` (which protocol); its `AgentDriver`
//    launches and observes a conversation for `tui` and `acp` alike.
//
// Export something below only when it cannot be tool- or mode-agnostic.
// Each export needs a unit test in packages/server/test/runtime/agents/.
// Internal modules are covered through the exports: `jsonl.ts` via the
// transcript readers, per-tool classifiers via `classifyAgentObservation`,
// `control-mode.ts` and the `acp-*` modules via their drivers.

export {
  agentDriver,
  type AgentConnectDeps,
  type AgentObservation,
  type DrivenWorkspace,
  type LiveAgent,
} from './drivers'
export { attachAcp } from './acp-bridge'
export { parkAcpLaunchModel, setAcpPermissionMode } from './acp-driver'
// The status watcher discards a stopped workspace's queued messages.
export { acpConversation, dropAcpQueues, whenAcpConversation } from './acp-registry'
export { acpRecord, readAcpFirstPrompt, replayAcpLog } from './acp-log'
// A tui claude conversation rendered as acp events (see the module header).
export { claudeTranscriptAsAcp } from './claude-acp-replay'
export type { AcpConversation } from './acp-client'
export {
  agentStatusFormat,
  agentWindowName,
  agentWindowTool,
  classifyAgentObservation,
  getAgentSessionFirstMessage,
  resolveAgentPermissionMode,
  type AgentPaneStatus,
} from './agent-tools'
export {
  buildAgentCmd,
  initWindowCommand,
  resolveInitWindows,
  tmuxCmd,
  verifyAgentWindowAlive,
  AgentLaunchDeadError,
  type InitWindow,
} from './agent-command'
// Where each tool keeps its transcript, and the project-relative form it is
// stored in.
export {
  CLAUDE_POD_CWD,
  CLAUDE_POD_REPO,
  claudeProjectDirName,
  locateTranscript,
  resolveProjectPath,
  sessionIdFromPiLog,
  sessionTranscriptPath,
  toProjectRelative,
  transcriptLastActiveMs,
} from './transcripts'
// codex's posture is read from its rollout rather than pushed on its pane;
// rollout names and lineage also group a workspace's history.
export { codexRolloutParent, codexRolloutThreadId, getCodexPermissionMode } from './codex'
export { ensureAgentReporters } from './agent-reporters'
// How the server reads and writes the project dirs an agent can write too.
export { openSandboxDir, readSandboxFile, type SandboxFile } from './sandbox-fs'
export {
  buildCloneLinkExec,
  buildOriginRefreshExec,
  buildWindowsExec,
  validateInitWindows,
} from './setup-commands'
