/**
 * The prewarmed-workspace pool: claim logic, the reap, the pure planner, and
 * the in-memory state shared with the reconcile step (`./prewarm-reconcile`).
 *
 * A spare is a fully provisioned workspace with no session, hidden from
 * user-facing views. `workspace create` claims one instead of provisioning,
 * and gets the spare's own id (it cannot be changed), then opens its session
 * in it as in any running workspace. A spare has no workspaces row until it
 * is claimed; only its runtime's `prewarmed` mark says what it is
 * (docs/workspace-storage.md).
 *
 * Any spare can serve a claim: a different or moved base branch is fixed by
 * `rebranchSpare`. The zone and the image are fixed at warm time. Each claim
 * re-registers egress from the current config.
 *
 * The server is a single process, so module-level state is enough mutual
 * exclusion.
 */
import { workspaceDriver } from '#drivers/driver'
import { cleanupWorkspace, deleteWorkspaceState } from './cleanup'
import { claimProvisioning, spawningSpares } from './provisioning'
import { rebranchSpare } from './spare-pool'
import { recordTrackedScratchDirs } from './tracked-scratch-dirs'
import { launchSessions } from './session-launch'
import {
  applyWorkspaceEvent,
  findWorkspaceRow,
  getGitIdentity,
  getTimeZone,
  getProjectRow,
  insertSession,
  type SessionLaunchSettings,
} from '#db'
import type { WorkspaceCreateResult } from './create'
import { isTmuxSessionAlive } from '#runtime/status'
import { getDefaultBranch, remoteBranchExists, resolveRemoteRef } from '#domain/git'
import { credentialOwnerKey } from '#domain/auth'
import {
  fetchProjectOrigin,
  getProjectAllowlist,
  projectRemoteUrl,
  resolveProjectConfig,
  resolveProjectEnv,
} from '#domain/projects'
import { shellEscape } from '#lib/shell'
import { repoDir } from '@yaac/shared/project-paths'
import { ServerError } from '@yaac/shared/errors'
import { testEnv } from '@yaac/shared/env'
import { serverLog } from '#lib/log'
import type { RuntimeHandle } from '#drivers/contract'

/**
 * Job names of spares being claimed. Reserved synchronously so concurrent
 * claims cannot take the same spare and the reconciler does not reap it.
 */
export const claiming = new Set<string>()

/**
 * Workspace ids of spares the reconciler is reaping. The pod stays listed
 * and alive through the salvage, the Job delete and its grace period, so
 * this keeps it out of the pool's count and stops later ticks from reaping
 * it again (a second reap would exec into the dying pod and race the first
 * one's checkout removal). Claims and refreshes skip it through
 * `freeSpare`.
 */
export const reaping = new Set<string>()

/**
 * Spares being moved to their base branch's new tip in the background
 * (`./prewarm-reconcile`), job name → the refresh, which never rejects. A
 * claim waits for it rather than taking the spare mid-reset, and the
 * planner counts the spare but does not reap it.
 */
export const refreshing = new Map<string, Promise<void>>()

/**
 * The commit each spare's checkout was last seen at, by workspace id, so a
 * refresh pass execs into a spare only when its base branch's tip has moved.
 */
export const spareHeads = new Map<string, string>()

/** What a spare was warmed with, which a claim and the planner match on. */
export interface SpareSettings {
  /** The `TZ` it launched with. */
  timeZone?: string
  /** Its checkout's upstream; absent on an empty repo. */
  baseBranch?: string
  /** The image it runs; absent for a driver that runs none. */
  image?: string
  /** The scratch dirs its checkout was prepared with. */
  scratchDirs?: string[]
}

/**
 * Each spare's warm-time settings, by workspace id, set by its create before
 * the launch and dropped by its claim or reap. A spare has no row to hold
 * them, so after a server restart every spare is missing here, counts as
 * stale, and is reaped and rewarmed.
 */
export const spareSettings = new Map<string, SpareSettings>()

/** Test helper: reset all shared prewarm state. */
export function clearPrewarmStateForTests(): void {
  claiming.clear()
  spawningSpares.clear()
  reaping.clear()
  refreshing.clear()
  spareHeads.clear()
  spareSettings.clear()
}

/**
 * A spare's warm-time settings if no warm or claim holds it, else
 * undefined. Read at the moment of acting, not from an earlier listing: a
 * claim that has since finished leaves no other mark in memory, and its
 * pod may still be listed as a spare. A reap drops the settings as it
 * starts, so a spare being reaped reads as taken too.
 */
export function freeSpare(spare: Pick<RuntimeHandle, 'jobName' | 'workspaceId'>): SpareSettings | undefined {
  if (claiming.has(spare.jobName) || spawningSpares.has(spare.workspaceId)) return undefined
  return spareSettings.get(spare.workspaceId)
}

/**
 * The image a create in the project would launch on now, which a spare must
 * match to be claimed: a Dockerfile edit or a `nestedContainers` toggle
 * changes it, and a pod's image is fixed. Undefined for a driver that runs
 * none.
 */
export async function currentSpareImage(projectId: string, owner: string): Promise<string | undefined> {
  const runtime = workspaceDriver()
  if (runtime.kind === 'containerless') return undefined
  const nestedContainers = (await resolveProjectConfig(projectId))?.nestedContainers === true
  return await runtime.currentImage({ projectId, owner, nestedContainers })
}

/**
 * Tear a spare down and delete its files, in the background. The caller
 * saw its unit marked prewarmed, in a listing that may predate a claim
 * that has since finished and released its reservation. So a spare with a
 * row is looked up again: one the runtime no longer marks is the user's
 * workspace and is left alone. One still marked was left by a server that
 * died between a claim's insert and its relabel, and is torn down like a
 * stop, which keeps the files.
 *
 * Pod, then files, then the unit's record (the Job), each only if the
 * previous step succeeded, so whatever a failure leaves is still marked a
 * spare and a later reap retries it. A lookup that fails is such a
 * failure: it must never read as "no row" or "still a spare". A spare
 * being claimed, warmed or already reaped is left alone.
 *
 * `claimFailed` is a claim's own rollback, which knows no claim stands, so
 * a spare it left with a row is stopped even if it got as far as the
 * relabel.
 */
export function reapSpare(target: PrewarmReapTarget, { claimFailed = false } = {}): void {
  const { jobName, projectId, workspaceId } = target
  if (claiming.has(jobName) || spawningSpares.has(workspaceId) || reaping.has(workspaceId)) return
  reaping.add(workspaceId)
  spareSettings.delete(workspaceId)
  void (async () => {
    const hasRow = await findWorkspaceRow(workspaceId) !== undefined
    if (hasRow && !claimFailed && await workspaceDriver().find(workspaceId) !== undefined) {
      serverLog(`[prewarm] spare ${workspaceId} was claimed since it was listed: not reaping it`)
      return
    }
    if (!await cleanupWorkspace({ ...target, keepRecord: true })) return
    if (hasRow) {
      serverLog(`[prewarm] spare ${workspaceId} has a row, so it was claimed: keeping its files`)
    } else if (!await deleteWorkspaceState(projectId, workspaceId)) {
      return
    }
    await workspaceDriver().destroy({ projectId, workspaceId, unitName: jobName }, { salvageImages: false })
  })().catch((err: unknown) => {
    serverLog(`[prewarm] reaping spare ${workspaceId} failed: ${String(err)}`)
  }).finally(() => { reaping.delete(workspaceId) })
}

export interface PrewarmSpawn {
  projectId: string
}

export interface PrewarmReapTarget {
  jobName: string
  projectId: string
  workspaceId: string
}

export interface PrewarmPlan {
  toSpawn: PrewarmSpawn[]
  toReap: PrewarmReapTarget[]
}

/** What the planner reads besides the listing and the pool size. */
export interface PrewarmState {
  /** In-flight spawns, workspace id → project id (`spawningSpares`). */
  inFlight: ReadonlyMap<string, string>
  /** Job names of spares mid-claim (`claiming`). */
  claiming: ReadonlySet<string>
  /** Job names of spares mid-refresh (`refreshing`). */
  refreshing: ReadonlySet<string>
  /** Projects with a workspace being created or restarted. */
  provisioning: ReadonlySet<string>
  /** Spares warmed in an agent mode the project no longer creates in, a
   *  zone the user is no longer in, or an image it no longer builds. */
  stale: ReadonlySet<string>
}

/**
 * Pure planner: which spares to spawn and reap, given the workspaces and the
 * pool size.
 *
 * - Spares being claimed or spawned are never reaped; in-flight spawns count
 *   toward the pool even before their pod is listed. Spares being refreshed
 *   count but are not reaped until the refresh ends.
 * - A project with a running user workspace gets `poolSize` spares: spawn to
 *   fill, reap the oldest excess. A different tool, model or permission mode
 *   does not make a spare stale (a claim can retool it).
 * - Spares in `stale` (wrong agent mode, zone or image, which a claim
 *   cannot convert) are reaped and do not count.
 * - A project with no running user workspace loses all its spares, unless a
 *   workspace is provisioning (e.g. mid-restart).
 */
export function computePrewarmPlan(
  pods: RuntimeHandle[],
  poolSize: number,
  state: PrewarmState,
): PrewarmPlan {
  const toSpawn: PrewarmSpawn[] = []
  const toReap: PrewarmReapTarget[] = []
  const reap = (p: RuntimeHandle): void => {
    if (state.refreshing.has(p.jobName)) return
    toReap.push({ jobName: p.jobName, projectId: p.projectId, workspaceId: p.workspaceId })
  }
  const claimedByProject = new Map<string, number>()
  const sparesByProject = new Map<string, RuntimeHandle[]>()
  for (const p of pods) {
    if (!p.projectId) continue
    if (p.prewarmed) {
      if (state.claiming.has(p.jobName) || state.inFlight.has(p.workspaceId)) continue
      if (state.stale.has(p.jobName)) {
        reap(p)
        continue
      }
      const arr = sparesByProject.get(p.projectId)
      if (arr) arr.push(p)
      else sparesByProject.set(p.projectId, [p])
    } else if (p.running) {
      claimedByProject.set(p.projectId, (claimedByProject.get(p.projectId) ?? 0) + 1)
    }
  }
  const inFlightByProject = new Map<string, number>()
  for (const project of state.inFlight.values()) {
    inFlightByProject.set(project, (inFlightByProject.get(project) ?? 0) + 1)
  }

  const projects = new Set([...claimedByProject.keys(), ...sparesByProject.keys()])
  for (const project of projects) {
    const claimed = claimedByProject.get(project) ?? 0
    const spares = sparesByProject.get(project) ?? []
    if (claimed === 0) {
      // Idle project: drain every spare.
      if (!state.provisioning.has(project)) spares.forEach(reap)
      continue
    }
    // Reap excess, oldest first (e.g. after the pool size is lowered).
    if (spares.length > poolSize) {
      spares.sort((a, b) => a.createdAtMs - b.createdAtMs)
      spares.slice(0, spares.length - poolSize).forEach(reap)
    }
    // Spawn to fill, counting in-flight spawns so ticks don't stampede.
    const current = spares.length + (inFlightByProject.get(project) ?? 0)
    for (let i = current; i < poolSize; i++) toSpawn.push({ projectId: project })
  }
  return { toSpawn, toReap }
}

/**
 * The branch a claim must re-branch its spare onto, or null if it already
 * matches. Both sides default to the repo's current default branch.
 */
export function resolveRebranchTarget(params: {
  requestedBranch: string | undefined
  spareUpstreamBranch: string | null
  defaultBranch: string
}): string | null {
  const desired = params.requestedBranch ?? params.defaultBranch
  const spareBranch = params.spareUpstreamBranch ?? params.defaultBranch
  return desired === spareBranch ? null : desired
}

/** Fetch the project's origin (skipped in e2e, like the cold path). */
async function fetchSpareOrigin(projectId: string): Promise<void> {
  if (testEnv.e2eSkipFetch) return
  await fetchProjectOrigin(projectId)
}

/** How long a claim keeping its spare's branch waits for the fetch before
 *  handing the spare over on its warmed base. */
const REFRESH_FETCH_WAIT_MS = 5_000

/**
 * The commit to move a spare keeping its `branch` up to, or null to hand it
 * over as warmed (fetch too slow, or already current). Never throws: a
 * refresh is only worth it while cheap.
 */
async function refreshTarget(
  fetched: Promise<void>,
  repo: string,
  branch: string,
  workspaceId: string,
  head: () => Promise<string>,
): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined
  try {
    const landed = await Promise.race([
      fetched.then(() => true),
      new Promise<false>((r) => { timer = setTimeout(() => { r(false) }, REFRESH_FETCH_WAIT_MS) }),
    ])
    if (!landed) {
      console.warn(`Claimed session ${workspaceId} kept its warmed base: fetch still running`)
      return null
    }
    const sha = await resolveRemoteRef(repo, branch)
    return sha === await head() ? null : sha
  } catch (err) {
    console.warn(`Claimed session ${workspaceId} kept its warmed base: ${(err as Error).message}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** How long a claim waits for a spare's background refresh before trying
 *  the next spare, or a cold create. */
const REFRESH_WAIT_MS = 15_000

/** Whether `refresh` (which never rejects) ends by `deadline` (epoch ms). */
async function settlesBy(refresh: Promise<void>, deadline: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      refresh.then(() => true),
      new Promise<false>((r) => { timer = setTimeout(() => { r(false) }, Math.max(0, deadline - Date.now())) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Wait for every task, then throw the first failure. Unlike `Promise.all`,
 * a failure never leaves a sibling still changing the spare while the
 * caller reaps it.
 */
async function allSucceed(tasks: Array<Promise<unknown>>): Promise<void> {
  const failed = (await Promise.allSettled(tasks)).find((r) => r.status === 'rejected')
  if (failed !== undefined) throw failed.reason
}

/**
 * Try to claim a running spare for this create. Returns the claimed
 * workspace (with the spare's id), or `undefined` to fall back to a cold
 * create. Infra failures degrade to a cold create; only a VALIDATION error
 * for a nonexistent requested branch propagates (before any change), since a
 * cold create would fail the same way.
 *
 * Spares in the create's zone and on its image qualify, newest first. A
 * spare is re-branched (`rebranchSpare`) as needed. Inserting the workspace
 * row is the commit point: from then on no reap deletes the spare's files. A
 * failure after it deletes the row, then returns the spare to the pool if
 * it is untouched, else reaps it. Once `claimSpare` has unmarked the
 * runtime, the workspace is the user's: its session is launched as in any
 * running workspace, and a failure is the create's own.
 */
export async function tryClaimPrewarmed(
  projectId: string,
  /** The create's provisioning entry, which the spare is listed under until
   *  the create resolves. */
  requestId: string,
  /** The session it opens; absent for a workspace with none. */
  session: SessionLaunchSettings | undefined,
  emit: (message: string) => void,
  /** The base branch, titles, group and deadline. */
  request: { branch?: string; title?: string; generatedTitle?: string; groupId?: string; deadline?: Date } = {},
): Promise<WorkspaceCreateResult | undefined> {
  const { branch } = request
  const runtime = workspaceDriver()
  let reserved: string | undefined
  let chosen: RuntimeHandle | undefined
  /** The chosen spare's warm-time settings. */
  let warmed: SpareSettings | undefined
  let mutated = false
  // Whether this claim inserted the row a failure must delete.
  let inserted = false
  let claimed = false
  try {
    const workspaces = await runtime.list(projectId)
    const launched = new Map(workspaces.flatMap((p) => {
      const settings = p.prewarmed && p.running ? freeSpare(p) : undefined
      return settings ? [[p.jobName, settings] as const] : []
    }))
    const spares = workspaces.filter((p) => launched.has(p.jobName))
    if (spares.length === 0) return undefined
    const owner = (await getProjectRow(projectId))?.owner
    if (owner === undefined) return undefined
    const [timeZone, image] = await Promise.all([
      getTimeZone(owner).then((z) => z.timeZone ?? undefined),
      currentSpareImage(projectId, owner),
    ])
    const candidates = spares
      // Neither the zone nor the image can be converted: the pod spec is
      // fixed, and `TZ` is set at launch.
      .filter((p) => launched.get(p.jobName)?.timeZone === timeZone && launched.get(p.jobName)?.image === image)
      .sort((a, b) => b.createdAtMs - a.createdAtMs)

    for (const c of candidates) {
      // A spare mid-refresh is about to be current, so it is worth a short
      // wait. Re-read after each wait: a new refresh can start before this
      // resumes, and the reservation below must follow the last read with no
      // await between.
      const deadline = Date.now() + REFRESH_WAIT_MS
      let settled = true
      for (let r = refreshing.get(c.jobName); r !== undefined && settled; r = refreshing.get(c.jobName)) {
        settled = await settlesBy(r, deadline)
      }
      if (!settled || freeSpare(c) === undefined) continue
      // No await between the check and the add.
      claiming.add(c.jobName)
      reserved = c.jobName
      if (await isTmuxSessionAlive(c)) {
        chosen = c
        break
      }
      // Stuck spare (tmux never came up): release it for the reaper.
      claiming.delete(c.jobName)
      reserved = undefined
    }
    if (!chosen) return undefined
    warmed = launched.get(chosen.jobName)
    // Start the fetch now so it overlaps the steps below; awaited at the
    // branch prep.
    const fetched = fetchSpareOrigin(projectId)
    fetched.catch(() => { /* observed below */ })

    // The commands below need the agent transport. The liveness check above
    // may be cached, so gate here, before any change: on failure the spare
    // is untouched and the claim falls back to a cold create.
    const repo = repoDir(projectId)
    const [defaultBranch] = await Promise.all([
      getDefaultBranch(repo),
      runtime.awaitAgentTransport(chosen.jobName, { timeoutMs: 10_000 }),
    ])
    const spareUpstreamBranch = warmed?.baseBranch ?? null
    const rebranchTo = resolveRebranchTarget({
      requestedBranch: branch,
      spareUpstreamBranch,
      defaultBranch,
    })

    // Insert the row before changing the spare, so a server that dies from
    // here on leaves a row, which keeps the reap from deleting the checkout.
    // List the spare under the create's provisioning entry first, so the
    // sidebar does not show both.
    const claimedId = chosen.workspaceId
    claimProvisioning(requestId, claimedId)
    const baseBranch = rebranchTo ?? spareUpstreamBranch
    await applyWorkspaceEvent({
      type: 'workspace-created',
      projectId,
      workspaceId: claimedId,
      ...(baseBranch !== null ? { baseBranch } : {}),
      ...(request.title !== undefined ? { title: request.title } : {}),
      ...(request.generatedTitle !== undefined ? { generatedTitle: request.generatedTitle } : {}),
      ...(request.groupId !== undefined ? { groupId: request.groupId } : {}),
      ...(request.deadline !== undefined ? { deadline: request.deadline } : {}),
      ...(timeZone !== undefined ? { timeZone } : {}),
      ...(warmed?.scratchDirs !== undefined ? { scratchDirs: warmed.scratchDirs } : {}),
    })
    inserted = true
    await applyWorkspaceEvent({ type: 'workspace-life-started', projectId, workspaceId: claimedId })
    // Recorded now, so a server that dies before the launch below leaves it
    // for `reconcileSessions` to launch.
    const opened = session !== undefined ? await insertSession(projectId, claimedId, session) : undefined

    // Branch prep happens before the session launches.
    let prep: { branch: string; sha: string } | null = null
    if (rebranchTo !== null) {
      // A re-branch needs the fetch, however long it takes.
      await fetched
      if (!(await remoteBranchExists(repo, rebranchTo))) {
        throw new ServerError('VALIDATION', `branch "${rebranchTo}" not found on origin.`)
      }
      prep = { branch: rebranchTo, sha: await resolveRemoteRef(repo, rebranchTo) }
      emit(`Switching prewarmed session to branch ${rebranchTo}...`)
    } else {
      // Keep the branch, but move up to where origin now has it. HEAD is
      // read inside the workspace; the server never runs git on its clone.
      // It reads empty for a spare warmed on an empty repo, so that spare
      // moves to origin's first branch.
      const warmedBranch = spareUpstreamBranch ?? defaultBranch
      const job = chosen.jobName
      const head = async (): Promise<string> => (await runtime.exec(
        job, `git -C ${runtime.workspacePaths(job).workspaceDir} rev-parse -q --verify HEAD || true`,
      )).stdout.trim()
      const sha = await refreshTarget(fetched, repo, warmedBranch, claimedId, head)
      if (sha !== null) {
        prep = { branch: warmedBranch, sha }
        emit(`Updating prewarmed session to the latest ${warmedBranch}...`)
      }
    }
    // Re-register from the current config (allowlist, secrets, remote), so
    // project edits since warming apply. The allowlist is read fresh here so
    // an allow-host during the fetch is not overwritten.
    const [config, allowlist, remoteUrl, projectEnv] = await Promise.all([
      resolveProjectConfig(projectId),
      getProjectAllowlist(projectId),
      projectRemoteUrl(projectId),
      resolveProjectEnv(projectId),
    ])
    const registration = {
      workspaceId: claimedId,
      projectId,
      owner: credentialOwnerKey(owner),
      config: config ?? {},
      allowlist,
      remoteUrl,
      proxySecretRules: Object.fromEntries(
        Object.entries(projectEnv.secrets).map(([name, { rule }]) => [name, rule]),
      ),
    }
    // A re-branch makes the spare inconsistent if we fail.
    if (prep !== null) mutated = true
    const spare = chosen
    await allSucceed([
      (async () => {
        await runtime.registerWorkspace(registration)
        if (prep !== null) await rebranchSpare(spare, prep.branch, prep.sha)
      })(),
      // Re-apply the current git identity, which may have changed since the
      // spare was warmed. Non-fatal: the workspace is already usable.
      getGitIdentity(owner).then((identity) => identity && runtime.exec(
        spare.jobName,
        `git config --global user.name '${shellEscape(identity.name)}'`
        + ` && git config --global user.email '${shellEscape(identity.email)}'`,
      )).catch((err: unknown) => {
        console.warn(
          `Git identity for claimed session ${claimedId} not applied `
          + `(the warmed-in one stands): ${(err as Error).message}`,
        )
      }),
    ])
    // Not awaited: a claim never waits out a slow fetch.
    void fetched.then(async () => recordTrackedScratchDirs(
      projectId,
      claimedId,
      prep?.branch ?? baseBranch ?? undefined,
      warmed?.scratchDirs ?? [],
    )).catch(() => { /* a failed fetch is the branch prep's to report */ })

    // Unmark the runtime. A lost race throws and falls back to a cold
    // create; so does a lost response to a claim that landed, which is why
    // the spare counts as changed from here.
    mutated = true
    await runtime.claimSpare(claimedId)
    claimed = true
    spareSettings.delete(claimedId)

    emit('Using prewarmed session...')
    if (opened !== undefined) await launchSessions({ projectId, workspaceId: claimedId, jobName: chosen.jobName }, [opened])
    return {
      workspaceId: chosen.workspaceId,
      jobName: chosen.jobName,
      forwardedPorts: [],
      ...(opened !== undefined ? { sessionId: opened.id } : {}),
    }
  } catch (err) {
    if (claimed) throw err
    // A VALIDATION error before any change propagates, but only after the
    // rollback below.
    const propagate = !mutated && err instanceof ServerError && err.code === 'VALIDATION'
    if (chosen) {
      const { workspaceId } = chosen
      // The row goes first, since a reap keeps the files of a workspace that
      // has one. Its sessions go with it.
      const undone = !inserted || await applyWorkspaceEvent({ type: 'workspace-create-failed', projectId, workspaceId })
        .then(() => true, (e: unknown) => {
          serverLog(`[prewarm] undoing the claim of ${workspaceId} failed: ${String(e)}`)
          return false
        })
      if (mutated || !undone) {
        // A changed spare is inconsistent, and one whose row stayed can no
        // longer be claimed, so reap it, leaving no gap for a concurrent
        // claim to take it in. Not awaited, so the caller falls back to a
        // cold create at once.
        claiming.delete(chosen.jobName)
        reserved = undefined
        reapSpare(chosen, { claimFailed: true })
      }
      // The cold create that follows lists under the create's own id.
      claimProvisioning(requestId, undefined)
    }
    if (propagate) throw err
    return undefined
  } finally {
    if (reserved) claiming.delete(reserved)
  }
}
