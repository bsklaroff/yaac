// The public interface of the worktree store: the checkout staging a create
// runs before any runtime exists (`seed`), the in-pod hook's session-starts
// log (`session-starts`), and the reader that carries a previous yaac's
// metadata documents into rows (`meta-import`). Everything outside this
// directory imports `#store/worktrees`; the SEALED_FOLDERS lint rule stops
// src from reaching past this file. Adding a name here widens the interface
// and obliges a unit test in packages/server/test/store/worktrees/.

export { prepareEphemeralMounts, seedClaudeJson, seedClaudeSettings, type EphemeralMount } from './seed'
export {
  deleteSessionStartsLog,
  ensureSessionStartsLog,
  readSessionStarts,
  sessionStartsLogSize,
  type SessionStartSighting,
} from './session-starts'
export {
  deleteLegacyMetaFiles,
  readLegacyMetaDocuments,
  setAsideUnreadableMeta,
  type LegacyWorktreeMeta,
} from './meta-import'
