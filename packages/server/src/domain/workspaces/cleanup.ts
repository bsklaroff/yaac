import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { workspaceDriver } from '#drivers/driver'
import { resolveEphemeralModulesPaths, resolveProjectConfig } from '#domain/projects'
import { forgetWorkspaceChanges } from './changes'
import { removeAgentHistory } from './history'
import { deletionHeld, inFlightWorkspaceIds } from './provisioning'
import { workspaceBinDir } from './workspace-bin'
import { applyWorkspaceEvent, getProjectRow, listProjectRows, listUncleanedStoppedWorkspaces } from '#db'
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
import { isEntryName, openRoot } from '#lib/confined-fs'
import { shellQuote } from '#lib/shell'
import type { WorkspaceDeathCause } from '@yaac/shared/types'
import type { RuntimeSnapshot, TeardownTarget } from '#drivers/contract'
import { serverLog } from '#lib/log'
import { ServerError } from '@yaac/shared/errors'
import { waitFor } from '@yaac/shared/wait-for'

/**
 * Record the stop. A teardown carries on if the write fails: a lost stop
 * stamp degrades a listing, while a skipped teardown leaks a runtime.
 */
async function recordStop(
  projectId: string,
  workspaceId: string,
  cause: WorkspaceDeathCause | undefined,
): Promise<void> {
  await applyWorkspaceEvent({ type: 'workspace-stopped', projectId, workspaceId, cause })
    .catch((err: unknown) => serverLog(`[server] record stop ${projectId}/${workspaceId}: ${String(err)}`))
}

/**
 * Detached teardown scripts still running, by workspace id. A restart waits
 * on these before relaunching into the same checkout: under containerless
 * the runtime forgets the workspace as soon as the stop returns, while the
 * script is still removing tmux and `node_modules`.
 */
const detachedTeardowns = new Map<string, Promise<void>>()

/**
 * Register work on a workspace's files that a restart must wait for and a
 * delete must not run beside. Call the result once the work is done.
 */
function holdTeardown(workspaceId: string): () => void {
  let settle: () => void = () => undefined
  const settled = new Promise<void>((resolve) => { settle = resolve })
  detachedTeardowns.set(workspaceId, settled)
  void settled.then(() => {
    if (detachedTeardowns.get(workspaceId) === settled) detachedTeardowns.delete(workspaceId)
  })
  return settle
}

/** Resolves once no detached teardown is running for the workspace. */
function detachedTeardownSettled(workspaceId: string): Promise<void> {
  return detachedTeardowns.get(workspaceId) ?? Promise.resolve()
}

/** Whether a detached teardown is still running for the workspace. */
export function tearingDown(workspaceId: string): boolean {
  return detachedTeardowns.has(workspaceId)
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
  projectId: string,
  workspaceId: string,
): Promise<Array<{ abs: string; remove: () => Promise<void> }>> {
  const checkout = await openRoot(workspaceDir(projectId, workspaceId), 'inside').catch(() => null)
  if (checkout === null) return []
  const config = await resolveProjectConfig(projectId).catch(() => null)
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

/** How long one removal of a checkout's ignored files may run: unlinking
 *  a large build tree on NFS takes minutes. */
const IGNORED_CLEAN_TIMEOUT_MS = 5 * 60_000

/** How long the fallback waits to try a checkout again after failing on it. */
const IGNORED_CLEAN_RETRY_MS = 60 * 60_000

/** The script that removes a checkout's ignored files. Run by its text, so
 *  a workspace launched before an upgrade runs the current one. */
async function cleanIgnoredScript(): Promise<string> {
  return await fs.readFile(path.join(workspaceBinDir(), 'yaac-clean-ignored'), 'utf8')
}

/**
 * Remove a stopping workspace's gitignored files from inside it, and stamp
 * its row once that succeeds (docs/workspace-storage.md "Ignored files at
 * stop"). Never rejects: a clean that fails or cannot run is left to
 * `reconcileIgnoredFileCleans`.
 */
async function removeIgnoredFiles(target: TeardownTarget): Promise<void> {
  const { projectId, workspaceId, unitName } = target
  const at = new Date()
  try {
    const runtime = workspaceDriver()
    const root = runtime.workspacePaths(unitName).workspaceDir
    const [row, script] = await Promise.all([getProjectRow(projectId), cleanIgnoredScript()])
    const kept = row?.keptIgnoredPaths ?? []
    await runtime.exec(unitName, ['sh', '-c', script, 'sh', root, ...kept].map(shellQuote).join(' '),
      { timeout: IGNORED_CLEAN_TIMEOUT_MS })
    await applyWorkspaceEvent({ type: 'ignored-files-cleaned', projectId, workspaceId, at })
  } catch (err) {
    serverLog(`[server] ignored-file clean ${projectId}/${workspaceId} at stop: ${String(err)}`)
  }
}

/**
 * Remove `names` from `dir`, recursively and following no link. Entries the
 * server's uid may not remove, which a sandboxed workspace's root wrote, go
 * to the driver's `removeAsRoot` together once the rest are gone. Rejects
 * with the first failure, or with the refusal when the driver cannot help.
 * A name that is not one plain entry (an empty id) is refused.
 */
export async function removeEntries(dir: string, names: string[]): Promise<void> {
  if (!names.every(isEntryName)) throw new Error(`refusing to remove ${JSON.stringify(names)} from ${dir}`)
  const results = await Promise.allSettled(names.map((n) => fs.rm(path.join(dir, n), { recursive: true, force: true })))
  const denied: string[] = []
  let refusal: unknown
  for (const [i, r] of results.entries()) {
    if (r.status === 'fulfilled') continue
    const code = (r.reason as NodeJS.ErrnoException).code
    if (code !== 'EACCES' && code !== 'EPERM') throw r.reason
    denied.push(names[i])
    refusal ??= r.reason
  }
  if (denied.length > 0 && !await workspaceDriver().removeAsRoot(dir, denied)) throw refusal
}

/**
 * Whether the server's uid can remove everything under `dir`: every real
 * directory in it is readable, writable and searchable. A missing `dir`, or
 * one that is not a directory, counts as removable.
 */
async function removableTree(dir: string): Promise<boolean> {
  if (!(await fs.lstat(dir).catch(() => null))?.isDirectory()) return true
  try {
    await fs.access(dir, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK)
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory() && !await removableTree(path.join(dir, e.name))) return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * Remove everything on disk that belongs to one workspace: the checkout, the
 * opencode checkpoint, ACP records and agent history. Node-local working
 * copies are the driver's sweep's.
 *
 * Not used by an ordinary stop, which keeps the checkout for restart. Used
 * when the workspace itself goes away: a user's or the retention's delete
 * (`deleteWorkspace`), a fresh create or warm that gave up, or a reaped
 * spare (`reapSpare`, which also covers a claim that failed after changing
 * its spare).
 *
 * Callers run this only once the pod is gone, so plain recursive `rm` is
 * safe (it does not follow links, and nothing can swap one in mid-walk).
 *
 * The checkout goes first and the rest only once it is gone, since the
 * checkout is what most often fails: a root-owned file a workspace left
 * needs the driver's `removeAsRoot` (`removeEntries`), which may fail.
 * Its `.git` goes last, so that failure leaves the git state and the
 * history, and so a workspace that still restarts on its committed work.
 * A `.git` the server cannot remove all of goes whole to `removeAsRoot`,
 * since Node's walk would first delete what it could and leave it broken.
 * Returns `false` if anything failed. Callers then keep whatever records the
 * leftover bytes: a row, which still lists a stopped workspace, or a spare's
 * unit, which the next reap retries.
 */
export async function deleteWorkspaceState(
  projectId: string,
  workspaceId: string,
): Promise<boolean> {
  // An empty id would resolve to the workspaces root and delete them all.
  if (!workspaceId) {
    serverLog(`[server] delete workspace state ${projectId}: refused an empty workspace id`)
    return false
  }
  const removed = (p: Promise<unknown>): Promise<boolean> => p.then(() => true, (err: unknown) => {
    serverLog(`[server] delete workspace state ${projectId}/${workspaceId}: ${String(err)}`)
    return false
  })
  const checkout = workspaceDir(projectId, workspaceId)
  // Only a real directory is listed: a link is unlinked, never followed.
  const isDir = await fs.lstat(checkout).then((st) => st.isDirectory(), () => false)
  let entries: string[] = []
  try {
    if (isDir) entries = await fs.readdir(checkout)
  } catch (err) {
    return removed(Promise.reject(err))
  }
  if (!await removed(removeEntries(checkout, entries.filter((e) => e !== '.git')))) return false
  if (isDir && !await removableTree(path.join(checkout, '.git'))
    && !await removed(workspaceDriver().removeAsRoot(checkout, ['.git']).then((gone) => {
      if (!gone) throw new Error('its .git holds entries the server cannot remove')
    }))) return false
  if (!await removed(removeEntries(path.dirname(checkout), [path.basename(checkout)]))) return false
  const outcomes = await Promise.all([
    fs.rm(opencodeCheckpointDir(projectId, workspaceId), { recursive: true, force: true }),
    fs.rm(acpLogDir(projectId, workspaceId), { recursive: true, force: true }),
    removeAgentHistory(projectId, workspaceId),
  ].map(removed))
  return outcomes.every(Boolean)
}

/**
 * The workspace bookkeeping both teardowns start with. The terminating mark
 * goes first, so the UI shows "terminating…" until the runtime reports the
 * teardown; cached liveness and status are dropped so nothing stale
 * outlives the stop.
 */
async function beginTeardown(params: {
  jobName: string
  projectId: string
  workspaceId: string
  cause?: WorkspaceDeathCause
}): Promise<TeardownTarget> {
  const { jobName, projectId, workspaceId, cause } = params
  markWorkspaceTerminating(workspaceId)
  await recordStop(projectId, workspaceId, cause)
  forgetLiveness(projectId, workspaceId)
  evictWorkspaceStatus(projectId, workspaceId)
  forgetWorkspaceChanges(jobName)
  return { projectId, workspaceId, unitName: jobName }
}

/**
 * Tear down a running workspace. Resolves `false` if the runtime could not
 * be confirmed gone; a unit still shutting down may write to the checkout,
 * so callers removing it must check.
 *
 * This handles the workspace bookkeeping (terminating mark, stop record,
 * status eviction, per-workspace dirs); `destroy` handles the runtime, and
 * `keepRecord` is its option of that name.
 */
export async function cleanupWorkspace(params: {
  jobName: string
  projectId: string
  workspaceId: string
  keepRecord?: boolean
}): Promise<boolean> {
  const { projectId, workspaceId, keepRecord } = params
  const target = await beginTeardown(params)
  const runtimeGone = await workspaceDriver().destroy(target, keepRecord === true ? { keepRecord } : {})

  // Remove the workspace's mount sources only if the runtime is confirmed
  // gone; otherwise it may still be using them (an unreachable runtime may
  // leave a spare fully alive and claimable). The driver's sweep and the
  // orphan sweep remove them later.
  if (runtimeGone) {
    // Best-effort: a node still unmounting answers EBUSY.
    for (const p of await checkoutEphemeralPaths(projectId, workspaceId)) {
      await p.remove().catch((err: unknown) => {
        serverLog(`[server] remove ${p.abs} at stop: ${String(err)}`)
      })
    }
    await fs.rm(workspaceStateDir(projectId, workspaceId), { recursive: true, force: true })
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
  projectId: string
  workspaceId: string
  /** Why the workspace died, when a reaper is tearing it down. */
  cause?: WorkspaceDeathCause
}): Promise<void> {
  const { jobName, projectId, workspaceId, cause } = params

  // Before the first await, so a restart always waits for it.
  const settle = holdTeardown(workspaceId)
  try {
    // The detached script's output is discarded, so log the teardown here.
    // The cause lands on the row only if no stop is recorded yet.
    serverLog(
      `[server] session teardown: session=${workspaceId} job=${jobName} project=${projectId}`
      + (cause
        ? ` reported cause=${cause.reason}${cause.detail ? ` (${cause.detail})` : ''}`
          + ', kept only if no stop is recorded yet'
        : ''),
    )

    const target = await beginTeardown(params)
    const runtime = workspaceDriver()

    // Forwards and egress registration are in-process state a shell script
    // cannot reach.
    await runtime.deregisterWorkspace(workspaceId)

    const ephemeralModulesRms = (await checkoutEphemeralPaths(projectId, workspaceId))
      .map((p) => `rm -rf ${shellQuote(p.abs)} 2>/dev/null || true`)

    const workspaceDirRm =
      `rm -rf ${shellQuote(workspaceStateDir(projectId, workspaceId))} 2>/dev/null || true`

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

    // The salvage and the ignored-file clean first, since both reach into
    // the workspace the script destroys. Each has its own deadline, and a
    // failure of either never stops the teardown. If the server dies
    // meanwhile, the stale reaper resumes the teardown.
    void Promise.all([runtime.salvageImages(target).catch(() => undefined), removeIgnoredFiles(target)])
      .then(() => { spawnDetachedTeardown() })
  } catch (err) {
    settle()
    throw err
  }
}

/**
 * How long before the listing a write still counts as "in use". The data
 * dir may be on a filesystem with coarse timestamps, so allow slack; too
 * little could delete a live workspace's dirs.
 */
const RECENT_WRITE_SLACK_MS = 10_000

/**
 * Whether the orphan sweep must skip this workspace dir: the workspace is
 * in flight or settled after the listing was read (so it may be missing
 * from it), or the dir was written since. An unreadable stat counts as in
 * use.
 */
async function inUseBySweep(dir: string, sid: string, listedAtMs: number): Promise<boolean> {
  if (inFlightWorkspaceIds(listedAtMs).includes(sid)) return true
  try {
    const st = await fs.stat(dir)
    return st.mtimeMs >= listedAtMs - RECENT_WRITE_SLACK_MS
  } catch {
    return true
  }
}

/**
 * Ids of every workspace the runtime holds, stray units included: one
 * mid-recreate appears only as a stray. Both reads reject rather than
 * resolve empty on failure, which a sweep would read as "nothing is live".
 */
async function liveWorkspaceIds(view: RuntimeSnapshot): Promise<Set<string>> {
  const [workspaces, strays] = await Promise.all([view.workspaces(), view.strayUnits()])
  return new Set(
    [...workspaces.map((w) => w.workspaceId), ...strays.map((s) => s.workspaceId)]
      .filter((id) => !!id),
  )
}

/**
 * The node-local tier of the orphan sweep, handed to the driver's
 * `reapNodeLocal` since those bytes are on whichever node the workspace ran
 * on. Workspaces in flight count as live.
 */
export async function reapOrphanNodeLocal(view: RuntimeSnapshot): Promise<void> {
  const workspaceIds = await liveWorkspaceIds(view)
  const projectIds = new Set((await listProjectRows()).map((r) => r.id))
  for (const id of inFlightWorkspaceIds(view.takenAtMs)) workspaceIds.add(id)
  await workspaceDriver().reapNodeLocal({ projectIds, workspaceIds })
}

/** When each checkout the fallback failed on may be tried again. */
const ignoredCleanRetryAt = new Map<string, number>()

/** Whether a fallback clean is running. They run one at a time. */
let ignoredCleanRunning = false

/**
 * Remove the ignored files of a stopped workspace whose stop did not: its
 * runtime had already died, the clean failed (on a file written through
 * `sudo`, say), or the server went away mid-teardown. One workspace per
 * pass, in the background, run by the driver on the checkout as root
 * (docs/workspace-storage.md "Ignored files at stop").
 *
 * A workspace the runtime still holds, or that is being created,
 * restarted, deleted or torn down, is skipped. The pick and its
 * registration as a teardown run with no await between, so a restart that
 * starts later waits for the clean and a delete is refused until it ends.
 */
export async function reconcileIgnoredFileCleans(view: RuntimeSnapshot): Promise<void> {
  const live = await liveWorkspaceIds(view)
  const stopped = await listUncleanedStoppedWorkspaces()
  if (ignoredCleanRunning) return
  const inFlight = new Set(inFlightWorkspaceIds(view.takenAtMs))
  const due = stopped.find(({ workspaceId: id }) => !live.has(id) && !inFlight.has(id) && !deletionHeld(id)
    && !detachedTeardowns.has(id) && (ignoredCleanRetryAt.get(id) ?? 0) <= Date.now())
  if (due === undefined) return
  const { projectId, workspaceId } = due
  ignoredCleanRunning = true
  const settle = holdTeardown(workspaceId)
  const at = new Date()
  void (async () => {
    // A checkout that is gone holds nothing to clean.
    if (await fs.lstat(workspaceDir(projectId, workspaceId)).then((st) => st.isDirectory(), () => false)) {
      const row = await getProjectRow(projectId)
      await workspaceDriver().runInStoppedCheckout({ projectId, workspaceId }, await cleanIgnoredScript(),
        row?.keptIgnoredPaths ?? [], { timeoutMs: IGNORED_CLEAN_TIMEOUT_MS })
    }
    await applyWorkspaceEvent({ type: 'ignored-files-cleaned', projectId, workspaceId, at })
    ignoredCleanRetryAt.delete(workspaceId)
  })().catch((err: unknown) => {
    ignoredCleanRetryAt.set(workspaceId, Date.now() + IGNORED_CLEAN_RETRY_MS)
    serverLog(`[server] ignored-file clean ${projectId}/${workspaceId}: ${String(err)}`)
  }).finally(() => {
    ignoredCleanRunning = false
    settle()
  })
}

/**
 * Remove the `sessions/<id>` staging dirs that workspaces which no longer
 * exist left behind in the global tier. Runs every resync. A checkout is
 * never removed here: on disk a dead spare's and a stopped workspace's look
 * the same, so spares' are removed by `reapSpare`, from their unit's mark.
 */
export async function gcOrphanEphemeralModuleDirs(view: RuntimeSnapshot): Promise<void> {
  // A create the listing missed looks like an orphan. `inUseBySweep`
  // guards against that.
  const live = await liveWorkspaceIds(view)

  const projectIds = await fs.readdir(getProjectsDir()).catch((): string[] => [])

  for (const projectId of projectIds) {
    // Per-workspace staging dirs (skills, workspace bin), one per id.
    const workspacesRoot = globalProjectPath(projectId, 'sessions')
    let workspaceEntries: string[] = []
    try {
      workspaceEntries = await fs.readdir(workspacesRoot)
    } catch { /* missing sessions dir → nothing to sweep there */ }
    for (const sid of workspaceEntries) {
      if (live.has(sid)) continue
      const dir = path.join(workspacesRoot, sid)
      if (await inUseBySweep(dir, sid, view.takenAtMs)) continue
      try {
        await fs.rm(dir, { recursive: true, force: true })
        console.log(`Removed orphan session dir ${dir}`)
      } catch (err) {
        console.warn(`Orphan session GC: failed to remove ${dir}: ${(err as Error).message}`)
      }
    }
  }
}

/** How long a restart waits for a unit its teardown could not confirm gone:
 *  longer than any grace period a driver gives a unit to stop. */
const RESTART_TEARDOWN_WAIT_MS = 90_000

/**
 * Tear down a workspace's runtime (awaited) so a restart can reuse its id.
 * `jobName: null` means nothing was running; only the terminating mark is
 * cleared, so the new workspace does not show as "stopping…".
 *
 * A unit still going away (a pod's preStop may hold it for its whole grace
 * period) is waited out for up to RESTART_TEARDOWN_WAIT_MS. Past that the
 * restart is refused: a launch against it would fail in a less obvious way.
 * This needs a `findForTeardown` that tracks the live unit, as k8s's does.
 * The containerless driver forgets a workspace when its destroy returns, so
 * there the wait passes at once and a tmux server that outlived the kill is
 * relaunched against.
 */
export async function teardownForRestart(params: {
  jobName: string | null
  projectId: string
  workspaceId: string
}): Promise<void> {
  const { jobName, projectId, workspaceId } = params
  // A detached teardown may still be running even when `jobName` is null.
  await detachedTeardownSettled(workspaceId)
  const gone = !jobName || await cleanupWorkspace({ jobName, projectId, workspaceId })
    || await waitFor(async () => await workspaceDriver().findForTeardown(workspaceId) === undefined,
      { timeoutMs: RESTART_TEARDOWN_WAIT_MS, intervalMs: 1_000 })
  if (!gone) {
    throw new ServerError('CONFLICT', `the previous runtime of ${workspaceId} is still shutting down; `
      + 'try the restart again in a moment')
  }
  clearWorkspaceTerminating(workspaceId)
}
