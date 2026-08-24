import {
  gcOrphanEphemeralModuleDirs,
  reconcileAgentSessions,
  reconcilePrewarmPool,
  reconcileMamaRequests,
  reconcileStaleWorktrees,
} from '#domain/worktrees'
import { reconcileGeneratedTitles } from '#domain/titles'
import { syncToolCredentialsThrottled } from '#domain/auth'
import { worktreeDriver } from '#drivers/driver'
import type { ReconcileStep } from '#drivers/contract'

// The scheduling vocabulary is the contract's, because a runtime declares
// steps in it too (docs/layered-server.md). Re-exported here so the
// reconciler engine and the steps keep importing it from the layer that
// owns the pass.
export type { PassContext, ReconcileStep, ReconcileTrigger } from '#drivers/contract'

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
  const driver = worktreeDriver()
  const runtime = driver.reconcileSteps()
  // What a spare buys is the wait a cold worktree pays — an image pull and
  // a pod boot. A host-process runtime pays neither (a tmux server starts in
  // milliseconds in a checkout that already exists), so a pool there would
  // hold worktrees open to save nothing. The step is dropped rather than
  // made to no-op so a pass over a containerless server has no prewarm
  // vocabulary in it at all.
  // The standing credential convergence, and the only lane that reaches an
  // IDLE install: a worktree that refreshed its OAuth token holds the live
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
  const credentialSync: ReconcileStep[] = driver.kind !== 'containerless' ? [] : [
    { name: 'credential-sync', triggers: [], run: () => syncToolCredentialsThrottled() },
  ]
  const pool: ReconcileStep[] = driver.kind === 'containerless' ? [] : [
    // Keep one prewarmed spare per active project (after the stale sweep so
    // counts reflect just-reaped worktrees). No-op when the pool size is 0.
    { name: 'prewarm-pool', triggers: ['workspaces'],
      run: async (ctx) => reconcilePrewarmPool((await ctx.defaultTool()) ?? 'claude', ctx.snapshot()) },
  ]
  return [
    // The stale reaper — first, so counts reflect just-reaped worktrees by
    // the time the prewarm pool runs. It reads what should exist from
    // db at the top of its pass; the sources here are the ones on
    // which a worktree may have appeared or gone, plus `status-streams`
    // because in-pod tmux death is not a substrate event — losing a
    // driver connection is the edge after which liveness can no longer be
    // inferred and must be probed. Its slower sweeps ride the resync, which
    // costs them nothing: the podless-row sweep waits out 30 minutes, and
    // the placeholder-zombie, orphan-Job and stuck-terminating sweeps wait
    // out the 60s starting grace. Nor can a flapping stream turn this into
    // a reaping loop — the destructive path needs a conclusive in-pod
    // verdict, and a failed or timed-out probe reads `unknown` and keeps
    // the worktree.
    { name: 'stale-worktrees', triggers: ['workspaces', 'units', 'status-streams'],
      run: (ctx) => reconcileStaleWorktrees(ctx.snapshot()) },
    // Service in-worktree `yaac-mama` requests queued at the egress proxy.
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
    // Which agent sessions each worktree holds, which are live, and what
    // each opened with — the in-pod hook's session-starts log folded into
    // rows and read back (or, under `acp`, the handshake), crossed with the
    // watcher's live agent set. The
    // opening message rides along because the sweep has just resolved the
    // transcript it would be read from; title generation runs after this
    // step for that reason. `live-agents` is here and nowhere else: it is
    // the only step that reads the watcher's live set, and it is what turns
    // a fresh ACP handshake into a conversation row within a debounce
    // instead of within a resync.
    { name: 'agent-sessions', triggers: ['workspaces', 'live-agents'],
      run: (ctx) => reconcileAgentSessions(ctx.snapshot()) },
    // The runtime's upkeep — substrate GCs and datapath heals. After the
    // sweeps above, so a just-reaped worktree's leavings are collectable in
    // the same pass.
    //
    // This runs later than it used to: the image sweeps and the registry
    // GC sat between the pool and the conversation sweep. They belong here
    // because they are substrate upkeep and that is what the group is, and
    // nothing couples them to the sweep — they throttle internally and
    // detach their work, and the sweep reads transcripts and rows rather
    // than images.
    ...runtime.maintenance,
    // Per-worktree `.cached-packages/modules/<id>` dirs whose runtime is
    // gone — leftovers from crashes and host reboots. A startup sweep that
    // must not delete a dir a create is staging into: which worktrees are
    // mid-create comes straight from the provisioning registry, which is
    // same-process and populated synchronously before a create stages
    // anything, so the sweep can never see a fresher directory than the
    // registry entry that shields it. Self-gating: once per server life.
    { name: 'orphan-modules-gc', triggers: [], run: () => gcOrphanEphemeralModuleDirs() },
    ...credentialSync,
    // Model-generated titles for untitled worktrees, after the
    // conversation sweep so a freshly captured prompt is eligible the same
    // pass — which means it owes a pass on whatever dirties that sweep.
    // Cheap when there is nothing to do.
    { name: 'generated-titles', triggers: ['workspaces', 'live-agents'],
      run: () => reconcileGeneratedTitles() },
  ]
}
