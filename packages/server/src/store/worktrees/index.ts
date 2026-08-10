// The public interface of the worktree store: the checkout staging a create
// runs before any runtime exists (`seed`), and the metadata document that
// makes a worktree self-describing on disk (`worktree-meta`). Everything
// outside this directory imports `#store/worktrees`; the SEALED_FOLDERS
// lint rule stops src from reaching past this file. Adding a name here
// widens the interface and obliges a unit test in
// packages/server/test/store/worktrees/.

export { prepareEphemeralMounts, seedClaudeJson, seedClaudeSettings, type EphemeralMount } from './seed'
export {
  clearSpareFlag,
  deleteWorktreeMeta,
  ensureSessionStartsLog,
  foldSessionStarts,
  mergeSessions,
  newWorktreeMeta,
  readSessionStarts,
  readWorktreeMeta,
  recordWorktreeLife,
  updateWorktreeMeta,
  worktreesOnCurrentLife,
  type SessionStartSighting,
  type WorktreeMeta,
  type WorktreeMetaSession,
} from './worktree-meta'
