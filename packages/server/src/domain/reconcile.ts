import {
  gcOrphanEphemeralModuleDirs,
  reconcileAgentSessions,
  reconcilePrewarmPool,
  reconcileQueuedWorkspaces,
  reconcileStaleWorkspaces,
} from '#domain/workspaces'
import { reconcileGeneratedTitles } from '#domain/titles'
import { refreshProjectOrigins } from '#domain/projects'
import { adoptRefreshedToolCredentials, syncToolCredentialsThrottled } from '#domain/auth'
import { workspaceDriver } from '#drivers/driver'
import type { ReconcileStep } from '#drivers/contract'

/**
 * The reconcile steps, in the order a pass runs them. The runtime's own
 * steps are inserted at two points: its pre-pool group before the spare pool,
 * and its maintenance group after the sweeps that read rows. Their contents
 * and internal order are the runtime's business.
 */
export function defaultReconcileSteps(): ReconcileStep[] {
  const driver = workspaceDriver()
  const runtime = driver.reconcileSteps()
  // Credential upkeep, one step per driver kind:
  //  - containerless: `credential-sync` copies OAuth tokens a workspace
  //    refreshed into the host store (and back out to other projects). It is
  //    the only path that runs while the install is idle; create, attach,
  //    stop and usage cycles cover their own moments. Resync-only.
  //  - mediated (k8s): the proxy captures each refresh into an object the
  //    runtime watches, and `credential-adopt` stores it. Triggered by that
  //    object's changes.
  const credentialSync: ReconcileStep[] = driver.kind !== 'containerless'
    ? [{ name: 'credential-adopt', triggers: ['proxy-refreshed'],
      run: () => adoptRefreshedToolCredentials(driver.refreshedCredentials()) }]
    : [{ name: 'credential-sync', triggers: [], run: () => syncToolCredentialsThrottled() }]
  // A spare saves the image pull and pod boot a cold workspace pays. A
  // containerless workspace starts in milliseconds, so it has no pool.
  const pool: ReconcileStep[] = driver.kind === 'containerless' ? [] : [
    // Keep one prewarmed spare per active project. No-op when the pool size
    // is 0.
    { name: 'prewarm-pool', triggers: ['workspaces'],
      run: (ctx) => reconcilePrewarmPool(ctx.snapshot()) },
  ]
  return [
    // The stale reaper runs first, so the prewarm pool sees counts after
    // reaping. `status-streams` is a trigger because tmux dying in a pod is
    // not a substrate event; a lost driver connection means liveness must be
    // probed. Slower sweeps wait for the resync, which is fine given their
    // grace periods (30 minutes for podless rows, 60s for the rest). A
    // flapping stream can't cause a reaping loop: reaping needs a conclusive
    // in-pod verdict, and a failed probe keeps the workspace.
    { name: 'stale-workspaces', triggers: ['workspaces', 'units', 'status-streams'],
      run: (ctx) => reconcileStaleWorkspaces(ctx.snapshot()) },
    // Crash backstop for queued workspaces: a launch interrupted by a server
    // restart, or a release lost before launching. `stopWorkspace` launches
    // directly, so the resync (including the first pass) is enough.
    { name: 'queued-workspaces', triggers: [], run: () => reconcileQueuedWorkspaces() },
    // Runtime work that must precede the pool: a spare's create should join
    // image builds already running, and anything holding capacity should be
    // freed first.
    ...runtime.prePool,
    ...pool,
    // Record each workspace's agent sessions, which are live, and their
    // opening messages, from the watcher's live agent set. The only step
    // that reads that set, so `live-agents` makes a new conversation a row
    // within a debounce rather than a resync.
    { name: 'agent-sessions', triggers: ['workspaces', 'live-agents'],
      run: (ctx) => reconcileAgentSessions(ctx.snapshot()) },
    // Runtime upkeep (substrate GCs, datapath repairs), after the sweeps
    // above so a just-reaped workspace's leftovers are collected the same
    // pass.
    ...runtime.maintenance,
    // Delete module dirs left by workspaces whose runtime is gone (crashes,
    // reboots; see gcOrphanEphemeralModuleDirs). In-flight creates are
    // registered synchronously before staging, so their dirs are never
    // swept. Resync-only; cheap, and the runtime throttles its node-local
    // half.
    { name: 'orphan-modules-gc', triggers: [], run: () => gcOrphanEphemeralModuleDirs() },
    ...credentialSync,
    // Keep running workspaces' `origin/*` within minutes of origin
    // (docs/server-git.md); nothing else fetches a project with no new
    // creates. Throttled per project and detached.
    { name: 'origin-refresh', triggers: [], run: (ctx) => refreshProjectOrigins(ctx.snapshot()) },
    // Generated titles, after the session sweep so a just-captured prompt
    // is eligible the same pass (hence the same triggers).
    { name: 'generated-titles', triggers: ['workspaces', 'live-agents'],
      run: () => reconcileGeneratedTitles() },
  ]
}
