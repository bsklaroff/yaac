import {
  gcOrphanEphemeralModuleDirs,
  reconcileAgentSessions,
  reconcilePrewarmPool,
  reconcileMamaRequests,
  reconcileQueuedWorkspaces,
  reconcileStaleWorkspaces,
} from '#domain/workspaces'
import { reconcileGeneratedTitles } from '#domain/titles'
import { refreshProjectOrigins } from '#domain/projects'
import { adoptRefreshedToolCredentials, syncToolCredentialsThrottled } from '#domain/auth'
import { workspaceDriver } from '#drivers/driver'
import type { ReconcileStep } from '#drivers/contract'

/**
 * One flat list, in the order a pass runs it.
 *
 * The mediators' own steps, with the runtime's upkeep spliced in at the two
 * points where the ordering is genuinely theirs to state: its pre-pool group
 * ahead of the spare pool, and its maintenance group after the sweeps that
 * read rows. What those steps sweep, and how they are ordered among
 * themselves, is the runtime's business and is not named here.
 *
 * Titles are generated after the conversation sweep so a just-captured
 * opening message is eligible in the same pass; the reaper needs no ordering
 * against a publish, because it reads the desired set itself at the top of
 * its own step.
 */
export function defaultReconcileSteps(): ReconcileStep[] {
  const driver = workspaceDriver()
  const runtime = driver.reconcileSteps()
  // What a spare buys is the wait a cold workspace pays — an image pull and
  // a pod boot. A host-process runtime pays neither (a tmux server starts in
  // milliseconds in a checkout that already exists), so a pool there would
  // hold workspaces open to save nothing. The step is dropped rather than
  // made to no-op so a pass over a containerless server has no prewarm
  // vocabulary in it at all.
  // The standing credential convergence, and the only lane that reaches an
  // IDLE install: a workspace that refreshed its OAuth token holds the live
  // credential, and every other reader of it — the next create, the plan-usage
  // poller, the next server — is looking at the host store. The other triggers
  // (create, attach, stop, a usage cycle) each cover a moment; this covers the
  // hours between them, on the resync tick since nothing edges it.
  //
  // Dropped entirely where a proxy mediates egress, rather than left to no-op:
  // there the credential a workspace holds is a sentinel and every refresh it
  // drives is already captured to the host store on the way out, so there is
  // nothing to converge and a pass over such a server has no credential
  // vocabulary in it at all.
  //
  // Its mirror under a mediating runtime: the refresh a workspace drives
  // transits the proxy, which captures the rotation into an object the
  // runtime watches, and this is how it reaches the host store. Edge-driven
  // by that object's delta; on the resync it reads a cache. Dropped where
  // nothing mediates, for the same reason the sweep is dropped here.
  const credentialSync: ReconcileStep[] = driver.kind !== 'containerless'
    ? [{ name: 'credential-adopt', triggers: ['proxy-refreshed'],
      run: () => adoptRefreshedToolCredentials(driver.refreshedCredentials()) }]
    : [{ name: 'credential-sync', triggers: [], run: () => syncToolCredentialsThrottled() }]
  const pool: ReconcileStep[] = driver.kind === 'containerless' ? [] : [
    // Keep one prewarmed spare per active project (after the stale sweep so
    // counts reflect just-reaped workspaces). No-op when the pool size is 0.
    { name: 'prewarm-pool', triggers: ['workspaces'],
      run: (ctx) => reconcilePrewarmPool(ctx.snapshot()) },
  ]
  return [
    // The stale reaper — first, so counts reflect just-reaped workspaces by
    // the time the prewarm pool runs. It reads what should exist from
    // db at the top of its pass; the sources here are the ones on
    // which a workspace may have appeared or gone, plus `status-streams`
    // because in-pod tmux death is not a substrate event — losing a
    // driver connection is the edge after which liveness can no longer be
    // inferred and must be probed. Its slower sweeps ride the resync, which
    // costs them nothing: the podless-row sweep waits out 30 minutes, and
    // the placeholder-zombie, orphan-Job and stuck-terminating sweeps wait
    // out the 60s starting grace. Nor can a flapping stream turn this into
    // a reaping loop — the destructive path needs a conclusive in-pod
    // verdict, and a failed or timed-out probe reads `unknown` and keeps
    // the workspace.
    { name: 'stale-workspaces', triggers: ['workspaces', 'units', 'status-streams'],
      run: (ctx) => reconcileStaleWorkspaces(ctx.snapshot()) },
    // The crash backstop for queued workspaces: a launch a server restart
    // interrupted, or a release it lost before launching. `stopWorkspace`
    // launches directly, so this has no triggers of its own — the resync
    // (and the first pass after start, which is one) is enough.
    { name: 'queued-workspaces', triggers: [], run: () => reconcileQueuedWorkspaces() },
    // Service in-workspace `yaac-mama` requests queued at the egress proxy.
    // The drain resolves who called from pod labels; what a request MEANS
    // (which commands exist, and what each may do) is `runMamaCommand`'s.
    // The proxy holds the caller's HTTP response open until we answer, so
    // it reports the enqueue over its event stream rather than making the
    // caller wait out a poll.
    { name: 'mama-requests', triggers: ['mama-requests'],
      run: (ctx) => reconcileMamaRequests({}, ctx.snapshot()) },
    // The runtime's own work that has to precede the pool: a spare's create
    // should join image builds already running, and anything holding
    // capacity should be out of the way before those builds are launched.
    ...runtime.prePool,
    ...pool,
    // Which agent sessions each workspace holds, which are live, and what
    // each opened with — the conversations the watcher's live agent set
    // names, each pane's or acpd socket's own. The opening message rides
    // along because the pass has just resolved the transcript it would be
    // read from; title generation runs after this step for that reason.
    // `live-agents` is here and nowhere else: it is the only step that reads
    // the watcher's live set, and it is what turns a new conversation — a
    // pane naming one, an ACP handshake — into a row within a debounce
    // instead of within a resync.
    { name: 'agent-sessions', triggers: ['workspaces', 'live-agents'],
      run: (ctx) => reconcileAgentSessions(ctx.snapshot()) },
    // The runtime's upkeep — substrate GCs and datapath heals. After the
    // sweeps above, so a just-reaped workspace's leavings are collectable in
    // the same pass.
    //
    // This runs later than it used to: the image sweeps and the registry
    // GC sat between the pool and the conversation sweep. They belong here
    // because they are substrate upkeep and that is what the group is, and
    // nothing couples them to the sweep — they throttle internally and
    // detach their work, and the sweep reads transcripts and rows rather
    // than images.
    ...runtime.maintenance,
    // What workspaces whose runtime is gone left behind — leftovers from
    // crashes and host reboots (see gcOrphanEphemeralModuleDirs). A sweep that
    // must not delete a dir a create is staging into: which workspaces are
    // mid-create comes straight from the provisioning registry, which is
    // same-process and populated synchronously before a create stages
    // anything, so the sweep can never see a fresher directory than the
    // registry entry that shields it. Runs every pass (triggers: [] means
    // resync only): the global walk is a readdir and one id read per
    // project, and the runtime throttles its node-local half.
    { name: 'orphan-modules-gc', triggers: [], run: () => gcOrphanEphemeralModuleDirs() },
    ...credentialSync,
    // Keep every running workspace's `origin/*` within minutes of origin
    // (docs/server-git.md): a workspace's clone moves only when the server
    // fetches, and nothing else fetches a project nobody creates in.
    // Throttled per project, and detached from the pass.
    { name: 'origin-refresh', triggers: [], run: (ctx) => refreshProjectOrigins(ctx.snapshot()) },
    // Model-generated titles for untitled workspaces, after the
    // conversation sweep so a freshly captured prompt is eligible the same
    // pass — which means it owes a pass on whatever dirties that sweep.
    // Cheap when there is nothing to do.
    { name: 'generated-titles', triggers: ['workspaces', 'live-agents'],
      run: () => reconcileGeneratedTitles() },
  ]
}
