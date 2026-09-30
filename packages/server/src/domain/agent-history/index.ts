// Public interface of the sealed agent-history folder
// (`#domain/agent-history`).
//
// A workspace's agent history is each tool's conversation state
// (transcripts, file-history, codex's rollouts and sqlite, pi's logs), kept
// per workspace under `history/<workspaceId>` rather than in the project's
// shared tool homes (docs/workspace-storage.md). Workspace create prepares
// it before every launch, and erasing a workspace removes it.
// `#runtime/agents` reads these files; this folder places them.

export { convergeAgentHistory, removeAgentHistory } from './history'
