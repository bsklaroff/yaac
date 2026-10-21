// Barrel for `#runtime/agents`: what yaac knows about each coding agent
// (how it is launched in tmux, how the server talks to it, how busy/idle is
// read, how it announces conversations). It knows nothing of workspace
// lifecycle, the DB or the status store, so the volatile per-tool and
// per-mode details stay contained here, including the Agent Client Protocol
// an `acp` conversation speaks and where each tool keeps its history.
//
// Two dispatch tables, which callers should reach for first:
//
//  - `agent-tools.ts`, keyed by `AgentTool` (which agent).
//  - `drivers.ts`, keyed by `AgentMode` (which protocol); its `AgentDriver`
//    launches and observes a conversation for `tui` and `acp` alike.
//
// Export something below only when it cannot be tool- or mode-agnostic.
// Each export needs a unit test in packages/server/test/runtime/agents/.
// Internal modules are covered through the exports: per-tool classifiers
// and launch lines via `agentDriver`, and the `acp-*` modules via their
// drivers.

export {
  agentDriver,
  type AgentConnectDeps,
  type AgentObservation,
  type DrivenWorkspace,
  type LiveAgent,
} from './drivers'
export { attachAcp, type AcpSocket } from './acp-bridge'
// The webapp's terminals hold their own control-mode client; the status
// watcher lists them over its own.
export { ControlModeClient, listTerminals, type ControlModeNotification } from './control-mode'
export { setAcpPermissionMode } from './acp-driver'
export { acpLaunchModel } from './acp-adapters'
// The status watcher discards a stopped workspace's queued messages.
export { acpConversation, dropAcpQueues, whenAcpConversation } from './acp-registry'
export {
  agentTitlesItself,
  agentWindowName,
  getAgentSessionFirstMessage,
  getAgentSessionTitle,
  resolveAgentPermissionMode,
} from './agent-tools'
export {
  initWindowCommand,
  resolveInitWindows,
  tmuxCmd,
  verifyAgentWindowAlive,
  AgentLaunchDeadError,
  type InitWindow,
} from './agent-command'
// codex's posture is read from its rollout rather than pushed on its pane.
export { getCodexRolloutSettings } from './codex'
export { ensureAgentReporters } from './agent-reporters'
export { ensureToolApiKeyConfig } from './tool-api-keys'
export { buildWindowsExec } from './setup-commands'
export { PromptNotRunError, type AcpConversation } from './acp-client'
export { acpPage, acpRecord, acpStoredImage, readAcpFirstPrompt, readAcpLife, readAcpPage, replayAcpLog, type AcpLife, type RecordOrigin } from './acp-log'
export { ClaudeTranscriptReplay, claudeSubagentThreads, claudeTranscriptAsAcp } from './claude-acp-replay'
export { codexTranscriptAsAcp } from './codex-acp-replay'
export { opencodeTranscriptAsAcp } from './opencode-acp-replay'
export { piTranscriptAsAcp } from './pi-acp-replay'
export { type SandboxFile, openSandboxDir, openSandboxFile, readSandboxFile } from './sandbox-fs'
export {
  ACP_RECORD_NAME,
  type ConversationFile,
  conversationFiles,
  hasConversationHistory,
  locateTranscript,
  openConversationFile,
  resolveProjectPath,
  sessionTranscriptPath,
  transcriptLastActiveMs,
} from './transcripts'
