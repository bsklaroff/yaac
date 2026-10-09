/**
 * The prewarmed-workspace pool: claim logic, the pure planner, and the
 * in-memory state shared with the reconcile step (`./prewarm-reconcile`).
 *
 * A spare is a fully provisioned workspace with its agent booted, hidden from
 * user-facing views. `workspace create` claims one instead of provisioning,
 * and gets the spare's own id (it cannot be changed).
 *
 * Spares are warmed with the project's default create settings, but any
 * spare in the right agent mode can serve a claim: a different tool, model or
 * permission mode is fixed by respawning the agent (`retoolSpare`), and a
 * different or moved base branch by `rebranchSpare`. Only the agent mode is
 * fixed at warm time. Each claim re-registers egress from the current config.
 *
 * The server is a single process, so module-level state is enough mutual
 * exclusion.
 */
import { workspaceDriver } from '#drivers/driver'
import { cleanupWorkspace, deleteWorkspaceState } from './cleanup'
import { applyWorkspaceEvent } from '#db'
import { claimProvisioning } from './provisioning'
import { rebranchSpare, retoolSpare } from './spare-pool'
import {
  claimSpareWorkspace,
  getGitIdentity,
  getTimeZone,
  getProjectRow,
  getWorkspaceRow,
  restoreSpareWorkspace,
  setWorkspaceGroup,
  setWorkspaceTitle,
} from '#db'
import type { WorkspaceRow } from '#db'
import { handOverAgent, type CreateSetup, type WorkspaceCreateResult } from './create'
import { setAcpPermissionMode } from '#runtime/agents'
import { isTmuxSessionAlive } from '#runtime/status'
import { getDefaultBranch, remoteBranchExists, resolveRemoteRef } from '#domain/git'
import { credentialOwnerKey } from '#domain/auth'
import {
  fetchProjectOrigin,
  projectRemoteUrl,
  resolveProjectConfig,
  resolveProjectEnv,
} from '#domain/projects'
import { shellEscape } from '#lib/shell'
import { repoDir } from '@yaac/shared/project-paths'
import { ServerError } from '@yaac/shared/errors'
import { testEnv } from '@yaac/shared/env'
import type { RuntimeHandle } from '#drivers/contract'

/**
 * Job names of spares being claimed. Reserved synchronously so concurrent
 * claims cannot take the same spare and the reconciler does not reap it.
 */
export const claiming = new Set<string>()

/**
 * In-flight spawns, workspace id → project id. A spawn is not listed by the
 * runtime for seconds, so this stops ticks from spawning duplicates. Its pod
 * is also never reaped while the create is still running.
 */
export const inFlight = new Map<string, string>()

/**
 * Workspace ids of spares the reconciler is reaping. The pod stays listed
 * and alive through the salvage, the Job delete and its grace period, so
 * this stops a claim from taking it (the reap would then delete the
 * claimed workspace) and later ticks from reaping it again (a second reap
 * would exec into the dying pod and race the first one's checkout removal).
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

/** Test helper: reset all shared prewarm state. */
export function clearPrewarmStateForTests(): void {
  claiming.clear()
  inFlight.clear()
  reaping.clear()
  refreshing.clear()
  spareHeads.clear()
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
  /** In-flight spawns, workspace id → project id (`inFlight`). */
  inFlight: ReadonlyMap<string, string>
  /** Job names of spares mid-claim (`claiming`). */
  claiming: ReadonlySet<string>
  /** Job names of spares mid-refresh (`refreshing`). */
  refreshing: ReadonlySet<string>
  /** Projects with a workspace being created or restarted. */
  provisioning: ReadonlySet<string>
  /** Spares warmed in an agent mode the project no longer creates in, or a
   *  zone the user is no longer in. */
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
 * - Spares in `stale` (wrong agent mode or zone, which a claim cannot
 *   convert) are reaped and do not count.
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
 * Spares in the setup's agent mode qualify, preferring one whose agent
 * already matches. A spare is re-branched (`rebranchSpare`) or retooled
 * (`retoolSpare`) as needed. `claimSpare` is the commit point: a failure
 * before it releases the spare, unless it was already modified, in which
 * case it is reaped.
 */
export async function tryClaimPrewarmed(
  projectId: string,
  /** The create's provisioning entry, which the spare is listed under until
   *  the create resolves. */
  requestId: string,
  setup: CreateSetup,
  emit: (message: string) => void,
  /** The base branch, first prompt, title and group. */
  request: { branch?: string; prompt?: string; title?: string; groupId?: string } = {},
): Promise<WorkspaceCreateResult | undefined> {
  const { tool } = setup
  const { branch } = request
  const runtime = workspaceDriver()
  let reserved: string | undefined
  let chosen: RuntimeHandle | undefined
  /** The chosen spare's row as warming left it, for a rollback to restore. */
  let warmed: WorkspaceRow | undefined
  let mutated = false
  // Whether this claim wrote the workspace row a failure must undo.
  let recordedRow = false
  try {
    const workspaces = await runtime.list(projectId)
    const spares = workspaces.filter((p) => p.prewarmed && p.running)
    // Each spare's launch settings are on its row. Read before reserving, so
    // a reservation never spans an unneeded await.
    const launched = new Map(await Promise.all(spares.map(async (p) =>
      [p.jobName, await getWorkspaceRow(projectId, p.workspaceId).catch(() => undefined)] as const)))
    const owner = (await getProjectRow(projectId))?.owner
    if (owner === undefined) return undefined
    const timeZone = (await getTimeZone(owner)).timeZone ?? undefined
    const matches = (p: RuntimeHandle): boolean => {
      const row = launched.get(p.jobName)
      return row !== undefined && p.tool === tool && row.model === setup.model
        && row.permissionMode === setup.permissionMode && row.effort === setup.effort
    }
    const candidates = spares
      // Neither the mode nor the zone can be converted: an `acp` pod has a
      // mount a `tui` one lacks, the pod spec is fixed, and `TZ` is set at
      // launch.
      .filter((p) => launched.get(p.jobName)?.mode === setup.mode
        && launched.get(p.jobName)?.timeZone === timeZone)
      // Prefer a matching agent (no respawn), then newest.
      .sort((a, b) =>
        Number(matches(b)) - Number(matches(a))
        || b.createdAtMs - a.createdAtMs)

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
      if (!settled || claiming.has(c.jobName) || reaping.has(c.workspaceId)) continue
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
    const asWarmed = matches(chosen)
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

    // Clear the row's `spare` flag before changing the spare: a workspace
    // still flagged `spare` is hidden and reapable, and the startup sweep
    // would delete the user's checkout. `claimSpareWorkspace` throws on
    // failure, aborting before any change. It also records the launch
    // settings, so a restart relaunches the same way.
    const claimedId = chosen.workspaceId
    recordedRow = true
    // List the spare under the create's provisioning entry, so the sidebar
    // does not show both.
    claimProvisioning(requestId, claimedId)
    await claimSpareWorkspace(projectId, claimedId, {
      permissionMode: setup.permissionMode,
      mode: setup.mode,
      ...(setup.model !== undefined ? { model: setup.model } : {}),
      ...(setup.effort !== undefined ? { effort: setup.effort } : {}),
    })
    // An acp spare's connection read the warm-time posture; a conversation
    // the retool below starts must handshake with the claimed one.
    setAcpPermissionMode(projectId, claimedId, setup.permissionMode)
    // Record the running agent (id = workspace id) as the first
    // conversation, with the prompt, as a cold create does. Under acp the id
    // comes from the handshake and the registry records it.
    if (setup.mode === 'tui') {
      await applyWorkspaceEvent({
        type: 'sessions-launched',
        projectId,
        workspaceId: claimedId,
        sessions: [{
          tool,
          agentSessionId: claimedId,
          ...(setup.model !== undefined ? { model: setup.model } : {}),
          ...(request.prompt !== undefined ? { firstPrompt: request.prompt } : {}),
        }],
      })
    }

    // Branch prep must happen before the hand-over, while nobody has
    // prompted the agent.
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
      const warmedBranch = spareUpstreamBranch ?? defaultBranch
      const job = chosen.jobName
      const head = async (): Promise<string> => (await runtime.exec(
        job, `git -C ${runtime.workspacePaths(job).workspaceDir} rev-parse HEAD`,
      )).stdout.trim()
      const sha = await refreshTarget(fetched, repo, warmedBranch, claimedId, head)
      if (sha !== null) {
        prep = { branch: warmedBranch, sha }
        emit(`Updating prewarmed session to the latest ${warmedBranch}...`)
      }
    }
    // Re-register from the current config (allowlist, secrets, remote), under
    // the claimed tool, so project edits since warming apply. The config is
    // read fresh here so an allow-host during the fetch is not overwritten.
    const [config, remoteUrl, projectEnv] = await Promise.all([
      resolveProjectConfig(projectId),
      projectRemoteUrl(projectId),
      resolveProjectEnv(projectId),
    ])
    const registration = {
      workspaceId: claimedId,
      projectId,
      owner: credentialOwnerKey(owner),
      tool,
      config: config ?? {},
      remoteUrl,
      proxySecretRules: Object.fromEntries(
        Object.entries(projectEnv.secrets).map(([name, { rule }]) => [name, rule]),
      ),
    }
    // Registering another tool or respawning makes the spare inconsistent if
    // we fail.
    if (chosen.tool !== tool || prep !== null || !asWarmed) mutated = true
    const spare = chosen
    await allSucceed([
      (async () => {
        // The proxy injects agent credentials only for the registered tool,
        // so the registration lands before any respawn boots the agent.
        await runtime.registerWorkspace(registration)
        // Restart the agent on the new checkout, unless a retool follows.
        if (prep !== null) await rebranchSpare(spare, prep.branch, prep.sha, asWarmed ? setup : null)
        if (!asWarmed) {
          if (spare.tool !== tool) emit(`Switching prewarmed session to ${tool}...`)
          await retoolSpare(spare, setup)
        }
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

    // Commit point: after this, a failure reaps the spare. A lost race
    // throws and falls back to a cold create.
    await runtime.claimSpare(claimedId, tool)
    mutated = true

    await Promise.all([
      rebranchTo !== null
        ? applyWorkspaceEvent({
          type: 'base-branch-resolved',
          projectId,
          workspaceId: claimedId,
          baseBranch: rebranchTo,
        })
        : undefined,
      // Non-fatal (e.g. the group was deleted meanwhile): land ungrouped.
      request.groupId !== undefined
        ? setWorkspaceGroup(projectId, claimedId, request.groupId).catch((err: unknown) => {
          console.warn(
            `Claimed session ${claimedId} not filed in group ${request.groupId ?? ''}: `
            + (err as Error).message,
          )
        })
        : undefined,
      // Before the prompt, so the title sweep never sees it untitled.
      request.title !== undefined ? setWorkspaceTitle(projectId, claimedId, request.title) : undefined,
    ])

    emit('Using prewarmed session...')
    await handOverAgent({
      projectId,
      workspaceId: claimedId,
      jobName: chosen.jobName,
      tool,
      mode: setup.mode,
      ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
      emit,
    })
    return { workspaceId: chosen.workspaceId, jobName: chosen.jobName, tool, mode: setup.mode, forwardedPorts: [] }
  } catch (err) {
    // A VALIDATION error before any change propagates, but only after the
    // row is restored below.
    const propagate = !mutated && err instanceof ServerError && err.code === 'VALIDATION'
    // A spare that was already changed is inconsistent, so reap it (the
    // reservation is kept so no concurrent claim takes it). As in
    // prewarm-reconcile.ts: runtime, then checkout (the cleared `spare` flag
    // hides it from the startup sweep), then row, each only if the previous
    // step succeeded; what is left surfaces via the stale reaper. Not
    // awaited, so the caller falls back to a cold create at once.
    if (chosen && mutated) {
      const { jobName, projectId, workspaceId } = chosen
      void cleanupWorkspace({ jobName, projectId, workspaceId })
        .then((gone) => gone && deleteWorkspaceState(projectId, workspaceId))
        .then((removed) => (removed && recordedRow
          ? applyWorkspaceEvent({ type: 'workspace-create-failed', projectId, workspaceId })
          : undefined))
        .catch(() => { /* best-effort; the stale-session reaper retries */ })
      reserved = undefined
    } else if (warmed && recordedRow) {
      // An untouched spare goes back to the pool, on its warm posture: the
      // row first, then the connection, as the claim set them, so a watcher
      // reconnecting in between cannot read the claimed one back.
      try {
        await restoreSpareWorkspace(warmed)
      } catch {
        // Best-effort.
      }
      setAcpPermissionMode(projectId, warmed.workspaceId, warmed.permissionMode)
    }
    // The cold create that follows lists under the create's own id.
    if (recordedRow) claimProvisioning(requestId, undefined)
    if (propagate) throw err
    return undefined
  } finally {
    if (reserved) claiming.delete(reserved)
  }
}
