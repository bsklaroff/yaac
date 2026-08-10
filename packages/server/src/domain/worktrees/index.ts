// The public interface of the worktrees feature. Everything outside this
// directory imports `#domain/worktrees`; the SEALED_FOLDERS lint rule
// stops src from reaching past this file. Modules in here import each
// other by relative path, which is why they are unaffected by that rule.
//
// This feature owns a worktree's *life*: creating one (worktree, pod,
// vcluster, agent windows), restarting it, stopping it, reaping it when it
// dies, and the rows that record all of that. It is the one place allowed
// to compose the other feature verticals — it registers a worktree with
// `#runtime/k8s/egress`, stands its forwards up through `#runtime/k8s/forwarders`,
// builds its agent windows with `#runtime/agents`, and evicts its
// observations from `#runtime/status` on teardown. Those four never import
// back, which is what keeps the graph acyclic and each of them testable
// without a worktree.
//
// The reconcile entry points at the bottom are the background loop's half
// of the same job: every one is idempotent and self-gating, because the
// loop calls them on a fixed tick with no memory of the last pass.
//
// Adding a name here widens the interface and obliges a unit test in
// packages/server/test/features/worktrees/. Modules not re-exported are
// internal: the seed/spawn-script staging is covered through `createWorktree`.

export { reconcileAgentSessions } from './agent-session-registry'
export {
  cleanupWorktreeDetached,
  gcOrphanEphemeralModuleDirs,
  teardownForRestart,
} from './cleanup'
export {
  createWorktree,
  type WorktreeCreateOptions,
  type WorktreeCreateResult,
} from './create'
export {
  getWorktreeBlockedHosts,
  getWorktreeDetail,
  getWorktreePrompt,
  type WorktreeDetail,
} from './detail'
export { worktreeForkBranch } from './fork-branch'
export { ensureProjectExists, listActiveWorktrees } from './list'
export { purgeProjectBytes } from './project-purge'
export { removeProject } from './project-teardown'
export { tryClaimPrewarmed } from './prewarm'
export { reconcilePrewarmPool } from './prewarm-reconcile'
export {
  inFlightWorktreeIds,
  listProvisioning,
  registerProvisioning,
  removeProvisioning,
  runProvisioned,
} from './provisioning'
export { resolveWorktreeContainer, resolveWorktreeRecord } from './resolve'
export { restartWorktree } from './restart'
export { rebranchSpare, retoolSpare } from './spare-pool'
export { reconcileSpawnRequests } from './spawn-reconcile'
export { reconcileStaleWorktrees } from './stale-worktrees'
export { stopWorktree, type StoppedWorktreeInfo } from './stop'
export { listStoppedWorktrees } from './stopped-list'
