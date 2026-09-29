/**
 * Prewarmed-worktree pool: claim logic + the pure planner + the in-memory
 * state shared between the claim path (the create route) and the reconcile
 * loop (`packages/server/src/prewarm-reconcile.ts`).
 *
 * A prewarmed spare is a fully-provisioned worktree whose agent is booted
 * and waiting, reported by the runtime as `prewarmed` and hidden from
 * user-facing views. The reconciler keeps one spare per active project; a
 * `worktree create` "claims" one and attaches, skipping all provisioning. A
 * spare's identity is baked at warm time and can't be re-keyed, so a claim
 * returns the spare's own id; the CLI and webapp adopt it.
 *
 * A spare is warmed as its project's untouched create — the agent it was last
 * created with, launched with the model, posture and agent mode it last used
 * — so the usual claim hands that agent over as-is. Spares are otherwise
 * tool-agnostic: warm-time provisioning seeds every tool's config and env
 * placeholders, so a claim that asks for something else just retools the
 * spare (agent respawn) instead of falling back to a cold create. Only the
 * agent mode is fixed at warm time. Every claim re-registers the spare's
 * egress from the project's current config, so an allowlist or secret edited
 * since warming applies to it as it would to a cold create.
 *
 * Spares are branch-agnostic the same way: one warmed on a different
 * reference branch is re-branched at claim time (`rebranchSpare` — worktree
 * reset + upstream rewrite + window respawns), so any spare serves any
 * branch and a changed project default never invalidates the pool. A spare
 * that keeps its branch goes through the same prep when that branch has moved
 * on origin since it was warmed, so its age never shows as a stale base.
 *
 * The server is a single process (lock-file enforced), so module-level state
 * is sufficient mutual exclusion — no kubernetes optimistic concurrency.
 */
import { worktreeDriver } from '#drivers/driver'
import { cleanupWorktree, deleteWorktreeState } from './cleanup'
import { applyWorktreeEvent } from '#db'
import { claimProvisioning } from './provisioning'
import { rebranchSpare, retoolSpare } from './spare-pool'
import { claimSpareWorktree, getGitIdentity, getWorktreeRow, restoreSpareWorktree, setWorktreeGroup } from '#db'
import type { WorktreeRow } from '#db'
import { handOverAgent, type CreateSetup, type WorktreeCreateResult } from './create'
import { parkAcpLaunchModel } from '#runtime/agents'
import { isTmuxSessionAlive } from '#runtime/status'
import {
  fetchOrigin,
  getDefaultBranch,
  remoteBranchExists,
  resolveLocalBranch,
  resolveRemoteRef,
  worktreeUpstreamBranch,
} from '#domain/git'
import {
  projectRemoteUrl,
  resolveProjectConfig,
  resolveProjectCredential,
  resolveProjectEnv,
} from '#domain/projects'
import { shellEscape } from '#lib/shell'
import { repoDir } from '@yaac/shared/project-paths'
import { ServerError } from '@yaac/shared/errors'
import { testEnv } from '@yaac/shared/env'
import type { RuntimeHandle } from '#drivers/contract'

/**
 * Runtime handles of spares currently being claimed. A claim reserves its
 * target here (synchronously, before any await) so a concurrent claim can't
 * grab the same spare and the reconciler never reaps one out from under a
 * claim.
 */
export const claiming = new Set<string>()

/**
 * In-flight prewarm spawns, keyed by projectSlug → count. `createWorktree`
 * only launches near the very end, so a spawn is invisible to the runtime's
 * own listing for seconds; counting it here stops successive ticks from
 * stampeding duplicate spares.
 */
export const inFlight = new Map<string, number>()

/** Test helper: reset all shared prewarm state. */
export function clearPrewarmStateForTests(): void {
  claiming.clear()
  inFlight.clear()
}

export interface PrewarmSpawn {
  projectSlug: string
}

export interface PrewarmReapTarget {
  jobName: string
  projectSlug: string
  worktreeId: string
}

export interface PrewarmPlan {
  toSpawn: PrewarmSpawn[]
  toReap: PrewarmReapTarget[]
}

/**
 * Pure planner: given the current workspaces and the desired pool size,
 * decide which spares to spawn and which to reap. No side effects (mirrors
 * `classifyWorkspaces`) so the policy is unit-testable without a runtime.
 * What a spawned spare runs is decided at spawn time, not here.
 *
 * - "claimed" = running, non-prewarmed workspaces (the real user worktrees).
 * - "spares" = prewarmed workspaces (any state, so a still-starting spare
 *   counts), minus any currently being claimed (never spawn against / reap
 *   one mid-claim).
 * - A project with ≥1 claimed worktree wants `poolSize` spares: spawn to fill
 *   (counting in-flight so we don't stampede) and reap genuine excess. A
 *   spare warmed with a different agent, model or posture than the project
 *   now uses is still claimable — its agent is respawned at claim time — so
 *   it counts toward the pool and is never reaped for that.
 * - A spare in `staleJobNames` is reaped and does not count: it was warmed in
 *   the other agent mode than the project's creates now ask for, and a claim
 *   cannot convert it (see `tryClaimPrewarmed`), so left in place it would
 *   fill the pool with a spare nothing takes.
 * - A project with 0 claimed worktrees drains all its spares.
 */
export function computePrewarmPlan(
  pods: RuntimeHandle[],
  poolSize: number,
  inFlightCounts: Map<string, number>,
  claimingJobNames: Set<string>,
  staleJobNames: ReadonlySet<string> = new Set(),
): PrewarmPlan {
  const toSpawn: PrewarmSpawn[] = []
  const toReap: PrewarmReapTarget[] = []
  const reap = (p: RuntimeHandle): void => {
    toReap.push({ jobName: p.jobName, projectSlug: p.projectSlug, worktreeId: p.workspaceId })
  }
  const claimedByProject = new Map<string, number>()
  const sparesByProject = new Map<string, RuntimeHandle[]>()
  for (const p of pods) {
    if (!p.projectSlug) continue
    if (p.prewarmed) {
      if (claimingJobNames.has(p.jobName)) continue
      if (staleJobNames.has(p.jobName)) {
        reap(p)
        continue
      }
      const arr = sparesByProject.get(p.projectSlug)
      if (arr) arr.push(p)
      else sparesByProject.set(p.projectSlug, [p])
    } else if (p.running) {
      claimedByProject.set(p.projectSlug, (claimedByProject.get(p.projectSlug) ?? 0) + 1)
    }
  }

  const projects = new Set([...claimedByProject.keys(), ...sparesByProject.keys()])
  for (const project of projects) {
    const claimed = claimedByProject.get(project) ?? 0
    const spares = sparesByProject.get(project) ?? []
    if (claimed === 0) {
      // Idle project: drain every spare.
      spares.forEach(reap)
      continue
    }
    // Reap genuine excess (oldest first) — e.g. after the pool size is lowered.
    if (spares.length > poolSize) {
      spares.sort((a, b) => a.createdAtMs - b.createdAtMs)
      spares.slice(0, spares.length - poolSize).forEach(reap)
    }
    // Spawn to fill, counting in-flight spawns so ticks don't stampede.
    const current = spares.length + (inFlightCounts.get(project) ?? 0)
    for (let i = current; i < poolSize; i++) toSpawn.push({ projectSlug: project })
  }
  return { toSpawn, toReap }
}

/**
 * Resolve the branch a claim must re-branch its spare onto, or null when the
 * spare's baked worktree already matches. Pure — the IO (config read,
 * upstream lookup, default-branch probe) lives in the caller.
 *
 * Both sides fall back to the repo's default branch: a create with no
 * explicit branch wants the *current* config default (the spare may have
 * been warmed before the default changed), and a spare with no recorded
 * upstream (the write is guaranteed before tmux exists, so this is
 * effectively unreachable for a claimable spare) is treated as warmed from
 * the default.
 */
export function resolveRebranchTarget(params: {
  requestedBranch: string | undefined
  configReferenceBranch: string | undefined
  spareUpstreamBranch: string | null
  defaultBranch: string
}): string | null {
  const desired = params.requestedBranch ?? params.configReferenceBranch ?? params.defaultBranch
  const spareBranch = params.spareUpstreamBranch ?? params.defaultBranch
  return desired === spareBranch ? null : desired
}

/** Fetch the project's origin into its repo. Same e2e fixture escape hatch
 *  as the cold path (pre-populated bare repos, no reachable remote). */
async function fetchProjectOrigin(projectSlug: string): Promise<void> {
  if (testEnv.e2eSkipFetch) return
  await fetchOrigin(
    repoDir(projectSlug),
    await projectRemoteUrl(projectSlug),
    await resolveProjectCredential(projectSlug),
  )
}

/** How long a claim that keeps its spare's branch waits on its fetch before
 *  handing the spare over on the base it was warmed at instead. */
const REFRESH_FETCH_WAIT_MS = 5_000

/**
 * The tip a claim that keeps its spare's `branch` should bring the spare up
 * to, or null to hand it over as warmed: when `fetched` did not land within
 * the wait, or the spare's branch is already there. Never throws — a refresh
 * is worth a claim only while it is cheap, and none of this is worth falling
 * back to a cold create over.
 */
async function refreshTarget(
  fetched: Promise<void>,
  repo: string,
  branch: string,
  worktreeId: string,
): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined
  try {
    const landed = await Promise.race([
      fetched.then(() => true),
      new Promise<false>((r) => { timer = setTimeout(() => { r(false) }, REFRESH_FETCH_WAIT_MS) }),
    ])
    if (!landed) {
      console.warn(`Claimed session ${worktreeId} kept its warmed base: fetch still running`)
      return null
    }
    const sha = await resolveRemoteRef(repo, branch)
    return sha === await resolveLocalBranch(repo, `agent/${worktreeId}`) ? null : sha
  } catch (err) {
    console.warn(`Claimed session ${worktreeId} kept its warmed base: ${(err as Error).message}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Try to claim a ready prewarmed spare for `(projectSlug, setup, branch)`.
 * Returns the claimed worktree's result (its own id) or `undefined` to fall
 * through to a full cold create. Never throws on infra failures — those
 * degrade to a cold create. The one exception is a VALIDATION error for a
 * requested branch that doesn't exist on origin: it propagates (before any
 * mutation, so the spare is released untouched) because a cold create is
 * doomed to the same user error.
 *
 * Any running spare in the setup's agent mode is claimable, one whose agent
 * already matches the setup first: one warmed on a different reference
 * branch — or on one origin has moved since — is re-branched first
 * (`rebranchSpare`), one booted with a different
 * tool, model or posture is retooled (`retoolSpare`). `claimSpare` is the commit point: a crash after it leaves
 * a normal worktree (no orphaned state); a crash before it leaves the spare
 * reusable — except once re-branch/retool mutations have started, when a
 * failed spare is tainted (worktree, registration, and window names may
 * disagree with what it declares) and is reaped instead of released.
 */
export async function tryClaimPrewarmed(
  projectSlug: string,
  /** The create's own provisioning row, which the claimed spare lists
   *  under until the create resolves. */
  requestId: string,
  /** The fully resolved create: which agent, launched how. */
  setup: CreateSetup,
  emit: (message: string) => void,
  /** What the create asked for beyond the agent: the reference branch, the
   *  opening message, and the sidebar group to file the worktree under. */
  request: { branch?: string; prompt?: string; groupId?: string } = {},
): Promise<WorktreeCreateResult | undefined> {
  const { tool } = setup
  const { branch } = request
  const runtime = worktreeDriver()
  let reserved: string | undefined
  let chosen: RuntimeHandle | undefined
  /** The chosen spare's row as warming left it, for a rollback to restore. */
  let warmed: WorktreeRow | undefined
  let mutated = false
  // Whether this claim inserted a worktree row that a failure must undo. A
  // spare's id is freshly minted and never reused, so the row can only be
  // this claim's.
  let recordedRow = false
  try {
    const workspaces = await runtime.list(projectSlug)
    const spares = workspaces.filter((p) => p.prewarmed && p.running)
    // What each spare's agent was launched with lives on its row (the tool is
    // also on the handle). Read before any reservation, since a reservation
    // must not span an await it does not need.
    const launched = new Map(await Promise.all(spares.map(async (p) =>
      [p.jobName, await getWorktreeRow(projectSlug, p.workspaceId).catch(() => undefined)] as const)))
    const matches = (p: RuntimeHandle): boolean => {
      const row = launched.get(p.jobName)
      return row !== undefined && p.tool === tool && row.model === setup.model
        && row.permissionMode === setup.permissionMode
    }
    const candidates = spares
      // A spare in the other mode cannot be converted: an `acp` pod carries a
      // mount for acpd's records that a `tui` one lacks, and the pod spec is
      // fixed at warm time. (A row older than the column names no mode, and
      // is passed over the same way until the pool replaces it.)
      .filter((p) => launched.get(p.jobName)?.mode === setup.mode)
      // Prefer a spare whose booted agent already matches (skips the
      // respawn), newest first within each group.
      .sort((a, b) =>
        Number(matches(b)) - Number(matches(a))
        || b.createdAtMs - a.createdAtMs)

    for (const c of candidates) {
      if (claiming.has(c.jobName)) continue
      // Reserve synchronously (no await between the check and the add) so a
      // concurrent claim can't pick the same spare.
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
    // Every claim brings its spare to the tip of its base branch, so the
    // fetch starts now, under the transport gate and row writes below, and
    // is awaited where the checkout is prepped. Its failure is observed
    // there; the catch only keeps a claim that gives up first from leaving
    // it unhandled.
    const fetched = fetchProjectOrigin(projectSlug)
    fetched.catch(() => { /* observed below */ })

    // Every in-pod command below this line — re-branch, retool, the git
    // identity re-apply — rides the spare's agent transport, so gate on it
    // once here, before the first mutation. The liveness check above is
    // nearly always proof enough (it is itself an exec), but its verdict is
    // cached for seconds and can be short-circuited by transport health, so
    // it is not a guarantee. This is: it repairs a transport that died
    // since, and on failure aborts while the spare is still untouched, so
    // the claim degrades to a cold create instead of burning the spare.
    await runtime.awaitAgentTransport(chosen.jobName, { timeoutMs: 10_000 })

    // Branch prep: the spare's warmed branch is read from its recorded
    // upstream (`branch.agent/<id>.merge` in the shared /repo/.git/config —
    // written before the tmux session exists, so always present on a
    // claimable spare). No new state: prep's own --set-upstream-to keeps
    // the record current.
    const repo = repoDir(projectSlug)
    const config = await resolveProjectConfig(projectSlug) ?? {}
    const spareUpstreamBranch = await worktreeUpstreamBranch(repo, `agent/${chosen.workspaceId}`)
    const defaultBranch = await getDefaultBranch(repo)
    const rebranchTo = resolveRebranchTarget({
      requestedBranch: branch,
      configReferenceBranch: config.referenceBranch,
      spareUpstreamBranch,
      defaultBranch,
    })

    // Claim the spare's row before the spare is touched: from the moment the
    // claim mutates it, the spare is a worktree, and a worktree still flagged
    // `spare` is invisible to every path that reads recorded state — and
    // worse, reapable. A write failure here aborts the claim before any
    // mutation, so the spare stays a spare and the caller falls back to a
    // cold create.
    //
    // This write is CHECKED, unlike every other one: the startup sweep
    // deletes a checkout on the strength of the flag, so a flip that failed
    // silently would leave the worktree the user is about to be handed
    // looking reapable, and their work would go with it the next time the
    // server started. `claimSpareWorktree` throws rather than shrugging,
    // which is what makes the catch below a fallback rather than a loss.
    const claimedId = chosen.workspaceId
    recordedRow = true
    // Hidden under the create's row before the flip below lists it, so the
    // sidebar never shows the spare beside the row still creating it.
    claimProvisioning(requestId, claimedId)
    // The claim also records what the worktree runs once it is done — the
    // spare's own launch when it matched, the respawn's otherwise — so a
    // restart relaunches it that way. One UPDATE of the row warming
    // inserted: the id was claimed then, and is handed over now.
    await claimSpareWorktree(projectSlug, claimedId, {
      ...(spareUpstreamBranch !== null ? { baseBranch: spareUpstreamBranch } : {}),
      permissionMode: setup.permissionMode,
      mode: setup.mode,
      ...(setup.model !== undefined ? { model: setup.model } : {}),
    })
    // The spare's agent is already running, pinned to its own id — report it
    // as the worktree's first conversation, since that is where the
    // worktree's tool and founding ask are read from. The ask is recorded as
    // a cold create records it, rather than left to be read back once the
    // agent has it: opencode would only give back a title summarizing it.
    // Not under acp: that conversation has no id until its handshake mints
    // one, which is when the registry writes it.
    if (setup.mode === 'tui') {
      await applyWorktreeEvent({
        type: 'sessions-launched',
        projectSlug,
        worktreeId: claimedId,
        sessions: [{
          tool,
          agentSessionId: claimedId,
          ...(setup.model !== undefined ? { model: setup.model } : {}),
          ...(request.prompt !== undefined ? { firstPrompt: request.prompt } : {}),
        }],
      })
    }

    // Branch prep happens here, before the hand-over, because only a spare
    // nobody has prompted yet can have its checkout reset and its agent
    // restarted for free.
    let prep: { branch: string; sha: string } | null = null
    if (rebranchTo !== null) {
      // A re-branch waits out the fetch however long it takes: the target
      // ref must exist and be current.
      await fetched
      if (!(await remoteBranchExists(repo, rebranchTo))) {
        // Pre-mutation user error: propagate instead of burning the spare
        // on a cold create that hits the identical VALIDATION failure.
        const source = branch ? 'the requested branch' : 'referenceBranch in yaac-config.json'
        throw new ServerError(
          'VALIDATION',
          `branch "${rebranchTo}" not found on origin — check ${source}.`,
        )
      }
      prep = { branch: rebranchTo, sha: await resolveRemoteRef(repo, rebranchTo) }
      emit(`Switching prewarmed session to branch ${rebranchTo}...`)
    } else {
      // The spare's own branch, as far as origin has moved it since warming.
      const warmedBranch = spareUpstreamBranch ?? defaultBranch
      const sha = await refreshTarget(fetched, repo, warmedBranch, claimedId)
      if (sha !== null) {
        prep = { branch: warmedBranch, sha }
        emit(`Updating prewarmed session to the latest ${warmedBranch}...`)
      }
    }
    // Re-register, whatever else the claim changes: the registration the
    // spare was warmed with holds the allowlist, proxied-secret rules and
    // remote of that moment, and a project edited since must reach a claimed
    // spare exactly as it would a cold create — a revoked host must not be
    // reachable (the proxy drops the tunnels it no longer admits), nor a
    // newly allowed one stay blocked.
    // Under the claimed tool, since the proxy gates credential injection on
    // it; a retool below respawns the agent to match. The config is read
    // again rather than reused from above: the fetch awaited since can take
    // seconds, and a persisted allow-host click in that window widens this
    // spare's registration, which a stale config would then overwrite.
    const registration = {
      workspaceId: claimedId,
      projectSlug,
      tool,
      config: await resolveProjectConfig(projectSlug) ?? {},
      remoteUrl: await projectRemoteUrl(projectSlug),
      proxySecretRules: Object.fromEntries(
        Object.entries((await resolveProjectEnv(projectSlug)).secrets)
          .map(([name, { rule }]) => [name, rule]),
      ),
    }
    // Under its own tool, a spare left with either registration is still
    // consistent and can go back to the pool; under another, its registration
    // stops matching its agent, and a failure from here taints it.
    if (chosen.tool !== tool) mutated = true
    await runtime.registerWorkspace(registration)

    if (prep !== null) {
      mutated = true
      // The agent read the old checkout at startup, so it is restarted as
      // it was — unless a retool follows, whose respawn supersedes this one.
      await rebranchSpare(chosen, prep.branch, prep.sha, asWarmed ? setup : null)
    }

    if (!asWarmed) {
      if (chosen.tool !== tool) emit(`Switching prewarmed session to ${tool}...`)
      mutated = true
      await retoolSpare(chosen, setup)
    }

    // Commit: the spare stops being one and starts declaring the claimed
    // tool. From here on it is spent either way — a failure past this point
    // must reap it, not release it back to a pool it no longer belongs to.
    // A lost race throws (the spare was already claimed, or is gone), which
    // takes the same fallback-to-cold-create path as any other failure.
    //
    // An acp spare's adapter is told its model at the handshake this commit
    // lets happen, and what it is told was parked in memory when the spare
    // was warmed — which a server restart since has lost. Parked again here,
    // before the watcher can attach, so a spare handed over as warmed still
    // runs the model its row says.
    if (setup.mode === 'acp') parkAcpLaunchModel(tool, claimedId, setup.model)
    await runtime.claimSpare(claimedId, tool)
    mutated = true

    // Re-apply git identity so the server's current setting wins over
    // whatever the spare was warmed with, because a spare's identity is baked
    // at WARM time and nothing re-warms the pool: after a user changes their
    // git identity, the spares already sitting in the pool still hold the old
    // one. Without this, the next claim per project would commit under the
    // stale name, durably.
    //
    // One exec, and non-fatal. This runs PAST the commit point, against a
    // worktree that is already whole, over a transport whose readiness gate
    // may be minutes old by now (a re-branch fetches and resets in between).
    // A hiccup here would otherwise reap a perfectly good claimed worktree
    // over a step that is a correction, not a prerequisite — the spare's
    // warmed-in identity stands and the claim is still good.
    const claimIdentity = await getGitIdentity()
    if (claimIdentity) {
      await runtime.exec(
        chosen.jobName,
        `git config --global user.name '${shellEscape(claimIdentity.name)}'`
        + ` && git config --global user.email '${shellEscape(claimIdentity.email)}'`,
      ).catch((err: unknown) => {
        console.warn(
          `Git identity for claimed session ${claimedId} not applied `
          + `(the warmed-in one stands): ${(err as Error).message}`,
        )
      })
    }

    // A claim that moved the spare to another branch reports the branch it
    // ended on, not the one it was warmed from.
    if (rebranchTo !== null) {
      await applyWorktreeEvent({
        type: 'base-branch-resolved',
        projectSlug,
        worktreeId: chosen.workspaceId,
        baseBranch: rebranchTo,
      })
    }

    // Filed before the create's row stops hiding it, and — like the identity
    // above — a correction, not a prerequisite. The one way it fails that a
    // retry would not repeat is the group having been deleted since the route
    // resolved it, and a cold create would fail on that too, after this claim
    // had burned a good spare. So the worktree lands ungrouped instead.
    if (request.groupId !== undefined) {
      await setWorktreeGroup(projectSlug, claimedId, request.groupId).catch((err: unknown) => {
        console.warn(
          `Claimed session ${claimedId} not filed in group ${request.groupId ?? ''}: `
          + (err as Error).message,
        )
      })
    }

    emit('Using prewarmed session...')
    // An acp spare's adapter has been waiting with no client: the watcher the
    // claim just unhid it to attaches now, and the handshake mints the
    // conversation. Handed over exactly as a fresh create's agent is — held
    // for its row, so the worktree opens on its chat pane rather than acpd's
    // log, then given the prompt its agent booted without.
    await handOverAgent({
      projectSlug,
      worktreeId: claimedId,
      jobName: chosen.jobName,
      tool,
      mode: setup.mode,
      ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
      emit,
    })
    return { worktreeId: chosen.workspaceId, jobName: chosen.jobName, tool, mode: setup.mode, forwardedPorts: [] }
  } catch (err) {
    // A pre-mutation VALIDATION error (unknown branch) is the user's to
    // see — a cold create would fail identically, so don't degrade to one.
    // Decided here but rethrown at the BOTTOM: the row has already been
    // claimed by this point, and propagating before undoing that would
    // leave a spare the runtime still reports as pooled but whose row says
    // it is somebody's worktree — reapable as neither, and eventually a
    // phantom `never-started` stop pointing at a deleted checkout.
    const propagate = !mutated && err instanceof ServerError && err.code === 'VALIDATION'
    // Any other failure (runtime unreachable, claim race lost) → cold
    // create. A spare that failed mid-retool/re-branch is tainted — reap it
    // so a later claim can't pick up its inconsistent state; the reconciler
    // warms a fresh one. Keep the reservation (jobNames are never reused,
    // so the leaked entry is inert) so a concurrent claim can't grab the
    // dying spare before the teardown lands.
    //
    // Everything the spare left goes, in the reap path's order
    // (prewarm-reconcile.ts): runtime, then checkout, then row. The checkout has
    // to be removed here at all because the claim cleared the `spare` flag
    // before it mutated anything, putting these bytes beyond the startup
    // sweep that collects a dead spare's checkout on the strength of it.
    //
    // Each step gates the next on having actually happened, because each one
    // destroys the evidence the one before it relied on. `cleanupWorktree`
    // resolves false when the runtime could not be confirmed gone — and one
    // still shutting down is still writing to /workspace, so the checkout
    // stays. `deleteWorktreeState` resolves false
    // when an rm failed, and then the row stays: the row is the last name
    // these bytes have, so erasing it over a failed rm is exactly how a
    // retryable leftover becomes a permanent one. Whatever is left in either
    // case keeps its row and reaches the user as an ordinary stopped
    // worktree, via the stale reaper.
    //
    // The row erase is the same one any failed create does: the claim never
    // completed, so the row describes a worktree that never existed, and a
    // claim is always a fresh worktree, never a resume. Unawaited as a whole,
    // so the caller degrades to a cold create immediately — the row can
    // therefore linger, marked terminating, for as long as the teardown runs.
    if (chosen && mutated) {
      const { jobName, projectSlug: slug, workspaceId: worktreeId } = chosen
      void cleanupWorktree({ jobName, projectSlug: slug, worktreeId })
        .then((gone) => gone && deleteWorktreeState(slug, worktreeId))
        .then((removed) => (removed && recordedRow
          ? applyWorktreeEvent({ type: 'worktree-create-failed', projectSlug, worktreeId })
          : undefined))
        .catch(() => { /* best-effort; the stale-session reaper retries */ })
      reserved = undefined
    } else if (warmed && recordedRow) {
      // An untouched spare is still a perfectly good spare — putting its row
      // back returns it to the pool rather than stranding a spare whose row no
      // longer says it is reapable.
      try {
        await restoreSpareWorktree(warmed)
      } catch {
        // Best-effort; the row has nothing running behind it either way.
      }
    }
    // The cold create that follows lists under the create's own id.
    if (recordedRow) claimProvisioning(requestId, undefined)
    if (propagate) throw err
    return undefined
  } finally {
    if (reserved) claiming.delete(reserved)
  }
}
