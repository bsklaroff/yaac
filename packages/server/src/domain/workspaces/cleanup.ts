import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { workspaceDriver } from '#drivers/driver'
import { resolveEphemeralModulesPaths, resolveProjectConfig } from '#domain/projects'
import { removeAgentHistory } from '#domain/agent-history'
import { inFlightWorkspaceIds, listProvisioning } from './provisioning'
import {
  applyWorkspaceEvent,
  deleteSpareWorkspaceRow,
  listProjectRows,
  listProjectWorkspaceIds,
} from '#db'
import {
  clearWorkspaceTerminating,
  evictWorkspaceStatus,
  forgetLiveness,
  markWorkspaceTerminating,
} from '#runtime/status'
import {
  acpLogDir,
  getProjectsDir,
  globalProjectPath,
  opencodeCheckpointDir,
  workspaceDir,
  workspaceStateDir,
} from '@yaac/shared/project-paths'
import { openRoot } from '#lib/confined-fs'
import { shellQuote } from '#lib/shell'
import type { WorkspaceDeathCause } from '@yaac/shared/types'
import type { TeardownTarget } from '#drivers/contract'
import { serverLog } from '#log'

/**
 * Detached teardown scripts still running, by workspace id. A restart waits
 * on these before relaunching into the same checkout: under containerless
 * the runtime forgets the workspace as soon as the stop returns, while the
 * script is still removing tmux and `node_modules`.
 */
const detachedTeardowns = new Map<string, Promise<void>>()

/** Resolves once no detached teardown is running for the workspace. */
function detachedTeardownSettled(workspaceId: string): Promise<void> {
  return detachedTeardowns.get(workspaceId) ?? Promise.resolve()
}

/**
 * The ephemeral-modules paths inside the checkout, to remove at stop. Under
 * containerless they hold the real contents; under a pod they are empty
 * mount points. The restart's init commands rebuild them.
 *
 * Symlinks, and paths reached through a symlink leading out of the
 * checkout, are skipped: the checkout holds agent-written content, and
 * `rm -rf` through a link would delete host files.
 */
async function checkoutEphemeralPaths(
  projectSlug: string,
  workspaceId: string,
): Promise<Array<{ abs: string; remove: () => Promise<void> }>> {
  const checkout = await openRoot(workspaceDir(projectSlug, workspaceId), 'inside').catch(() => null)
  if (checkout === null) return []
  const config = await resolveProjectConfig(projectSlug).catch(() => null)
  const paths: Array<{ abs: string; remove: () => Promise<void> }> = []
  for (const rel of resolveEphemeralModulesPaths(config)) {
    const at = await checkout.parent(rel).catch(() => null)
    if (at === null) continue
    const stat = await fs.lstat(at.dir.child(at.name)).catch(() => null)
    await at.dir.close()
    if (stat === null || stat.isSymbolicLink()) continue
    // `remove` is confined to the checkout. `abs` is for the detached
    // script's `rm -rf`, which runs only after the runtime is gone.
    paths.push({ abs: path.join(checkout.real, rel), remove: () => checkout.removeTree(rel) })
  }
  return paths
}

/**
 * Remove everything on disk that belongs to one workspace: the checkout, the
 * opencode checkpoint, ACP records and agent history. Node-local working
 * copies are the driver's sweep's.
 *
 * Not used by an ordinary stop, which keeps the checkout for restart. Used
 * when the workspace itself goes away: a reaped spare, a fresh create that
 * gave up, a claim that failed after changing its spare.
 *
 * Callers run this only once the pod is gone, so plain recursive `rm` is
 * safe (it does not follow links, and nothing can swap one in mid-walk).
 *
 * Best-effort per path, but returns `false` if anything failed. Callers then
 * keep the row, since it is the only record of the leftover bytes; the stale
 * reaper surfaces it as a stopped workspace the user can delete.
 */
export async function deleteWorkspaceState(
  projectSlug: string,
  workspaceId: string,
): Promise<boolean> {
  // An empty id would resolve to the workspaces root and delete them all.
  if (!workspaceId) {
    serverLog(`[server] delete workspace state ${projectSlug}: refused an empty workspace id`)
    return false
  }
  const outcomes = await Promise.all([
    fs.rm(workspaceDir(projectSlug, workspaceId), { recursive: true, force: true }),
    fs.rm(opencodeCheckpointDir(projectSlug, workspaceId), { recursive: true, force: true }),
    fs.rm(acpLogDir(projectSlug, workspaceId), { recursive: true, force: true }),
    removeAgentHistory(projectSlug, workspaceId),
  ].map((p) => p.then(() => true, (err: unknown) => {
    serverLog(`[server] delete workspace state ${projectSlug}/${workspaceId}: ${String(err)}`)
    return false
  })))
  return outcomes.every(Boolean)
}

/** Repackage a runtime-supplied `jobName` as a `TeardownTarget`. */
function teardownTarget(params: {
  jobName: string
  projectSlug: string
  workspaceId: string
}): TeardownTarget {
  return {
    projectSlug: params.projectSlug,
    workspaceId: params.workspaceId,
    unitName: params.jobName,
  }
}

/**
 * Tear down a running workspace. Resolves `false` if the runtime could not
 * be confirmed gone; a unit still shutting down may write to the checkout,
 * so callers removing it must check.
 *
 * This handles the workspace bookkeeping (terminating mark, stop record,
 * status eviction, per-workspace dirs); `destroy` handles the runtime.
 */
export async function cleanupWorkspace(params: {
  jobName: string
  projectSlug: string
  workspaceId: string
  /** Why the workspace died, when a reaper is tearing it down. Shown in the
   *  deleted-workspace view. */
  cause?: WorkspaceDeathCause
}): Promise<boolean> {
  const { projectSlug, workspaceId, cause } = params

  // Mark before evicting status, so the UI shows "terminating…" until the
  // runtime reports the teardown.
  markWorkspaceTerminating(workspaceId)

  await applyWorkspaceEvent({
    type: 'workspace-stopped', projectSlug, workspaceId, cause,
  })

  // Drop cached liveness and status so nothing stale outlives the stop.
  forgetLiveness(projectSlug, workspaceId)
  evictWorkspaceStatus(projectSlug, workspaceId)

  const runtimeGone = await workspaceDriver().destroy(teardownTarget(params))

  // Remove the workspace's mount sources only if the runtime is confirmed
  // gone; otherwise it may still be using them (an unreachable runtime may
  // leave a spare fully alive and claimable). The driver's sweep and the
  // startup orphan sweep remove them later.
  if (runtimeGone) {
    // Best-effort: a node still unmounting answers EBUSY.
    for (const p of await checkoutEphemeralPaths(projectSlug, workspaceId)) {
      await p.remove().catch((err: unknown) => {
        serverLog(`[server] remove ${p.abs} at stop: ${String(err)}`)
      })
    }
    await fs.rm(workspaceStateDir(projectSlug, workspaceId), { recursive: true, force: true })
  }

  console.log(`Session ${workspaceId} cleaned up.`)
  return runtimeGone
}

/**
 * Deregister the workspace in-process, then spawn a detached script for the
 * slow teardown so the caller returns immediately.
 */
export async function cleanupWorkspaceDetached(params: {
  jobName: string
  projectSlug: string
  workspaceId: string
  /** Why the workspace died, when a reaper is tearing it down. */
  cause?: WorkspaceDeathCause
  /** Skip recording the stop, keeping the recorded cause. Set when resuming
   *  an already-recorded teardown (e.g. the stale reaper after a server
   *  restart), which would otherwise overwrite the real cause. */
  preserveDeletedRecord?: boolean
}): Promise<void> {
  const { jobName, projectSlug, workspaceId, cause, preserveDeletedRecord } = params

  // Register before the first await so a restart always waits for it.
  let settle: () => void = () => undefined
  const settled = new Promise<void>((resolve) => { settle = resolve })
  detachedTeardowns.set(workspaceId, settled)
  void settled.then(() => {
    if (detachedTeardowns.get(workspaceId) === settled) detachedTeardowns.delete(workspaceId)
  })
  try {
    // The detached script's output is discarded, so log the teardown here.
    serverLog(
      `[server] session teardown: session=${workspaceId} job=${jobName} project=${projectSlug}`
      + (cause ? ` cause=${cause.reason}${cause.detail ? ` (${cause.detail})` : ''}` : ''),
    )

    // Before evicting status (see cleanupWorkspace).
    markWorkspaceTerminating(workspaceId)

    if (!preserveDeletedRecord) {
      await applyWorkspaceEvent({
        type: 'workspace-stopped', projectSlug, workspaceId, cause,
      })
    }

    forgetLiveness(projectSlug, workspaceId)
    evictWorkspaceStatus(projectSlug, workspaceId)

    const runtime = workspaceDriver()
    const target = teardownTarget(params)

    // Forwards and egress registration are in-process state a shell script
    // cannot reach.
    await runtime.deregisterWorkspace(workspaceId)

    const ephemeralModulesRms = (await checkoutEphemeralPaths(projectSlug, workspaceId))
      .map((p) => `rm -rf ${shellQuote(p.abs)} 2>/dev/null || true`)

    const workspaceDirRm =
      `rm -rf ${shellQuote(workspaceStateDir(projectSlug, workspaceId))} 2>/dev/null || true`

    // The runtime's teardown, then the workspace's own dirs. Every command is
    // idempotent, so a resumed teardown can re-run it all.
    const script = [
      runtime.detachedTeardownCommand(target),
      ...ephemeralModulesRms,
      workspaceDirRm,
    ].join('; ')

    const spawnDetachedTeardown = (): void => {
      const child = spawn('sh', ['-c', script], {
        detached: true,
        stdio: 'ignore',
      })
      child.once('exit', settle)
      child.once('error', settle)
      child.unref()
    }

    // Salvage first, since it reaches into the workspace the script
    // destroys. It has its own timeouts and never blocks the teardown. If
    // the server dies meanwhile, the stale reaper resumes the teardown.
    void runtime.salvageImages(target)
      .catch(() => undefined)
      .then(() => { spawnDetachedTeardown() })
  } catch (err) {
    settle()
    throw err
  }
}

/**
 * How long before the sweep started a write still counts as "in use". The
 * data dir may be on a filesystem with coarse timestamps, so allow slack;
 * too little could delete a live workspace's dirs.
 */
const RECENT_WRITE_SLACK_MS = 10_000

/**
 * Whether the orphan sweep must skip this workspace dir: the workspace is
 * still provisioning (not yet visible to the runtime), or the dir was
 * written since the sweep's listing. An unreadable stat counts as in use.
 */
async function inUseBySweep(dir: string, sid: string, sweepStartedAtMs: number): Promise<boolean> {
  if (inFlightWorkspaceIds().includes(sid)) return true
  try {
    const st = await fs.stat(dir)
    return st.mtimeMs >= sweepStartedAtMs - RECENT_WRITE_SLACK_MS
  } catch {
    return true
  }
}

/**
 * Remove the state of spares whose pod is gone (crash, reboot). The normal
 * reap only sees live pods, so these would otherwise leak. The row's `spare`
 * flag is the only record that the checkout was never a user's workspace;
 * real workspaces are never touched.
 */
async function gcOrphanSpares(
  slug: string,
  liveWorkspaceIds: Set<string>,
  sweepStartedAtMs: number,
): Promise<void> {
  const rows = await listProjectWorkspaceIds(slug).catch(() => undefined)
  if (rows === undefined) return
  for (const [sid, spare] of rows) {
    if (!spare || liveWorkspaceIds.has(sid)) continue
    if (await inUseBySweep(workspaceDir(slug, sid), sid, sweepStartedAtMs)) continue
    // Keep the row if the delete failed, so the next sweep can retry.
    if (!await deleteWorkspaceState(slug, sid)) continue
    await deleteSpareWorkspaceRow(slug, sid).catch(() => { /* next sweep */ })
    console.log(`Removed orphan prewarmed spare ${slug}/${sid}`)
  }
}

/**
 * Remove what workspaces that no longer exist left behind. The global tier
 * (dead spares' checkouts, `sessions/<id>` dirs) is swept here; the
 * node-local tier goes to the driver's `reapNodeLocal`, since those bytes
 * are on whichever node the workspace ran on. Runs every pass.
 */
export async function gcOrphanEphemeralModuleDirs(): Promise<void> {
  // A create that stages dirs before its unit exists looks like an orphan.
  // `inUseBySweep` guards against that.
  const sweepStartedAtMs = Date.now()
  let liveWorkspaceIds: Set<string>
  try {
    // Include stray units: one mid-recreate appears only as a stray. Both
    // reads reject rather than resolve empty on failure.
    const view = workspaceDriver().snapshot()
    const [workspaces, strays] = await Promise.all([view.workspaces(), view.strayUnits()])
    liveWorkspaceIds = new Set(
      [...workspaces.map((w) => w.workspaceId), ...strays.map((s) => s.workspaceId)]
        .filter((id) => !!id),
    )
  } catch (err) {
    console.warn(`Orphan modules GC: failed to list live sessions: ${(err as Error).message}`)
    return
  }

  // Node-local half. Skipped if projects cannot be read (an empty set would
  // delete every tree). Provisioning workspaces count as live.
  const liveProjectIds = await listProjectRows()
    .then((rows) => new Set(rows.map((r) => r.id)))
    .catch((err: unknown) => {
      console.warn(`Orphan node-local GC: failed to list projects: ${String(err)}`)
      return null
    })
  if (liveProjectIds) {
    const workspaceIds = new Set(liveWorkspaceIds)
    for (const { workspaceId, error } of listProvisioning()) {
      if (error === undefined) workspaceIds.add(workspaceId)
    }
    await workspaceDriver().reapNodeLocal({ projectIds: liveProjectIds, workspaceIds })
      .catch((err: unknown) => {
        console.warn(`Orphan node-local GC failed: ${String(err)}`)
      })
  }

  const projectSlugs = await fs.readdir(getProjectsDir()).catch((): string[] => [])

  for (const slug of projectSlugs) {
    await gcOrphanSpares(slug, liveWorkspaceIds, sweepStartedAtMs)

    // Per-workspace staging dirs (skills, workspace bin), one per id.
    const workspacesRoot = globalProjectPath(slug, 'sessions')
    let workspaceEntries: string[] = []
    try {
      workspaceEntries = await fs.readdir(workspacesRoot)
    } catch { /* missing sessions dir → nothing to sweep there */ }
    for (const sid of workspaceEntries) {
      if (liveWorkspaceIds.has(sid)) continue
      const dir = path.join(workspacesRoot, sid)
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

/**
 * Tear down a workspace's runtime (awaited) so a restart can reuse its id.
 * `jobName: null` means nothing was running; only the terminating mark is
 * cleared, so the new workspace does not show as "stopping…".
 *
 * Ignores `cleanupWorkspace`'s verdict: a restart never removes the
 * checkout, and a launch against a unit still going away is handled by the
 * create's retry loop.
 */
export async function teardownForRestart(params: {
  jobName: string | null
  projectSlug: string
  workspaceId: string
}): Promise<void> {
  const { jobName, projectSlug, workspaceId } = params
  // A detached teardown may still be running even when `jobName` is null.
  await detachedTeardownSettled(workspaceId)
  if (jobName) {
    await cleanupWorkspace({ jobName, projectSlug, workspaceId: workspaceId })
  }
  clearWorkspaceTerminating(workspaceId)
}
