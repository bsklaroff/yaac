// The public interface of the agents feature. Everything outside this
// directory imports `#features/agents`; the SEALED_FOLDERS lint rule stops
// src from reaching past this file. Modules in here import each other by
// relative path, which is why they are unaffected by that rule.
//
// This feature owns *what yaac knows about a coding agent*: how each tool
// is launched inside tmux, where it writes its transcript, how its
// busy/idle state is read, and how it announces the conversations it
// starts. Nothing here knows a session exists — no pod lifecycle, no
// database, no status store. That is the whole point of the seal: the
// per-tool grammars (claude's Braille spinner titles, opencode's busy
// markers, codex's rollout filenames) are the most volatile knowledge in
// the server, and they change without any caller changing.
//
// `agent-tools.ts` is the dispatch table every caller should reach for
// first: it takes an `AgentTool` and answers the question, so the
// per-tool modules stay internal. A name only belongs below when the
// answer genuinely cannot be given tool-agnostically.
//
// Adding a name here widens the interface and obliges a unit test in
// packages/server/test/features/agents/. Modules not re-exported are
// internal: `jsonl.ts` is exercised through the transcript readers, and
// the per-tool classifiers through `classifyAgentObservation`.

export {
  agentStatusFormat,
  agentWindowName,
  agentWindowTool,
  classifyAgentObservation,
  getAgentSessionFirstMessage,
  normalizeTool,
  type SessionAgentStatus,
} from './agent-tools'
export {
  MODEL_RE,
  TMUX,
  buildAgentCmd,
  initWindowCommand,
  resolveInitWindows,
  typeInitialPrompt,
  verifyAgentWindowAlive,
  type InitWindow,
} from './agent-command'
export {
  clearPanePointers,
  readAllWorktreeLinks,
  type AgentSessionLink,
} from './agent-links'
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
  fromStoredTranscriptPath,
  rehomeTranscriptPath,
  scanProjectTranscripts,
  sessionTranscriptPath,
  toStoredTranscriptPath,
  transcriptLastActiveMs,
  type TranscriptRecord,
} from './transcripts'
