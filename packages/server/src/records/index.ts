// The public interface of the records feature. Everything outside this
// directory imports `#records`; the SEALED_FOLDERS lint rule stops
// src from reaching past this file. Modules in here import each other by
// relative path, which is why they are unaffected by that rule.
//
// This feature is the durable half of a worktree: every fact a client can
// ask about that no substrate can answer — the title a user typed, the pin
// they set, the creation time that survives a restart the runtime did not,
// the conversations a worktree has hosted and what each opened with, and
// how it died.
//
// It is the only feature allowed to touch `#platform/db`, and that is the
// point (docs/plans/layered-server.md). Observed facts enter through
// exactly one door: code that watches the substrate or reads a worktree's
// disk emits a `WorktreeEvent`, and `applyWorktreeEvent` alone decides
// which rows that lands in — its per-event mutators are internal, off this
// barrel. Intent (a title, a pin, a preference) is written through the
// ordinary functions below, and reads are free to every layer above.
//
// The join paths that read these rows alongside a runtime observation
// (`listActiveWorktrees`, restart, the stopped listing) deliberately live
// in `#domain/worktrees` next to the verbs they orchestrate, and reach
// in through this barrel like anything else.
//
// Adding a name here widens the interface and obliges a unit test in
// packages/server/test/features/records/.

export {
  deleteProjectAgentSessions,
  firstAgentSession,
  getAgentSessionsFor,
  getProjectAgentSessions,
  listActiveAgentSessions,
  listWorktreeAgentSessions,
  recordedConversationHandles,
  setAgentSessionCapture,
  toAgentSessionEntry,
  type AgentSessionLinkRow,
  type DiscoveredAgentSession,
} from './agent-session-store'
export { applyWorktreeEvent } from './apply-worktree-event'
export {
  MAX_PROMPT_LENGTH,
  type ActiveSession,
  type DiscoveredSession,
  type LaunchedSession,
  type WorktreeEvent,
} from './events'
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
  findWorktreeRow,
  getProjectWorktreeRows,
  getWorktreeRow,
  listWorktreeRows,
  recordAllDeathsSeen,
  recordDeathSeen,
  setWorktreeBackground,
  setWorktreeTitle,
  type PriorStop,
  type WorktreeRow,
} from './worktree-store'
