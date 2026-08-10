// The public interface of the records feature. Everything outside this
// directory imports `#features/records`; the SEALED_FOLDERS lint rule stops
// src from reaching past this file. Modules in here import each other by
// relative path, which is why they are unaffected by that rule.
//
// This feature is the SERVER's half of a worktree: every durable fact a
// client can ask about that no substrate can answer — the title a user
// typed, the pin they set, the creation time that survives a restart the
// runtime did not, the conversations a worktree has hosted and what each
// opened with, and how it died.
//
// It is the only feature allowed to touch `#platform/db`, and that is the
// point. Everything that touches the cluster, a git worktree, a transcript
// or tmux is being split into a separate process that has no database
// (docs/plans/layered-server.md), so the two halves meet twice and only twice:
// `applyHerdEvent` persists what a herd reports, and `pushDesiredWorkspaces`
// tells it what the server records as existing. Neither direction is a
// query — a herd never looks a row up.
//
// The join paths that read these rows alongside a herd's report
// (`listActiveWorktrees`, restart, the stopped listing) deliberately live in
// `#features/worktrees` next to the verbs they orchestrate, and reach in
// through this barrel like anything else.
//
// Adding a name here widens the interface and obliges a unit test in
// packages/server/test/features/records/.

export {
  deleteProjectAgentSessions,
  deleteWorktreeAgentSessions,
  firstAgentSession,
  getAgentSessionsFor,
  getProjectAgentSessions,
  listActiveAgentSessions,
  listWorktreeAgentSessions,
  recordAgentSessions,
  recordedConversationHandles,
  setActiveAgentSessions,
  setAgentSessionCapture,
  toAgentSessionEntry,
  type AgentSessionLinkRow,
  type DiscoveredAgentSession,
} from './agent-session-store'
export { applyHerdEvent } from './apply-herd-event'
export { desiredWorktrees, type DesiredWorktree, type DesiredWorktrees } from './desired-workspaces'
export { closeRecords, openRecords } from './lifecycle'
export { loadTokens, saveTokens, type TokenEntry, type TokenKind } from './token-store'
export {
  DEFAULT_TOOL_KEY,
  clearShortcutOverrides,
  getDefaultTool,
  getShortcutOverrides,
  isSerializedChord,
  isValidTool,
  setDefaultToolChecked,
  setShortcutOverride,
} from './preferences'
export {
  deleteProjectRow,
  getProjectRow,
  listProjectRows,
  recordProject,
} from './project-store'
export {
  clearWorktreeStopped,
  deleteProjectWorktrees,
  deleteWorktreeRow,
  findWorktreeRow,
  getProjectWorktreeRows,
  getWorktreeRow,
  listWorktreeRows,
  priorStopOf,
  recordAllDeathsSeen,
  recordDeathSeen,
  recordWorktreeCreated,
  recordWorktreeStopped,
  restoreWorktreeStop,
  setWorktreeBackground,
  setWorktreeBaseBranch,
  setWorktreeTitle,
  type PriorStop,
  type WorktreeRow,
} from './worktree-store'
