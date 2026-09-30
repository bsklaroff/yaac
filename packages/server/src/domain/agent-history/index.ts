// The public interface of the agent-history feature. Everything outside this
// directory imports `#domain/agent-history`; the SEALED_FOLDERS lint rule
// stops src from reaching past this file.
//
// A workspace's agent history is the conversation state each tool keeps —
// transcripts, file-history, codex's rollouts and sqlite, pi's logs — held
// per workspace under `history/<workspaceId>` rather than in the project's
// shared tool homes (docs/workspace-storage.md). Workspace create converges it
// into the shape the runtime reaches before every launch, and the paths that
// erase a workspace take it with them. Where each tool's files are read from
// is `#runtime/agents`'s; this is where they are put.

export { convergeAgentHistory, removeAgentHistory } from './history'
