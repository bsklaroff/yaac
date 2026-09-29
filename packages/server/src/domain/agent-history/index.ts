// The public interface of the agent-history feature. Everything outside this
// directory imports `#domain/agent-history`; the SEALED_FOLDERS lint rule
// stops src from reaching past this file.
//
// A worktree's agent history is the conversation state each tool keeps —
// transcripts, file-history, codex's rollouts and sqlite, pi's logs — held
// per worktree under `history/<worktreeId>` rather than in the project's
// shared tool homes (docs/worktree-storage.md). Worktree create converges it
// into the shape the runtime reaches before every launch, and the paths that
// erase a worktree take it with them. Where each tool's files are read from
// is `#runtime/agents`'s; this is where they are put.

export { convergeAgentHistory, removeAgentHistory } from './history'
