import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  k8sNamespace,
  kubectlWithRetry,
  listSessionJobs,
  listSessionPods,
} from '#platform/k8s'
import { desiredWorkspaces } from '#herd-desired'
import { serverLink } from '#server-link'
import {
  clearSessionTerminating,
  evictSessionStatus,
  forgetLiveness,
  markSessionTerminating,
} from '#features/status'
import { proxyClient } from '#features/egress'
import { salvageSessionImages } from '#features/images'
import {
  buildVclusterCleanupShellCommand,
  getVclusterStatus,
  removeSessionVcluster,
  vclusterName,
} from '#features/cluster'
import {
  cachedPackagesDir,
  claudeDir,
  codexDir,
  opencodeDataDir,
  piDir,
  projectsRoots,
  repoDir,
  sessionRoots,
  sessionsRoots,
  worktreeDir,
  worktreeMetaDir,
  worktreeMetaPath,
  worktreeSessionStartsPath,
} from '@yaac/shared/project-paths'
import { deleteWorktreeMeta, readWorktreeMeta } from './worktree-meta'
import { shellQuote } from '#platform/shell'
import type { SessionDeathCause } from '@yaac/shared/types'
import { stopSessionForwarders } from '#features/forwarders'
import { serverLog } from '#log'

/**
 * Absolute host path to `<cachedPackages>/modules/<sessionId>` — the
 * per-session ephemeral-modules root whose subdirs back the
 * `/workspace/<relPath>` symlinks installed at session start. See
 * `installEphemeralModuleLinks` in `packages/server/src/session-create.ts`.
 */
export function sessionModulesDir(projectSlug: string, sessionId: string): string {
  return path.join(cachedPackagesDir(projectSlug), 'modules', sessionId)
}

/**
 * Remove everything on disk that belongs to one worktree, in one call.
 *
 * The counterpart to a create: the checkout, git's admin dir for it, the
 * herd's metadata document and the in-pod hook's log beside it, and the
 * per-worktree opencode database. Every one of them is keyed by the worktree
 * id, which is what makes this a single function rather than a list each
 * caller has to remember — and `opencode-data` is here because until now
 * nothing removed it at all.
 *
 * NOT called by an ordinary stop. A stopped worktree is a checkout still on
 * disk, diff and all, waiting to be restarted; this is for the cases where the
 * worktree itself goes away — an unclaimed spare being reaped, and a project
 * being removed.
 *
 * The admin dir needs its `locked` file cleared first: session setup writes it
 * precisely so `git worktree prune` can never reap a live worktree from
 * outside its own pod (see buildWorktreeLinkExec), and it would otherwise
 * outlive the checkout it protects.
 *
 * Transcripts are deliberately left. The tool homes are shared across a
 * project, so a session resumed into a second worktree would lose its history
 * to the first one's deletion — and the document that names them is going
 * away, so nothing would be able to find them to finish the job later either.
 */
export async function deleteWorktreeState(
  projectSlug: string,
  worktreeId: string,
): Promise<void> {
  const adminDir = path.join(repoDir(projectSlug), '.git', 'worktrees', worktreeId)
  await Promise.all([
    fs.rm(worktreeDir(projectSlug, worktreeId), { recursive: true, force: true }),
    fs.rm(path.join(adminDir, 'locked'), { force: true })
      .then(() => fs.rm(adminDir, { recursive: true, force: true })),
    fs.rm(opencodeDataDir(projectSlug, worktreeId), { recursive: true, force: true }),
    deleteWorktreeMeta(projectSlug, worktreeId),
  ].map((p) => p.catch((err: unknown) => {
    // Best-effort per path: a worktree that half-goes-away is better than a
    // reap that aborts and leaves the rest behind for nobody to collect.
    serverLog(`[server] delete worktree state ${projectSlug}/${worktreeId}: ${String(err)}`)
  })))
}

/**
 * Best-effort removal of the session's state from the proxy sidecar. If
 * the sidecar isn't running there's nothing to clean up. Errors are
 * swallowed so cleanup never blocks container teardown on a sidecar hiccup.
 */
async function removeSessionFromProxy(sessionId: string): Promise<void> {
  try {
    const attached = await proxyClient.attachIfRunning()
    if (!attached) return
    await proxyClient.removeSession(sessionId)
  } catch (err) {
    console.warn(
      `Failed to remove session ${sessionId} from proxy: ${(err as Error).message}`,
    )
  }
}

export async function cleanupSession(params: {
  jobName: string
  projectSlug: string
  sessionId: string
  /** Why the session died, when a reaper (not the user) is tearing it
   *  down — persisted so the deleted-session view can say so. */
  cause?: SessionDeathCause
}): Promise<void> {
  const { jobName, projectSlug, sessionId, cause } = params

  // Mark terminating BEFORE evicting the status below: in the gap before
  // Kubernetes stamps the pod's deletionTimestamp, this is what keeps the
  // display path rendering "terminating…" instead of a stray waiting spell.
  markSessionTerminating(sessionId)

  // Report the stop (and death cause, when a reaper supplied one) so the
  // deleted-session view can order by recency and say why the session went
  // away (best-effort; falls back to transcript mtime if unrecorded).
  await serverLink().workspaceEvent({
    type: 'worktree-stopped', projectSlug, worktreeId: sessionId, cause,
  })

  // Drop any cached tmux-alive entry and the watcher-fed status-store row
  // so a subsequent caller doesn't see a stale value from this session (or,
  // in the worst case, a value belonging to a brand-new session with the
  // same id).
  forgetLiveness(projectSlug, sessionId)
  evictSessionStatus(projectSlug, sessionId)

  stopSessionForwarders(sessionId)
  await removeSessionFromProxy(sessionId)

  // Salvage built image layers into the project's registry before the
  // pod (and its graphroot tmpfs) is destroyed. Best-effort, and the
  // in-pod survey self-gates on podman, so non-nested sessions (and
  // already-dead pods) no-op.
  await salvageSessionImages({ jobName, projectSlug, sessionId })

  // Delete the session Job; the pod's terminationGracePeriodSeconds (5s)
  // covers the graceful-stop window, so no separate stop step is needed.
  // --wait so the modules/session dirs below aren't yanked out from under
  // a still-terminating pod.
  try {
    await kubectlWithRetry([
      'delete', 'job', jobName, '-n', k8sNamespace(),
      '--ignore-not-found', '--wait=true', '--timeout=30s',
    ])
  } catch {
    // Job may already be gone, or deletion timed out — best-effort; the
    // background reconcile loop sweeps any leftover Job.
  }

  // Tear down the session's vcluster, if it had one. One cheap probe
  // gates the label-selector deletes so non-vcluster sessions pay a
  // single kubectl get. Best-effort: the background vcluster reconcile
  // sweeps anything this misses.
  try {
    if (await getVclusterStatus(sessionId)) {
      await removeSessionVcluster(vclusterName(sessionId))
    }
  } catch (err) {
    console.warn(`vcluster cleanup for ${sessionId} failed: ${(err as Error).message}`)
  }

  // Remove the per-session ephemeral-modules backing dir from
  // `.cached-packages/modules/<sid>`. No-op if the feature was disabled
  // for this session (dir won't exist).
  await fs.rm(sessionModulesDir(projectSlug, sessionId), {
    recursive: true,
    force: true,
  })

  // Remove the per-session dirs (vcluster kubeconfig, nested-yaac data,
  // staged skills / session bin). The pod is gone; the mount sources are
  // garbage now.
  for (const dir of sessionRoots(projectSlug, sessionId)) {
    await fs.rm(dir, { recursive: true, force: true })
  }

  console.log(`Session ${sessionId} cleaned up.`)
}

/**
 * Remove the session's state from the proxy sidecar (in-process, fast),
 * then spawn a detached background process to do the slow Job teardown
 * so the calling process can exit immediately.
 */
export async function cleanupSessionDetached(params: {
  jobName: string
  projectSlug: string
  sessionId: string
  /** Why the session died, when a reaper (not the user) is tearing it
   *  down — persisted so the deleted-session view can say so. */
  cause?: SessionDeathCause
  /** Skip the deletion write, leaving whatever cause is already
   *  recorded intact. Set when the caller is *resuming* a teardown yaac
   *  already recorded — e.g. the stale reaper re-issuing the delete for a
   *  session whose in-memory terminating mark was lost to a server restart
   *  or the TTL. Re-recording there would overwrite the true cause (a plain
   *  user delete, or an earlier reaped death) with a spurious out-of-band
   *  reason. */
  preserveDeletedRecord?: boolean
}): Promise<void> {
  const { jobName, projectSlug, sessionId, cause, preserveDeletedRecord } = params

  // Audit every teardown: the actual work below runs as a detached,
  // stdio-ignored child, so without this line a session reaped by the
  // reconciler vanishes with no trace in the server log.
  serverLog(
    `[server] session teardown: session=${sessionId} job=${jobName} project=${projectSlug}`
    + (cause ? ` cause=${cause.reason}${cause.detail ? ` (${cause.detail})` : ''}` : ''),
  )

  // Mark terminating BEFORE evicting the status below (see cleanupSession).
  markSessionTerminating(sessionId)

  // Report the stop (and death cause, when a reaper supplied one) so the
  // deleted-session view can order by recency and say why the session went
  // away (best-effort; falls back to transcript mtime if unrecorded). Skipped
  // when resuming a teardown yaac already recorded, so the existing cause
  // survives (see `preserveDeletedRecord`).
  if (!preserveDeletedRecord) {
    await serverLink().workspaceEvent({
      type: 'worktree-stopped', projectSlug, worktreeId: sessionId, cause,
    })
  }

  forgetLiveness(projectSlug, sessionId)
  evictSessionStatus(projectSlug, sessionId)

  stopSessionForwarders(sessionId)
  await removeSessionFromProxy(sessionId)

  const modulesDir = sessionModulesDir(projectSlug, sessionId)
  const ephemeralModulesRm = `rm -rf ${shellQuote(modulesDir)} 2>/dev/null || true`

  const sessionDirRms = sessionRoots(projectSlug, sessionId).map(
    (dir) => `rm -rf ${shellQuote(dir)} 2>/dev/null || true`,
  )

  const script = [
    `kubectl delete job ${jobName} -n ${k8sNamespace()} --ignore-not-found 2>/dev/null || true`,
    // vcluster teardown: pure label-selector deletes, so non-vcluster
    // sessions no-op (every line carries --ignore-not-found + `|| true`).
    buildVclusterCleanupShellCommand(vclusterName(sessionId)),
    ephemeralModulesRm,
    ...sessionDirRms,
  ].join('; ')

  const spawnDetachedTeardown = (): void => {
    const child = spawn('sh', ['-c', script], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
  }

  // Salvage first: it execs into the pod, which the Job delete destroys.
  // Server-orchestrated (survey exec → node-side writer load — see
  // salvageSessionImages) rather than part of the detached script, and
  // bounded by its own timeouts so a wedged salvage can't strand the
  // teardown. If the server dies in this window, the Job survives and the
  // stale reaper resumes the (idempotent) teardown — the same recovery as
  // a lost detached script. Failures are logged inside and never block.
  void salvageSessionImages({ jobName, projectSlug, sessionId })
    .catch(() => false)
    .then(() => { spawnDetachedTeardown() })
}

/**
 * How far before the sweep's own start a write still counts as "in use".
 * The data dir can sit on a mount with second-granularity timestamps (the
 * node-shared mount a nested session gets), so an mtime is a lower bound on
 * when the write happened, not the moment. The slack costs a genuine orphan
 * one extra sweep to collect; too little would cost a live session its dirs.
 */
const RECENT_WRITE_SLACK_MS = 10_000

/**
 * Is this session dir off-limits to the orphan sweep? Either the server is
 * still provisioning that session — its Job may not be applied yet, so no
 * cluster listing can vouch for it, and the in-flight set is delivered with
 * the desired set rather than read out of the server's registry — or the
 * directory has been written since
 * the sweep took its listing, which is what a create staging into it looks
 * like. Both mean "in use", and the sweep only ever wants genuine leftovers.
 * Unreadable stat is treated as in-use: refusing to delete costs a stale dir
 * the next sweep collects, deleting wrongly costs a live session.
 */
async function inUseBySweep(dir: string, sid: string, sweepStartedAtMs: number): Promise<boolean> {
  if (desiredWorkspaces()?.provisioning.includes(sid) === true) return true
  try {
    const st = await fs.stat(dir)
    return st.mtimeMs >= sweepStartedAtMs - RECENT_WRITE_SLACK_MS
  } catch {
    return true
  }
}

/**
 * Server-startup sweep: remove `.cached-packages/modules/<sid>`
 * directories whose session is no longer alive. Catches leftovers from
 * crashes, killed servers, and host reboots.
 */
let orphanModulesSwept = false

/** Test helper: let the once-per-herd-life sweep run again. */
export function _resetOrphanModulesSweepForTests(): void {
  orphanModulesSwept = false
}

/**
 * Collect the worktree state of prewarmed spares whose pod is gone.
 *
 * The reap path removes both together, but only while it is running: its plan
 * is derived from live pods, so a spare whose pod died out from under it — a
 * crash, a reboot, the server down in that window — leaves a checkout, a git
 * admin dir and a metadata document that nothing else can even see. A spare
 * has no row, which is exactly what makes it invisible to every other sweep.
 *
 * The document's `spare` flag is what makes this answerable after the fact:
 * the pod that carried the label is gone, so the flag is the only surviving
 * record that this checkout was never a worktree. A real worktree is never
 * touched here — its document says `spare: false`, and a stopped one is a
 * checkout the user is expected to restart into.
 */
/** Suffix of the in-pod hook's log, as `worktreeSessionStartsPath` names it. */
const SESSION_STARTS_SUFFIX = '.session-starts.jsonl'

async function gcOrphanSpares(
  slug: string,
  liveSessionIds: Set<string>,
  sweepStartedAtMs: number,
): Promise<void> {
  let entries: string[] = []
  try {
    entries = await fs.readdir(worktreeMetaDir(slug))
  } catch {
    return // no meta dir → nothing to sweep
  }
  for (const name of entries) {
    // A `.tmp-*` file is a rewrite that died between write and rename. It
    // belongs to no worktree and nothing else will ever collect it.
    if (name.includes('.tmp-')) {
      const tmp = path.join(worktreeMetaDir(slug), name)
      if (await inUseBySweep(tmp, '', sweepStartedAtMs)) continue
      await fs.rm(tmp, { force: true }).catch(() => { /* next sweep */ })
      continue
    }
    // A log whose document is gone is a delete that got half way — the pair
    // is removed together, so the survivor answers to nothing and no `.json`
    // entry will ever name it again.
    if (name.endsWith(SESSION_STARTS_SUFFIX)) {
      const sid = name.slice(0, -SESSION_STARTS_SUFFIX.length)
      if (liveSessionIds.has(sid)) continue
      if (await readWorktreeMeta(slug, sid) !== undefined) continue
      const log = worktreeSessionStartsPath(slug, sid)
      if (await inUseBySweep(log, sid, sweepStartedAtMs)) continue
      await fs.rm(log, { force: true }).catch(() => { /* next sweep */ })
      continue
    }
    if (!name.endsWith('.json')) continue
    const sid = name.slice(0, -'.json'.length)
    if (liveSessionIds.has(sid)) continue
    const meta = await readWorktreeMeta(slug, sid)
    if (meta?.spare !== true) continue
    if (await inUseBySweep(worktreeMetaPath(slug, sid), sid, sweepStartedAtMs)) continue
    await deleteWorktreeState(slug, sid)
    console.log(`Removed orphan prewarmed spare ${slug}/${sid}`)
  }
}

export async function gcOrphanEphemeralModuleDirs(): Promise<void> {
  // Once per herd life: this collects what a previous process left behind,
  // so a second pass has nothing new to find.
  if (orphanModulesSwept) return
  // Nothing published means nothing is known to be mid-create, and this
  // sweep deletes directories a create may be staging into — so it stands
  // down entirely rather than guessing, and runs on the next pass instead.
  if (desiredWorkspaces() === undefined) return
  orphanModulesSwept = true

  // Everything this sweep deletes belongs to a session that no longer
  // exists — and "no longer exists" is read from a cluster listing taken
  // here, seconds before the removals below. A create that stages its dirs
  // inside that gap looks exactly like an orphan: its Job is not applied
  // yet, so it is in no listing, and the sweep deletes the session dir and
  // ephemeral-modules dir out from under the pod that is about to mount
  // them. The pod then sits in ContainerCreating on FailedMount until the
  // create gives up. This runs fire-and-forget at server startup, and a
  // `worktree create` right after `server start` is the normal way to hit
  // it. Two guards below: a session the process is provisioning is never
  // swept, and neither is a directory touched since this listing was taken.
  const sweepStartedAtMs = Date.now()
  let liveSessionIds: Set<string>
  try {
    // Union of pod and Job session ids: a Job mid-recreate (pod evicted,
    // replacement not scheduled yet) only shows up in the Job list, and
    // must not have its dirs swept.
    const [pods, jobs] = await Promise.all([listSessionPods(), listSessionJobs()])
    liveSessionIds = new Set(
      [...pods.map((p) => p.sessionId), ...jobs.map((j) => j.sessionId)]
        .filter((id) => !!id),
    )
  } catch (err) {
    console.warn(`Orphan modules GC: failed to list session pods/jobs: ${(err as Error).message}`)
    return
  }

  // Slugs from BOTH roots: a project whose shared half is already gone can
  // still have a node-local tree (pnpm store, opencode data) to sweep, and
  // enumerating only the shared root would never generate its slug.
  const slugLists = await Promise.all(
    projectsRoots().map((root) => fs.readdir(root).catch((): string[] => [])),
  )
  const projectSlugs = [...new Set(slugLists.flat())]
  if (!projectSlugs.length) return

  for (const slug of projectSlugs) {
    const modulesRoot = path.join(cachedPackagesDir(slug), 'modules')
    let entries: string[] = []
    try {
      entries = await fs.readdir(modulesRoot)
    } catch { /* missing modules dir → nothing to sweep there */ }
    for (const sid of entries) {
      if (liveSessionIds.has(sid)) continue
      const dir = path.join(modulesRoot, sid)
      if (await inUseBySweep(dir, sid, sweepStartedAtMs)) continue
      try {
        await fs.rm(dir, { recursive: true, force: true })
        console.log(`Removed orphan ephemeral modules dir ${dir}`)
      } catch (err) {
        console.warn(`Orphan modules GC: failed to remove ${dir}: ${(err as Error).message}`)
      }
    }

    await gcOrphanSpares(slug, liveSessionIds, sweepStartedAtMs)

    // Per-session dirs live under `<slug>/sessions/<sid>` on both roots —
    // shared (vcluster kubeconfig, nested-yaac data, staged skills) and
    // node-local; `sessionsRoots` owns that pairing and collapses to one
    // entry today. The `sessions/` dir is unique to
    // this feature, so a flat readdir gives the session id list directly.
    for (const sessionsRoot of sessionsRoots(slug)) {
      let sessionEntries: string[] = []
      try {
        sessionEntries = await fs.readdir(sessionsRoot)
      } catch { /* missing sessions dir → nothing to sweep there */ }
      for (const sid of sessionEntries) {
        if (liveSessionIds.has(sid)) continue
        const dir = path.join(sessionsRoot, sid)
        if (await inUseBySweep(dir, sid, sweepStartedAtMs)) continue
        try {
          await fs.rm(dir, { recursive: true, force: true })
          console.log(`Removed orphan session dir ${dir}`)
        } catch (err) {
          console.warn(`Orphan session GC: failed to remove ${dir}: ${(err as Error).message}`)
        }
      }
    }
  }
}

/**
 * The record tree the metadata document replaced:
 * `<toolHome>/.yaac-links/<worktreeId>/{sessions,panes}/`, one under each
 * host-mounted tool home, maintained by the in-pod SessionStart hook. See
 * `worktree-meta.ts` and docs/worktree-storage.md.
 *
 * Every worktree that ran before the document has one on disk and nothing
 * reads it: the herd's record is now the document, folded from the hook's
 * session-starts log, and the sessions themselves are rows the server already
 * holds. So this is a removal, not a reconcile — there is no state to carry
 * across first, and nothing that a mistaken delete could cost.
 *
 * That is also why it is its own step rather than part of the orphan sweep
 * below: it needs neither the cluster listing nor the in-flight set, and
 * folding it in would strand it whenever the cluster is unreachable.
 *
 * It cannot be exactly-once, and does not try to be. A pod launched from a
 * pre-upgrade image keeps writing its tree until it restarts, so one may
 * reappear after this runs; the hook `mkdir -p`s and exits 0 whatever it
 * finds, so deleting underneath it is safe, and the next server start
 * collects whatever it wrote.
 */
const LEGACY_LINKS_DIR = '.yaac-links'

let legacyLinkTreesSwept = false

/** Test helper: let the once-per-herd-life sweep run again. */
export function _resetLegacyLinkTreeSweepForTests(): void {
  legacyLinkTreesSwept = false
}

export async function gcLegacyAgentLinkTrees(): Promise<void> {
  // Once per herd life: this collects what an older yaac left behind, so a
  // second pass in the same process has nothing new to find.
  if (legacyLinkTreesSwept) return
  legacyLinkTreesSwept = true

  // Both roots, as the orphan sweep does: a project whose shared half is gone
  // can still have a node-local tree, and enumerating one root would never
  // generate its slug.
  const slugLists = await Promise.all(
    projectsRoots().map((root) => fs.readdir(root).catch((): string[] => [])),
  )
  for (const slug of new Set(slugLists.flat())) {
    // The three homes the hook ever wrote into. opencode has no host
    // transcript and never ran the hook, so it never had a tree.
    for (const home of [claudeDir(slug), codexDir(slug), piDir(slug)]) {
      const dir = path.join(home, LEGACY_LINKS_DIR)
      // Probe first: `rm -rf` on a path that was never there is silent, and
      // without this every install would report a removal for every project
      // it has, forever.
      if (await fs.stat(dir).catch(() => null) === null) continue
      try {
        await fs.rm(dir, { recursive: true, force: true })
        console.log(`Removed legacy agent link tree ${dir}`)
      } catch (err) {
        console.warn(`Legacy link tree GC: failed to remove ${dir}: ${(err as Error).message}`)
      }
    }
  }
}

/**
 * Tear a workspace's runtime down and make its id reusable — the whole of
 * what a restart needs before bringing the same workspace back up.
 *
 * Awaited rather than detached: a restart re-creates against this very id, so
 * the old Job has to be gone before the new one is applied. `jobName: null`
 * means nothing was running (a stopped workspace being restarted), and only
 * the marks are cleared — which still has to happen, because a terminating
 * mark left by an earlier teardown would render the fresh session as
 * "stopping…".
 */
export async function teardownForRestart(params: {
  jobName: string | null
  projectSlug: string
  workspaceId: string
}): Promise<void> {
  const { jobName, projectSlug, workspaceId } = params
  if (jobName) {
    await cleanupSession({ jobName, projectSlug, sessionId: workspaceId })
  }
  clearSessionTerminating(workspaceId)
}
