// The public interface of the sessions feature. Everything outside this
// directory imports `#features/sessions`; the SEALED_FOLDERS lint rule
// stops src from reaching past this file. Modules in here import each
// other by relative path, which is why they are unaffected by that rule.
//
// This feature owns a session's *life*: creating one (worktree, pod,
// vcluster, agent windows), restarting it, stopping it, reaping it when it
// dies, and the rows that record all of that. It is the one place allowed
// to compose the other feature verticals — it registers a session with
// `#features/egress`, stands its forwards up through `#features/forwarders`,
// builds its agent windows with `#features/agents`, and evicts its
// observations from `#features/status` on teardown. Those four never import
// back, which is what keeps the graph acyclic and each of them testable
// without a session.
//
// The reconcile entry points at the bottom are the background loop's half
// of the same job: every one is idempotent and self-gating, because the
// loop calls them on a fixed tick with no memory of the last pass.
//
// Adding a name here widens the interface and obliges a unit test in
// packages/server/test/features/sessions/. Modules not re-exported are
// internal: the seed/spawn-script staging is covered through `createSession`.

export {
  deleteProjectAgentSessions,
  listActiveAgentSessions,
  listWorktreeAgentSessions,
  recordAgentSessions,
  setActiveAgentSessions,
  toAgentSessionEntry,
} from './agent-session-store'
export { reconcileAgentSessions } from './agent-session-registry'
export { getSessionChanges, sessionForkBranch } from './changes'
export { cleanupSessionDetached, gcOrphanEphemeralModuleDirs } from './cleanup'
export {
  createSession,
  type SessionCreateOptions,
  type SessionCreateResult,
} from './create'
export {
  getSessionBlockedHosts,
  getSessionDetail,
  getSessionPrompt,
  type SessionDetail,
} from './detail'
export { ensureProjectExists, listActiveSessions } from './list'
export { removeProject } from './project-teardown'
export { captureSessionPrompts } from './prompt-capture'
export { tryClaimPrewarmed } from './prewarm'
export { reconcilePrewarmPool } from './prewarm-reconcile'
export {
  listProvisioning,
  registerProvisioning,
  removeProvisioning,
  runProvisioned,
} from './provisioning'
export { resolveSessionContainer, resolveWorktreeRecord } from './resolve'
export { restartWorktree } from './restart'
export { reconcileImageSalvage } from './salvage-reconcile'
export { rebranchSpare, retoolSpare } from './spare-pool'
export { reconcileSpawnRequests } from './spawn-reconcile'
export { reconcileStaleSessions } from './stale-sessions'
export { stopWorktree } from './stop'
export { listStoppedWorktrees } from './stopped-list'
export {
  MAX_PROMPT_LENGTH,
  deleteProjectWorktrees,
  deleteWorktreeRow,
  recordAllDeathsSeen,
  recordDeathSeen,
  recordWorktreeCreated,
  setWorktreeBackground,
  setWorktreeBaseBranch,
  setWorktreeTitle,
} from './worktree-store'
