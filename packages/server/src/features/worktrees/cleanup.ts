import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  k8sNamespace,
  kubectlWithRetry,
  listWorktreeJobs,
  listWorktreePods,
} from '#platform/k8s'
import { inFlightWorktreeIds } from './provisioning'
import { applyWorktreeEvent } from '#features/records'
import {
  clearWorktreeTerminating,
  evictWorktreeStatus,
  forgetLiveness,
  markWorktreeTerminating,
} from '#runtime/status'
import { proxyClient } from '#runtime/k8s/egress'
import { salvageWorktreeImages } from '#runtime/k8s/images'
import {
  buildVclusterCleanupShellCommand,
  getVclusterStatus,
  removeWorktreeVcluster,
  vclusterName,
} from '#runtime/k8s/cluster'
import {
  cachedPackagesDir,
  opencodeDataDir,
  projectsRoots,
  repoDir,
  worktreeStateRoots,
  projectWorktreeStateRoots,
  worktreeDir,
  worktreeMetaDir,
  worktreeMetaPath,
  worktreeSessionStartsPath,
} from '@yaac/shared/project-paths'
import { deleteWorktreeMeta, readWorktreeMeta } from '#store/worktrees'
import { shellQuote } from '#platform/shell'
import type { WorktreeDeathCause } from '@yaac/shared/types'
import { stopWorktreeForwarders } from '#runtime/k8s/forwarders'
import { serverLog } from '#log'

/**
 * Absolute host path to `<cachedPackages>/modules/<worktreeId>` — the
 * per-worktree ephemeral-modules root whose subdirs back the
 * `/workspace/<relPath>` symlinks installed at worktree start. See
 * `installEphemeralModuleLinks` in `packages/server/src/worktree-create.ts`.
 */
export function worktreeModulesDir(projectSlug: string, worktreeId: string): string {
  return path.join(cachedPackagesDir(projectSlug), 'modules', worktreeId)
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
 * The admin dir needs its `locked` file cleared first: worktree setup writes it
 * precisely so `git worktree prune` can never reap a live worktree from
 * outside its own pod (see buildWorktreeLinkExec), and it would otherwise
 * outlive the checkout it protects.
 *
 * Transcripts are deliberately left. The tool homes are shared across a
 * project, so a worktree resumed into a second worktree would lose its history
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
 * Best-effort removal of the worktree's state from the proxy sidecar. If
 * the sidecar isn't running there's nothing to clean up. Errors are
 * swallowed so cleanup never blocks container teardown on a sidecar hiccup.
 */
async function removeWorktreeFromProxy(worktreeId: string): Promise<void> {
  try {
    const attached = await proxyClient.attachIfRunning()
    if (!attached) return
    await proxyClient.removeWorktree(worktreeId)
  } catch (err) {
    console.warn(
      `Failed to remove session ${worktreeId} from proxy: ${(err as Error).message}`,
    )
  }
}

export async function cleanupWorktree(params: {
  jobName: string
  projectSlug: string
  worktreeId: string
  /** Why the worktree died, when a reaper (not the user) is tearing it
   *  down — persisted so the deleted-worktree view can say so. */
  cause?: WorktreeDeathCause
}): Promise<void> {
  const { jobName, projectSlug, worktreeId, cause } = params

  // Mark terminating BEFORE evicting the status below: in the gap before
  // Kubernetes stamps the pod's deletionTimestamp, this is what keeps the
  // display path rendering "terminating…" instead of a stray waiting spell.
  markWorktreeTerminating(worktreeId)

  // Report the stop (and death cause, when a reaper supplied one) so the
  // deleted-worktree view can order by recency and say why the worktree went
  // away (best-effort; falls back to transcript mtime if unrecorded).
  await applyWorktreeEvent({
    type: 'worktree-stopped', projectSlug, worktreeId, cause,
  })

  // Drop any cached tmux-alive entry and the watcher-fed status-store row
  // so a subsequent caller doesn't see a stale value from this worktree (or,
  // in the worst case, a value belonging to a brand-new worktree with the
  // same id).
  forgetLiveness(projectSlug, worktreeId)
  evictWorktreeStatus(projectSlug, worktreeId)

  stopWorktreeForwarders(worktreeId)
  await removeWorktreeFromProxy(worktreeId)

  // Salvage built image layers into the project's registry before the
  // pod (and its graphroot tmpfs) is destroyed. Best-effort, and the
  // in-pod survey self-gates on podman, so non-nested worktrees (and
  // already-dead pods) no-op.
  await salvageWorktreeImages({ jobName, projectSlug, worktreeId })

  // Delete the worktree Job; the pod's terminationGracePeriodSeconds (5s)
  // covers the graceful-stop window, so no separate stop step is needed.
  // --wait so the modules/worktree dirs below aren't yanked out from under
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

  // Tear down the worktree's vcluster, if it had one. One cheap probe
  // gates the label-selector deletes so non-vcluster worktrees pay a
  // single kubectl get. Best-effort: the background vcluster reconcile
  // sweeps anything this misses.
  try {
    if (await getVclusterStatus(worktreeId)) {
      await removeWorktreeVcluster(vclusterName(worktreeId))
    }
  } catch (err) {
    console.warn(`vcluster cleanup for ${worktreeId} failed: ${(err as Error).message}`)
  }

  // Remove the per-worktree ephemeral-modules backing dir from
  // `.cached-packages/modules/<sid>`. No-op if the feature was disabled
  // for this worktree (dir won't exist).
  await fs.rm(worktreeModulesDir(projectSlug, worktreeId), {
    recursive: true,
    force: true,
  })

  // Remove the per-worktree dirs (vcluster kubeconfig, nested-yaac data,
  // staged skills / worktree bin). The pod is gone; the mount sources are
  // garbage now.
  for (const dir of worktreeStateRoots(projectSlug, worktreeId)) {
    await fs.rm(dir, { recursive: true, force: true })
  }

  console.log(`Session ${worktreeId} cleaned up.`)
}

/**
 * Remove the worktree's state from the proxy sidecar (in-process, fast),
 * then spawn a detached background process to do the slow Job teardown
 * so the calling process can exit immediately.
 */
export async function cleanupWorktreeDetached(params: {
  jobName: string
  projectSlug: string
  worktreeId: string
  /** Why the worktree died, when a reaper (not the user) is tearing it
   *  down — persisted so the deleted-worktree view can say so. */
  cause?: WorktreeDeathCause
  /** Skip the deletion write, leaving whatever cause is already
   *  recorded intact. Set when the caller is *resuming* a teardown yaac
   *  already recorded — e.g. the stale reaper re-issuing the delete for a
   *  worktree whose in-memory terminating mark was lost to a server restart
   *  or the TTL. Re-recording there would overwrite the true cause (a plain
   *  user delete, or an earlier reaped death) with a spurious out-of-band
   *  reason. */
  preserveDeletedRecord?: boolean
}): Promise<void> {
  const { jobName, projectSlug, worktreeId, cause, preserveDeletedRecord } = params

  // Audit every teardown: the actual work below runs as a detached,
  // stdio-ignored child, so without this line a worktree reaped by the
  // reconciler vanishes with no trace in the server log.
  serverLog(
    `[server] session teardown: session=${worktreeId} job=${jobName} project=${projectSlug}`
    + (cause ? ` cause=${cause.reason}${cause.detail ? ` (${cause.detail})` : ''}` : ''),
  )

  // Mark terminating BEFORE evicting the status below (see cleanupWorktree).
  markWorktreeTerminating(worktreeId)

  // Report the stop (and death cause, when a reaper supplied one) so the
  // deleted-worktree view can order by recency and say why the worktree went
  // away (best-effort; falls back to transcript mtime if unrecorded). Skipped
  // when resuming a teardown yaac already recorded, so the existing cause
  // survives (see `preserveDeletedRecord`).
  if (!preserveDeletedRecord) {
    await applyWorktreeEvent({
      type: 'worktree-stopped', projectSlug, worktreeId, cause,
    })
  }

  forgetLiveness(projectSlug, worktreeId)
  evictWorktreeStatus(projectSlug, worktreeId)

  stopWorktreeForwarders(worktreeId)
  await removeWorktreeFromProxy(worktreeId)

  const modulesDir = worktreeModulesDir(projectSlug, worktreeId)
  const ephemeralModulesRm = `rm -rf ${shellQuote(modulesDir)} 2>/dev/null || true`

  const worktreeDirRms = worktreeStateRoots(projectSlug, worktreeId).map(
    (dir) => `rm -rf ${shellQuote(dir)} 2>/dev/null || true`,
  )

  const script = [
    `kubectl delete job ${jobName} -n ${k8sNamespace()} --ignore-not-found 2>/dev/null || true`,
    // vcluster teardown: pure label-selector deletes, so non-vcluster
    // worktrees no-op (every line carries --ignore-not-found + `|| true`).
    buildVclusterCleanupShellCommand(vclusterName(worktreeId)),
    ephemeralModulesRm,
    ...worktreeDirRms,
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
  // salvageWorktreeImages) rather than part of the detached script, and
  // bounded by its own timeouts so a wedged salvage can't strand the
  // teardown. If the server dies in this window, the Job survives and the
  // stale reaper resumes the (idempotent) teardown — the same recovery as
  // a lost detached script. Failures are logged inside and never block.
  void salvageWorktreeImages({ jobName, projectSlug, worktreeId })
    .catch(() => false)
    .then(() => { spawnDetachedTeardown() })
}

/**
 * How far before the sweep's own start a write still counts as "in use".
 * The data dir can sit on a mount with second-granularity timestamps (the
 * node-shared mount a nested worktree gets), so an mtime is a lower bound on
 * when the write happened, not the moment. The slack costs a genuine orphan
 * one extra sweep to collect; too little would cost a live worktree its dirs.
 */
const RECENT_WRITE_SLACK_MS = 10_000

/**
 * Is this worktree dir off-limits to the orphan sweep? Either the server is
 * still provisioning that worktree — its Job may not be applied yet, so no
 * cluster listing can vouch for it, and only the provisioning registry
 * knows — or the directory has been written since the sweep took its
 * listing, which is what a create staging into it looks like. Both mean
 * "in use", and the sweep only ever wants genuine leftovers.
 * Unreadable stat is treated as in-use: refusing to delete costs a stale dir
 * the next sweep collects, deleting wrongly costs a live worktree.
 */
async function inUseBySweep(dir: string, sid: string, sweepStartedAtMs: number): Promise<boolean> {
  if (inFlightWorktreeIds().includes(sid)) return true
  try {
    const st = await fs.stat(dir)
    return st.mtimeMs >= sweepStartedAtMs - RECENT_WRITE_SLACK_MS
  } catch {
    return true
  }
}

/**
 * Server-startup sweep: remove `.cached-packages/modules/<sid>`
 * directories whose worktree is no longer alive. Catches leftovers from
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
  liveWorktreeIds: Set<string>,
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
      if (liveWorktreeIds.has(sid)) continue
      if (await readWorktreeMeta(slug, sid) !== undefined) continue
      const log = worktreeSessionStartsPath(slug, sid)
      if (await inUseBySweep(log, sid, sweepStartedAtMs)) continue
      await fs.rm(log, { force: true }).catch(() => { /* next sweep */ })
      continue
    }
    if (!name.endsWith('.json')) continue
    const sid = name.slice(0, -'.json'.length)
    if (liveWorktreeIds.has(sid)) continue
    const meta = await readWorktreeMeta(slug, sid)
    if (meta?.spare !== true) continue
    if (await inUseBySweep(worktreeMetaPath(slug, sid), sid, sweepStartedAtMs)) continue
    await deleteWorktreeState(slug, sid)
    console.log(`Removed orphan prewarmed spare ${slug}/${sid}`)
  }
}

export async function gcOrphanEphemeralModuleDirs(): Promise<void> {
  // Once per server life: this collects what a previous process left
  // behind, so a second pass has nothing new to find.
  if (orphanModulesSwept) return
  orphanModulesSwept = true

  // Everything this sweep deletes belongs to a worktree that no longer
  // exists — and "no longer exists" is read from a cluster listing taken
  // here, seconds before the removals below. A create that stages its dirs
  // inside that gap looks exactly like an orphan: its Job is not applied
  // yet, so it is in no listing, and the sweep deletes the worktree dir and
  // ephemeral-modules dir out from under the pod that is about to mount
  // them. The pod then sits in ContainerCreating on FailedMount until the
  // create gives up. This runs fire-and-forget at server startup, and a
  // `worktree create` right after `server start` is the normal way to hit
  // it. Two guards below: a worktree the process is provisioning is never
  // swept, and neither is a directory touched since this listing was taken.
  const sweepStartedAtMs = Date.now()
  let liveWorktreeIds: Set<string>
  try {
    // Union of pod and Job worktree ids: a Job mid-recreate (pod evicted,
    // replacement not scheduled yet) only shows up in the Job list, and
    // must not have its dirs swept.
    const [pods, jobs] = await Promise.all([listWorktreePods(), listWorktreeJobs()])
    liveWorktreeIds = new Set(
      [...pods.map((p) => p.worktreeId), ...jobs.map((j) => j.worktreeId)]
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
      if (liveWorktreeIds.has(sid)) continue
      const dir = path.join(modulesRoot, sid)
      if (await inUseBySweep(dir, sid, sweepStartedAtMs)) continue
      try {
        await fs.rm(dir, { recursive: true, force: true })
        console.log(`Removed orphan ephemeral modules dir ${dir}`)
      } catch (err) {
        console.warn(`Orphan modules GC: failed to remove ${dir}: ${(err as Error).message}`)
      }
    }

    await gcOrphanSpares(slug, liveWorktreeIds, sweepStartedAtMs)

    // Per-session dirs live under `<slug>/sessions/<sid>` on both roots —
    // shared (vcluster kubeconfig, nested-yaac data, staged skills) and
    // node-local; `projectWorktreeStateRoots` owns that pairing and collapses to one
    // entry today. The `worktrees/` dir is unique to
    // this feature, so a flat readdir gives the worktree id list directly.
    for (const worktreesRoot of projectWorktreeStateRoots(slug)) {
      let worktreeEntries: string[] = []
      try {
        worktreeEntries = await fs.readdir(worktreesRoot)
      } catch { /* missing sessions dir → nothing to sweep there */ }
      for (const sid of worktreeEntries) {
        if (liveWorktreeIds.has(sid)) continue
        const dir = path.join(worktreesRoot, sid)
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
 * Tear a workspace's runtime down and make its id reusable — the whole of
 * what a restart needs before bringing the same workspace back up.
 *
 * Awaited rather than detached: a restart re-creates against this very id, so
 * the old Job has to be gone before the new one is applied. `jobName: null`
 * means nothing was running (a stopped workspace being restarted), and only
 * the marks are cleared — which still has to happen, because a terminating
 * mark left by an earlier teardown would render the fresh worktree as
 * "stopping…".
 */
export async function teardownForRestart(params: {
  jobName: string | null
  projectSlug: string
  workspaceId: string
}): Promise<void> {
  const { jobName, projectSlug, workspaceId } = params
  if (jobName) {
    await cleanupWorktree({ jobName, projectSlug, worktreeId: workspaceId })
  }
  clearWorktreeTerminating(workspaceId)
}
