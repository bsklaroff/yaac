// The public interface of the db feature. Everything outside this
// directory imports `#db`; the SEALED_FOLDERS lint rule stops
// src from reaching past this file. Modules in here import each other by
// relative path, which is why they are unaffected by that rule.
//
// This feature is the durable half of a worktree: every fact a client can
// ask about that no substrate can answer — the title a user typed, the
// sidebar group they filed it under, the creation time that survives a
// restart the runtime did not,
// the conversations a worktree has hosted and what each opened with, and
// how it died.
//
// It owns the database outright — the handle (`client.ts`) and the schema
// (`schema.ts`) are internal modules here. `getDb` and the tables stay off
// this barrel: a layer that could reach either could build its own queries,
// and that is the one thing the discipline exists to prevent. All that
// crosses from the handle is the void-returning `openDb`/`closeDb` pair the
// composition root drives. Observed facts
// enter through
// exactly one door: code that watches the substrate or reads a worktree's
// disk emits a `WorktreeEvent`, and `applyWorktreeEvent` alone decides
// which rows that lands in — its per-event mutators are internal, off this
// barrel. Intent (a title, a group, a preference) is written through the
// ordinary functions below, and reads are free to every layer above.
//
// The join paths that read these rows alongside a runtime observation
// (`listActiveWorktrees`, restart, the stopped listing) deliberately live
// in `#domain/worktrees` next to the verbs they orchestrate, and reach
// in through this barrel like anything else. So does the wire projection
// they share (`toAgentSessionEntry`): the entry it builds is half row and
// half live observation, and what this layer speaks is rows.
//
// Adding a name here widens the interface and obliges a unit test in
// packages/server/test/db/.

export {
  deleteProjectAgentSessions,
  firstAgentSession,
  getAgentSessionsFor,
  getProjectAgentSessions,
  listActiveAgentSessions,
  listWorktreeAgentSessions,
  recordedConversationHandles,
  setAgentSessionCapture,
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
export { desiredWorktrees, type DesiredWorktree, type DesiredWorktrees } from './desired-worktrees'
export {
  createWorktreeGroup,
  deleteProjectWorktreeGroups,
  deleteWorktreeGroup,
  listWorktreeGroupRows,
  renameWorktreeGroup,
  setWorktreeGroup,
  setWorktreeGroupPinned,
  type WorktreeGroupRow,
} from './group-store'
export { closeDb, openDb } from './client'
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
  getProjectLastPermissionMode,
  getProjectRow,
  listProjectRows,
  recordProject,
  recordProjectPermissionMode,
} from './project-store'
export {
  claimSpareWorktree,
  clearWorktreeStopped,
  deleteProjectWorktrees,
  deleteSpareWorktreeRow,
  findWorktreeRow,
  getProjectWorktreeRows,
  getWorktreeRow,
  listSpareWorktreeIds,
  listWorktreeRows,
  recordAllDeathsSeen,
  recordDeathSeen,
  restoreSpareWorktree,
  findWorktreeByMamaToken,
  setWorktreeMamaTokenHash,
  setWorktreeTitle,
  type PriorStop,
  type WorktreeRow,
} from './worktree-store'
