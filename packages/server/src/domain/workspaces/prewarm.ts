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
 * A spare serves a claim that starts with what it was warmed with: the same
 * repos in the same folders and the same cwd (`spareMatches`). A checkout
 * on another branch or commit than the claim starts at is moved there
 * (`moveSpare`). The zone and the image are fixed at warm time. Each claim
 * re-registers egress from the current config.
 *
 * The server is a single process, so module-level state is enough mutual
 * exclusion.
 */
import path from 'node:path'
import { workspaceDriver } from '#drivers/driver'
import { cleanupWorkspace, deleteWorkspaceState } from './cleanup'
import { claimProvisioning, spawningSpares } from './provisioning'
import { catchUp, followOrigin, MOVE_TIMEOUT_MS, moveSpare, type CatchUp, type Following } from './origin-catch-up'
import { pickStart, storedSelection, type WorkspaceStart } from './checkouts'
import { lifeHooksCommand, startStepsOf } from './life'
import { recordTrackedScratchDirs } from './tracked-scratch-dirs'
import { openWindows, prepareLaunches, timeAgentBoots } from './session-launch'
import {
  applyWorkspaceEvent,
  findWorkspaceRow,
  getGitIdentity,
  getTimeZone,
  getProjectRow,
  insertSession,
  type ProjectRow,
  type SessionLaunchSettings,
} from '#db'
import type { WorkspaceCreateResult } from './create'
import { tmuxCmd } from '#runtime/agents'
import { getDefaultBranch } from '#domain/git'
import { spareImageTag } from '#domain/images'
import { credentialOwnerKey } from '#domain/auth'
import { getProjectAllowlist, resolveProjectConfig, resolveProjectEnv } from '#domain/projects'
import { fetchRepoOrigin } from '#domain/repos'
import { shellEscape } from '#lib/shell'
import { repoDir } from '@yaac/shared/project-paths'
import { ServerError } from '@yaac/shared/errors'
import { testEnv } from '@yaac/shared/env'
import { serverLog } from '#lib/log'
import { ofCheckout, startTiming } from '#lib/start-timing'
import type { RuntimeHandle } from '#drivers/contract'
import type { RepoSelection } from '@yaac/shared/types'

/**
 * Job names of spares being claimed. Reserved synchronously so concurrent
 * claims cannot take the same spare and the reconciler does not reap it.
 */
export const claiming = new Set<string>()

/**
 * Workspace ids of spares the reconciler is reaping. The pod stays listed
 * and alive through the Job delete and its grace period, so this keeps it
 * out of the pool's count and stops later ticks from reaping it again (a
 * second reap would exec into the dying pod and race the first one's
 * checkout removal). Claims and refreshes skip it through
 * `freeSpare`.
 */
export const reaping = new Set<string>()

/**
 * Spares being moved to their base branch's new tip in the background
 * (`./prewarm-reconcile`), job name → the refresh, which never rejects. A
 * claim waits for it rather than taking the spare mid-move, and the
 * planner counts the spare but does not reap it.
 */
export const refreshing = new Map<string, Promise<void>>()

/**
 * The commits each spare's checkouts were last seen at, in order and joined,
 * by workspace id, so a refresh pass execs into a spare only when one of its
 * base branches' tips has moved.
 */
export const spareHeads = new Map<string, string>()

/** What a spare was warmed with, which a claim and the planner match on. */
export interface SpareSettings {
  /** The `TZ` it launched with. */
  timeZone?: string
  /** What it started with: its layout and cwd (`storedSelection`), and
   *  each checkout's repo, folder and upstream, absent for an empty repo. A
   *  claim must ask for the same repos, folders and cwd. */
  selection: RepoSelection
  repos: Array<{ repoId: string; path: string; baseBranch?: string }>
  /** The image it runs; absent for a driver that runs none. */
  image?: string
  /** The git identity it was launched with, which a claim sets again only
   *  if it has changed since. */
  gitIdentity?: { name: string; email: string }
  /** The scratch dirs its checkouts were prepared with, relative to the
   *  workspace root. */
  scratchDirs?: string[]
  /** Its tree's directory on its node, named when it was warmed; the life a
   *  claim starts records it. */
  treeDir?: string
}

/**
 * Whether a spare was warmed with what `start` asks for: the same repos in
 * the same folders, and the same cwd. Branches are left to the claim.
 */
export function spareMatches(warmed: SpareSettings, start: WorkspaceStart): boolean {
  return warmed.repos.length === start.repos.length
    && start.repos.every((r) => warmed.repos.some((w) => w.repoId === r.link.repo.id && w.path === r.path))
    && warmed.selection.cwd === storedSelection(start).cwd
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
 * The image a spare of the project is kept on now, which a spare must match
 * to be claimed: the last built revision of the image the project's last
 * create chose (docs/image-builds.md). A finished build changes it, and a
 * pod's image is fixed. Undefined for a driver that runs none, and null
 * while that image has nothing built.
 */
export async function currentSpareImage(project: Pick<ProjectRow, 'id'>): Promise<string | null | undefined> {
  const runtime = workspaceDriver()
  if (runtime.kind === 'containerless') return undefined
  const tag = await spareImageTag(project.id)
  return tag === null ? null : runtime.imageRef(tag)
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
    await workspaceDriver().destroy({ projectId, workspaceId, unitName: jobName })
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
 * Whether a reserved spare can take a claim: the commit each of its
 * checkouts is at (empty for one with none), in order, or undefined for a
 * spare whose tmux is gone or that cannot be reached. One command asks
 * both, read fresh rather than from the liveness cache, so a spare that
 * answers has a working agent transport for the commands that follow.
 */
async function probeSpare(spare: RuntimeHandle, checkoutPaths: string[]): Promise<string[] | undefined> {
  const runtime = workspaceDriver()
  const paths = runtime.workspacePaths(spare.jobName)
  try {
    const { stdout } = await runtime.exec(spare.jobName, [
      `${tmuxCmd(paths)} has-session -t yaac`,
      ...checkoutPaths.map((p) => `{ git -C ${path.posix.join(paths.workspaceDir, p)} rev-parse -q --verify HEAD || echo; }`),
    ].join(' && '), { timeout: 10_000, maxAttempts: 1 })
    const heads = stdout.split('\n')
    return checkoutPaths.map((_, i) => heads[i]?.trim() ?? '')
  } catch {
    return undefined
  }
}

/**
 * Try to claim a running spare for this create. Returns the claimed
 * workspace (with the spare's id), or `undefined` to fall back to a cold
 * create. Infra failures degrade to a cold create; only a VALIDATION error
 * for a nonexistent requested branch propagates (before any change), since a
 * cold create would fail the same way.
 *
 * Spares in the create's zone and on its image, warmed with what it starts
 * with (`spareMatches`), qualify, newest first. Each checkout starts at the
 * commit the main clone has for its branch (`pickStart`), so the claim
 * never waits for its fetch of origin: a spare on another commit or branch
 * is moved there first (`moveSpare`), and the workspace catches up with
 * the fetch once it lands (`./origin-catch-up`). Inserting the workspace
 * row is the commit point: from then on no reap deletes the spare's files. A
 * failure after it deletes the row, then returns the spare to the pool if
 * it is untouched, else reaps it. Once `claimSpare` has unmarked the
 * runtime, the workspace is the user's: its session is launched as in any
 * running workspace, and a failure is the create's own.
 *
 * Its round trips are grouped so that it waits three times: on the probe
 * (`probeSpare`), on the egress registration beside the runtime's
 * compare-and-swap and any move of the spare, and on the one command that
 * opens the session, beside the rest of the unmarking. What the server
 * works out on its own (the start commits, the session's launch command)
 * is started early enough to be ready by the wait that needs it. Each
 * process a command starts in a gVisor pod costs tens of milliseconds, so
 * the commands start as few as they can. Its phases are timed into the
 * server log once a spare is chosen (#lib/start-timing).
 */
export async function tryClaimPrewarmed(
  projectId: string,
  /** The create's provisioning entry, which the spare is listed under until
   *  the create resolves. */
  requestId: string,
  /** The session it opens; absent for a workspace with none. */
  session: SessionLaunchSettings | undefined,
  emit: (message: string) => void,
  /** What it starts with, its titles, group and deadline. */
  request: { start: WorkspaceStart; title?: string; generatedTitle?: string; groupId?: string; deadline?: Date },
): Promise<WorkspaceCreateResult | undefined> {
  const { start } = request
  const runtime = workspaceDriver()
  let reserved: string | undefined
  let chosen: RuntimeHandle | undefined
  /** The chosen spare's warm-time settings. */
  let warmed: SpareSettings | undefined
  let mutated = false
  // Whether this claim inserted the row a failure must delete.
  let inserted = false
  let claimed = false
  /** The rest of the runtime's unmarking, in flight once the claim is won. */
  let unmarked: Promise<void> = Promise.resolve()
  const timing = startTiming('claim')
  let outcome = 'fallback'
  try {
    // The informer's view will do: a spare it has not caught up on is
    // passed over, or refused by the probe or the compare-and-swap.
    const workspaces = await timing.time('list', runtime.list(projectId, { preferCache: true }))
    const launched = new Map(workspaces.flatMap((p) => {
      const settings = p.prewarmed && p.running ? freeSpare(p) : undefined
      return settings ? [[p.jobName, settings] as const] : []
    }))
    const spares = workspaces.filter((p) => launched.has(p.jobName))
    if (spares.length === 0) return undefined
    const row = await getProjectRow(projectId)
    if (row === undefined) return undefined
    const { owner } = row
    const [timeZone, image, gitIdentity] = await Promise.all([
      getTimeZone(owner).then((z) => z.timeZone ?? undefined),
      currentSpareImage(row),
      getGitIdentity(owner),
    ])
    const candidates = spares
      // Neither the zone nor the image can be converted: the pod spec is
      // fixed, and `TZ` is set at launch. Nor can its checkouts or cwd.
      .filter((p) => {
        const settings = launched.get(p.jobName)
        return settings !== undefined && settings.timeZone === timeZone && settings.image === image
          && spareMatches(settings, start)
      })
      .sort((a, b) => b.createdAtMs - a.createdAtMs)

    if (candidates.length === 0) return undefined
    // Start each fetch, and pick each checkout's branch and start commit
    // from its main clone, so both overlap the probe. A pick waits for its
    // fetch only for a branch the clone lacks, and refuses one origin lacks
    // too, as a cold create would.
    const origins = start.repos.map((r) => {
      const fetched = testEnv.e2eSkipFetch ? Promise.resolve() : fetchRepoOrigin(r.link.repo.id)
      fetched.catch(() => { /* read by the pick or the catch-up */ })
      if (!testEnv.e2eSkipFetch) void timing.time(ofCheckout('fetch', r.path), fetched)
      return fetched
    })
    const picks = Promise.all(start.repos.map(async (r, i) => {
      const branch = r.branch ?? await getDefaultBranch(repoDir(r.link.repo.id))
      return { branch, commit: await pickStart(r.link.repo, branch, () => origins[i]) }
    }))
    picks.catch(() => { /* observed below */ })
    void timing.time('pick', picks)
    /** The commit each of the chosen spare's checkouts is at. Nothing moves
     *  them while the claim holds its reservation, so whether the spare
     *  needs moving is read from here. */
    let heads: string[] = []
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
      const probed = await timing.time('probe', probeSpare(c, start.repos.map((r) => r.path)))
      if (probed !== undefined) {
        chosen = c
        heads = probed
        break
      }
      // Stuck spare (tmux never came up): release it for the reaper.
      claiming.delete(c.jobName)
      reserved = undefined
    }
    if (!chosen) return undefined
    timing.identify(chosen.workspaceId)
    warmed = launched.get(chosen.jobName)
    const job = chosen.jobName
    const paths = runtime.workspacePaths(job)
    const picked = await picks
    const rowsFrom = Date.now()
    const checkouts = start.repos.map((r, i) => ({
      repoId: r.link.repo.id,
      path: r.path,
      dir: path.posix.join(paths.workspaceDir, r.path),
      ...picked[i],
      // The spare needs moving: to another commit, or onto another branch.
      retrack: picked[i].branch !== warmed?.repos.find((w) => w.repoId === r.link.repo.id)?.baseBranch,
      moves: heads[i] !== picked[i].commit,
      fetched: origins[i],
    }))

    // Insert the row before changing the spare, so a server that dies from
    // here on leaves a row, which keeps the reap from deleting the checkout.
    // List the spare under the create's provisioning entry first, so the
    // sidebar does not show both.
    const claimedId = chosen.workspaceId
    claimProvisioning(requestId, claimedId)
    // A spare runs only the project's init workflows, so a create bringing
    // its own graph never claims one. They are the ones that apply to the
    // claim's selection, which is the one the spare was warmed with.
    const lifeStart = await startStepsOf(projectId, undefined, checkouts.map((c) => c.repoId))
    for (const s of lifeStart.skipped) emit(`Init workflow "${s.name}" skipped: this workspace has no ${s.missing.join(', ')}`)
    const life = new Date()
    await applyWorkspaceEvent({
      type: 'workspace-created',
      projectId,
      workspaceId: claimedId,
      repos: checkouts.map((c) => ({ repoId: c.repoId, path: c.path, baseBranch: c.branch })),
      cwd: start.cwd,
      ...(request.title !== undefined ? { title: request.title } : {}),
      ...(request.generatedTitle !== undefined ? { generatedTitle: request.generatedTitle } : {}),
      ...(request.groupId !== undefined ? { groupId: request.groupId } : {}),
      ...(request.deadline !== undefined ? { deadline: request.deadline } : {}),
      ...(timeZone !== undefined ? { timeZone } : {}),
      ...(warmed?.scratchDirs !== undefined ? { scratchDirs: warmed.scratchDirs } : {}),
      ...(warmed?.treeDir !== undefined ? { treeDir: warmed.treeDir } : {}),
      at: life,
      startSteps: lifeStart.flows,
      skipped: lifeStart.skipped,
    })
    inserted = true
    if (warmed?.treeDir !== undefined && chosen.node !== undefined) {
      await applyWorkspaceEvent({ type: 'life-node-found', projectId, workspaceId: claimedId, node: chosen.node })
    }
    // Recorded now, so a server that dies before the launch below leaves it
    // for `reconcileSessions` to launch.
    const opened = session !== undefined ? await insertSession(projectId, claimedId, session) : undefined
    timing.phase('rows', rowsFrom)
    // The server's half of the launch, which touches nothing in the spare,
    // is worked out while the waits below are out.
    const workspace = { projectId, workspaceId: claimedId, jobName: job }
    const launches = opened !== undefined ? prepareLaunches(workspace, [opened]) : Promise.resolve([])
    launches.catch(() => { /* observed at the launch */ })
    void timing.time('prepare', launches)

    const spare = chosen
    // A spare on another commit or branch than the claim starts at is moved
    // there before the session launches, beside the waits below.
    const moves = checkouts.filter((c) => c.moves || c.retrack)
    for (const c of moves) {
      emit(c.retrack ? `Switching prewarmed session to branch ${c.branch}...` : `Updating prewarmed session to the latest ${c.branch}...`)
    }
    const moved = moves.length === 0 ? Promise.resolve()
      : timing.time('move', moveSpare(spare, moves.map((c) => ({ dir: c.dir, branch: c.branch, target: c.commit, retrack: c.retrack }))))
    // The scratch dirs are the same in every checkout, so the first one's
    // name them all.
    const under = checkouts[0] !== undefined && checkouts[0].path !== '' ? `${checkouts[0].path}/` : ''
    const scratchDirs = checkouts.length === 0 ? []
      : (warmed?.scratchDirs ?? []).filter((d) => d.startsWith(under)).map((d) => d.slice(under.length))

    // Re-register from the current config (allowlist, secrets), so project
    // edits since warming apply. The allowlist is read fresh here so an
    // allow-host during the fetch is not overwritten.
    const register = async (): Promise<void> => {
      const [config, allowlist, projectEnv] = await Promise.all([
        resolveProjectConfig(projectId),
        getProjectAllowlist(projectId),
        resolveProjectEnv(projectId),
      ])
      if (!config) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
      await runtime.registerWorkspace({
        workspaceId: claimedId,
        projectId,
        owner: credentialOwnerKey(owner),
        config,
        allowlist,
        proxySecretRules: Object.fromEntries(
          Object.entries(projectEnv.secrets).map(([name, { rule }]) => [name, rule]),
        ),
      })
    }
    // Unmark the runtime. A lost race throws and falls back to a cold
    // create; so does a lost response to a claim that landed, which is why
    // the spare counts as changed from here. The registration is written
    // beside it, and the spare moved, since none reads what another writes,
    // and all are done before the session's window opens: no agent starts
    // in a spare another claim won, or under the egress rules it was warmed
    // with. The life's hooks file is written beside them, since a failure
    // from here reaps the spare and its log dir with it, and waited on with
    // them, so a rollback never finds the write still under way.
    mutated = true
    const hooks = timing.time('hooks', lifeHooksCommand(projectId, claimedId, life, paths))
    await allSucceed([
      timing.time('register', register()),
      timing.time('cas', runtime.claimSpare(claimedId)).then((won) => {
        unmarked = timing.time('unmark', won.unmarked)
        // Held until the waits below read it, so a rejection must not count
        // as unhandled meanwhile.
        unmarked.catch(() => { /* read below, and by the rollback */ })
      }),
      hooks,
      moved,
    ])

    // One command for the rest of what the workspace is told: a catch-up
    // with any fetch that has already landed, the git identity, if it has
    // changed since the spare was warmed with one, then the life's log hooks
    // and the session's window, which must open under them. The identity is
    // not worth failing a usable workspace over, so its failure is only
    // printed, and beside a move's own line nothing else prints.
    const following: Following[] = checkouts.map((c) => ({ repoId: c.repoId, path: c.path, branch: c.branch, at: c.commit, fetched: c.fetched }))
    let caught: CatchUp | undefined
    let printed = ''
    const launch = async (): Promise<void> => {
      const identity = gitIdentity !== null
        && (gitIdentity.name !== warmed?.gitIdentity?.name || gitIdentity.email !== warmed.gitIdentity.email)
        ? gitIdentity : undefined
      // Nothing runs in the spare until this command opens the window: the
      // step reconcile leaves a workspace alone while its claim is under way.
      caught = await timing.time('origin', catchUp(workspace, following, 0, (message) => {
        serverLog(`[workspace] ${claimedId}: ${message}`)
        emit(`Note: ${message}`)
      }, { live: false }))
      const ready = await launches
      printed = await timing.time('windows', openWindows(workspace, ready, {
        shell: [
          ...caught.cmds,
          ...(identity !== undefined ? [`{ said=$(git config --global user.name '${shellEscape(identity.name)}' 2>&1`
            + ` && git config --global user.email '${shellEscape(identity.email)}' 2>&1)`
            + ' || echo "${said:-git config failed}"; }'] : []),
        ],
        tmux: [await hooks],
        ...(caught.cmds.length > 0 ? { timeout: MOVE_TIMEOUT_MS } : {}),
      }))
      timeAgentBoots(claimedId, ready)
    }
    // The commit each checkout starts at, and which of its scratch dirs git
    // tracks there.
    const record = async (): Promise<void> => {
      await applyWorkspaceEvent({ type: 'workspace-launched', projectId, workspaceId: claimedId })
      for (const c of checkouts) {
        await applyWorkspaceEvent({ type: 'start-commit-resolved', projectId, workspaceId: claimedId, repoId: c.repoId, startCommit: c.commit })
      }
      await recordTrackedScratchDirs(
        projectId, claimedId, checkouts.map((c) => ({ repoId: c.repoId, path: c.path, base: c.branch })), scratchDirs,
      )
    }
    emit('Using prewarmed session...')
    // The pod is this claim's from here, so the window opens while the
    // runtime finishes unmarking (under k8s, its Job). All of it settles
    // before the outcome is read, so a rollback finds nothing still running
    // in the spare. A failed unmarking fails the claim, window and all: a
    // unit left marked would be reaped as a spare once its pod went.
    const [unmarking, launching] = await Promise.allSettled([unmarked, allSucceed([launch(), timing.time('record', record())])])
    if (unmarking.status === 'rejected') throw unmarking.reason
    claimed = true
    spareSettings.delete(claimedId)
    if (launching.status === 'rejected') throw launching.reason
    // After `record`, so a checkout that caught up is recorded where it ended.
    const said = (await caught?.settle(printed) ?? printed).trim()
    if (said !== '') console.warn(`Git identity for claimed session ${claimedId} not applied (the warmed-in one stands): ${said}`)
    followOrigin(workspace, caught?.waiting ?? [])
    outcome = 'ok'
    return {
      workspaceId: chosen.workspaceId,
      jobName: chosen.jobName,
      forwardedPorts: [],
      ...(opened !== undefined ? { sessionId: opened.id } : {}),
    }
  } catch (err) {
    if (claimed) {
      outcome = 'failed'
      throw err
    }
    // A registration that failed beside a claim that was won leaves the
    // unmarking in flight, and the reap below must not race it.
    await unmarked.catch(() => { /* this claim has already failed */ })
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
    if (propagate) {
      outcome = 'failed'
      throw err
    }
    return undefined
  } finally {
    if (reserved) claiming.delete(reserved)
    timing.end(outcome)
  }
}
