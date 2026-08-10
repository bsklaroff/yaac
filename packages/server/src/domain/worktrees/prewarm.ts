/**
 * Prewarmed-worktree pool: claim logic + the pure planner + the in-memory
 * state shared between the claim path (the create route) and the reconcile
 * loop (`packages/server/src/prewarm-reconcile.ts`).
 *
 * A prewarmed spare is a fully-provisioned worktree whose agent is booted and
 * waiting, stamped with the `yaac.prewarmed` pod label and hidden from
 * user-facing views. The reconciler keeps one spare per active project (see
 * the plan); a `worktree create` "claims" a spare by removing the label and
 * attaching — skipping all provisioning. A spare's identity (jobName, labels,
 * worktree, mounts) is baked at warm time and can't be re-keyed, so a claim
 * returns the spare's own id; the CLI and webapp adopt it.
 *
 * Spares are tool-agnostic: warm-time provisioning seeds every tool's config
 * and env placeholders, so a claim for a different tool than the one booted
 * just retools the spare (proxy re-registration + agent respawn + label
 * flip) instead of falling back to a cold create. The booted tool — the
 * configured default at warm time — is recorded in the `yaac.tool` label so
 * matching claims stay instant.
 *
 * Spares are branch-agnostic the same way: one warmed on a different
 * reference branch is re-branched at claim time (`rebranchSpare` — worktree
 * reset + upstream rewrite + window respawns), so any spare serves any
 * branch and a changed project default never invalidates the pool.
 *
 * The server is a single process (lock-file enforced), so module-level state
 * is sufficient mutual exclusion — no kubernetes optimistic concurrency.
 */
import simpleGit from 'simple-git'
import {
  LABEL_PREWARMED,
  LABEL_TOOL,
  type PodInfo,
  isPrewarmed,
  k8sNamespace,
  kubectlWithRetry,
  listWorktreePods,
  podExec,
  waitForStreamd,
} from '#platform/k8s'
import { cleanupWorktree, deleteWorktreeState } from './cleanup'
import { applyWorktreeEvent } from '#records'
import { rebranchSpare, retoolSpare } from './spare-pool'
import { claimSpareWorktree, restoreSpareWorktree } from '#records'
import type { WorktreeCreateResult } from './create'
import { isTmuxSessionAlive } from '#runtime/status'
import { fetchOrigin, getDefaultBranch, remoteBranchExists, worktreeUpstreamBranch } from '#platform/git'
import { resolveCredentialForUrl, resolveProjectConfig } from '#store/projects'
import { shellEscape } from '#platform/shell'
import { repoDir } from '@yaac/shared/project-paths'
import { ServerError } from '@yaac/shared/errors'
import { testEnv } from '@yaac/shared/env'
import type { AgentTool } from '@yaac/shared/types'

/**
 * jobNames of spares currently being claimed. A claim reserves its target
 * here (synchronously, before any await) so a concurrent claim can't grab the
 * same pod and the reconciler never reaps a pod out from under a claim.
 */
export const claiming = new Set<string>()

/**
 * In-flight prewarm spawns, keyed by projectSlug → count. `createWorktree`
 * only applies the Job near the very end, so a spawn is invisible to
 * `listWorktreePods` for seconds; counting it here stops successive ticks from
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
  tool: AgentTool
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
 * Pure planner: given the current worktree pods and the desired pool size +
 * default tool, decide which spares to spawn and which to reap. No side
 * effects (mirrors `classifyWorktreePods`) so the policy is unit-testable
 * without a cluster.
 *
 * - "claimed" = running, non-prewarmed pods (the real user worktrees).
 * - "spares" = prewarmed pods (any phase, so a still-pulling spare counts),
 *   minus any jobName currently being claimed (never spawn against / reap one
 *   mid-claim).
 * - A project with ≥1 claimed worktree wants `poolSize` spares: spawn to fill
 *   (counting in-flight so we don't stampede) with `defaultTool` booted, and
 *   reap genuine excess. Spares are tool-agnostic — one warmed with a
 *   different tool (e.g. after a `tool set`) is retooled at claim time, so
 *   it still counts toward the pool and is never reaped for its tool.
 * - A project with 0 claimed worktrees drains all its spares.
 */
export function computePrewarmPlan(
  pods: PodInfo[],
  poolSize: number,
  defaultTool: AgentTool,
  inFlightCounts: Map<string, number>,
  claimingJobNames: Set<string>,
): PrewarmPlan {
  const claimedByProject = new Map<string, number>()
  const sparesByProject = new Map<string, PodInfo[]>()
  for (const p of pods) {
    if (!p.projectSlug) continue
    if (isPrewarmed(p)) {
      if (claimingJobNames.has(p.jobName)) continue
      const arr = sparesByProject.get(p.projectSlug)
      if (arr) arr.push(p)
      else sparesByProject.set(p.projectSlug, [p])
    } else if (p.running) {
      claimedByProject.set(p.projectSlug, (claimedByProject.get(p.projectSlug) ?? 0) + 1)
    }
  }

  const toSpawn: PrewarmSpawn[] = []
  const toReap: PrewarmReapTarget[] = []
  const reap = (p: PodInfo): void => {
    toReap.push({ jobName: p.jobName, projectSlug: p.projectSlug, worktreeId: p.worktreeId })
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
    for (let i = current; i < poolSize; i++) toSpawn.push({ projectSlug: project, tool: defaultTool })
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

/**
 * Try to claim a ready prewarmed spare for `(projectSlug, tool, branch)`.
 * Returns the claimed worktree's result (its own id) or `undefined` to fall
 * through to a full cold create. Never throws on infra failures — those
 * degrade to a cold create. The one exception is a VALIDATION error for a
 * requested branch that doesn't exist on origin: it propagates (before any
 * mutation, so the spare is released untouched) because a cold create is
 * doomed to the same user error.
 *
 * Spares are tool- and branch-agnostic, so any running spare is claimable:
 * one warmed on a different reference branch is re-branched first
 * (`rebranchSpare`), one booted with a different tool is retooled
 * (`retoolSpare`). The label call is the commit point: a crash after it
 * leaves a normal worktree (no orphaned state); a crash before it leaves the
 * spare reusable — except once re-branch/retool mutations have started, when
 * a failed spare is tainted (worktree, registration, window names, and label
 * may disagree) and is reaped instead of released.
 */
export async function tryClaimPrewarmed(
  projectSlug: string,
  tool: AgentTool,
  gitUser: { name: string; email: string } | undefined,
  emit: (message: string) => void,
  branch?: string,
  /** Model override for the agent's launch command. Spares boot their
   *  agent with no model flag, so a model override always respawns the
   *  claimed spare's agent (via retoolSpare, even when the booted tool
   *  already matches). */
  model?: string,
): Promise<WorktreeCreateResult | undefined> {
  let reserved: string | undefined
  let chosen: PodInfo | undefined
  let mutated = false
  // Whether this claim inserted a worktree row that a failure must undo. A
  // spare's id is freshly minted and never reused, so the row can only be
  // this claim's.
  let recordedRow = false
  try {
    const pods = await listWorktreePods(projectSlug)
    const candidates = pods
      .filter((p) => isPrewarmed(p) && p.running)
      // Prefer a spare whose booted agent already matches (skips the
      // respawn), newest first within each group.
      .sort((a, b) =>
        Number(b.tool === tool) - Number(a.tool === tool)
        || b.createdAtMs - a.createdAtMs)

    for (const c of candidates) {
      if (claiming.has(c.jobName)) continue
      // Reserve synchronously (no await between the check and the add) so a
      // concurrent claim can't pick the same pod.
      claiming.add(c.jobName)
      reserved = c.jobName
      if (await isTmuxSessionAlive(c.projectSlug, c.worktreeId)) {
        chosen = c
        break
      }
      // Stuck spare (tmux never came up): release it for the reaper.
      claiming.delete(c.jobName)
      reserved = undefined
    }
    if (!chosen) return undefined

    // Every in-pod command below this line — re-branch, retool, the git
    // identity re-apply — rides the spare's streamd over the relay, so gate
    // on it once here, before the first mutation. The liveness check above
    // is nearly always proof enough (it is itself a relay exec), but its
    // verdict is cached for seconds and can be short-circuited by stream
    // health, so it is not a guarantee. This is: it re-boots a streamd that
    // died since (the same kubectl-exec self-heal the status watcher uses),
    // and on failure aborts while the spare is still untouched, so the
    // claim degrades to a cold create instead of burning the spare.
    await waitForStreamd(chosen.jobName, { timeoutMs: 10_000 })

    // Branch prep: the spare's warmed branch is read from its recorded
    // upstream (`branch.agent/<id>.merge` in the shared /repo/.git/config —
    // written before the tmux session exists, so always present on a
    // claimable spare). No new state: prep's own --set-upstream-to keeps
    // the record current.
    const repo = repoDir(projectSlug)
    const config = await resolveProjectConfig(projectSlug) ?? {}
    const spareUpstreamBranch = await worktreeUpstreamBranch(repo, `agent/${chosen.worktreeId}`)
    const rebranchTo = resolveRebranchTarget({
      requestedBranch: branch,
      configReferenceBranch: config.referenceBranch,
      spareUpstreamBranch,
      defaultBranch: await getDefaultBranch(repo),
    })

    // Claim the spare's row before the spare is touched: from the moment the
    // claim mutates it, the pod is a worktree, and a worktree still flagged
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
    const claimedId = chosen.worktreeId
    recordedRow = true
    await claimSpareWorktree(
      projectSlug,
      claimedId,
      spareUpstreamBranch !== null ? spareUpstreamBranch : undefined,
    )
    // Now that it is a worktree, record it as created: warming inserted the
    // row, but the live fields (no stop, no death) belong to the life the
    // claimant is about to be handed.
    await applyWorktreeEvent({
      type: 'worktree-created',
      projectSlug,
      worktreeId: claimedId,
      ...(spareUpstreamBranch !== null ? { baseBranch: spareUpstreamBranch } : {}),
    })
    // The spare's agent is already running, pinned to its own id — report it
    // as the worktree's first conversation, since that is where the
    // worktree's tool is read from.
    await applyWorktreeEvent({
      type: 'sessions-launched',
      projectSlug,
      worktreeId: claimedId,
      sessions: [{ tool, agentSessionId: claimedId }],
    })

    if (rebranchTo !== null) {
      // The claim path is otherwise zero-network; a re-branch must fetch so
      // the target ref exists and is current. Same e2e fixture escape hatch
      // as the cold path (pre-populated bare repos, no reachable remote).
      if (!testEnv.e2eSkipFetch) {
        const remoteUrl = (await simpleGit(repo).remote(['get-url', 'origin']))?.trim() ?? ''
        await fetchOrigin(repo, await resolveCredentialForUrl(remoteUrl))
      }
      if (!(await remoteBranchExists(repo, rebranchTo))) {
        // Pre-mutation user error: propagate instead of burning the spare
        // on a cold create that hits the identical VALIDATION failure.
        const source = branch ? 'the requested branch' : 'referenceBranch in yaac-config.json'
        throw new ServerError(
          'VALIDATION',
          `branch "${rebranchTo}" not found on origin — check ${source}.`,
        )
      }
      const sha = (await simpleGit(repo).revparse([`refs/remotes/origin/${rebranchTo}`])).trim()
      emit(`Switching prewarmed session to branch ${rebranchTo}...`)
      mutated = true
      // Skip the agent respawn when a retool follows — its respawn (with
      // the new tool, and any model override) supersedes it.
      await rebranchSpare(chosen, rebranchTo, sha, chosen.tool === tool && model === undefined)
    }

    if (chosen.tool !== tool || model !== undefined) {
      if (chosen.tool !== tool) emit(`Switching prewarmed session to ${tool}...`)
      mutated = true
      await retoolSpare(chosen, tool, model)
    }

    // Commit: drop the prewarmed label (stamping the new tool in the same
    // call when retooled), flipping the pod to a normal worktree. From here
    // on the spare is spent either way — a failure past this point must reap
    // it, not release it back to a pool it no longer belongs to.
    await kubectlWithRetry([
      'label', 'pod', chosen.podName, '-n', k8sNamespace(), `${LABEL_PREWARMED}-`,
      ...(chosen.tool !== tool ? [`${LABEL_TOOL}=${tool}`, '--overwrite'] : []),
    ])
    mutated = true

    // Re-apply git identity so the claiming user's identity wins over the
    // server-global one the spare was warmed with. Skipped when the caller
    // (e.g. the webapp) sends no identity — the warmed-in global is correct.
    //
    // One exec, and non-fatal. This runs PAST the commit point, against a
    // worktree that is already whole, over a relay whose readiness gate may
    // be minutes old by now (a re-branch fetches and resets in between). A
    // hiccup here would otherwise reap a perfectly good claimed worktree
    // over a step the no-identity path skips outright.
    if (gitUser) {
      const { worktreeId: claimedId } = chosen
      await podExec(
        chosen.jobName,
        `git config --global user.name '${shellEscape(gitUser.name)}'`
        + ` && git config --global user.email '${shellEscape(gitUser.email)}'`,
      ).catch((err: unknown) => {
        console.warn(
          `Git identity for claimed session ${claimedId} not applied `
          + `(the warmed-in global stands): ${(err as Error).message}`,
        )
      })
    }

    // A claim that moved the spare to another branch reports the branch it
    // ended on, not the one it was warmed from.
    if (rebranchTo !== null) {
      await applyWorktreeEvent({
        type: 'base-branch-resolved',
        projectSlug,
        worktreeId: chosen.worktreeId,
        baseBranch: rebranchTo,
      })
    }

    emit('Using prewarmed session...')
    // Always tui: spares are warmed with a TUI agent window, which is exactly
    // why the route refuses to let an acp create claim one.
    return { worktreeId: chosen.worktreeId, jobName: chosen.jobName, tool, mode: 'tui', forwardedPorts: [] }
  } catch (err) {
    // A pre-mutation VALIDATION error (unknown branch) is the user's to
    // see — a cold create would fail identically, so don't degrade to one.
    // Decided here but rethrown at the BOTTOM: the row has already been
    // claimed by this point, and propagating before undoing that would
    // leave a spare whose pod is still labeled and pooled but whose row says
    // it is somebody's worktree — reapable as neither, and eventually a
    // phantom `never-started` stop pointing at a deleted checkout.
    const propagate = !mutated && err instanceof ServerError && err.code === 'VALIDATION'
    // Any other failure (cluster unreachable, label race lost) → cold
    // create. A spare that failed mid-retool/re-branch is tainted — reap it
    // so a later claim can't pick up its inconsistent state; the reconciler
    // warms a fresh one. Keep the reservation (jobNames are never reused,
    // so the leaked entry is inert) so a concurrent claim can't grab the
    // dying pod before the teardown lands.
    //
    // Everything the spare left goes, in the reap path's order
    // (prewarm-reconcile.ts): pod, then checkout, then row. The checkout has
    // to be removed here at all because the claim cleared the `spare` flag
    // before it mutated anything, putting these bytes beyond the startup
    // sweep that collects a dead spare's checkout on the strength of it.
    //
    // Each step gates the next on having actually happened, because each one
    // destroys the evidence the one before it relied on. `cleanupWorktree`
    // resolves false when its delete timed out with the pod still
    // terminating — and a pod in its grace period is still writing to
    // /workspace, so the checkout stays. `deleteWorktreeState` resolves false
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
      const { jobName, projectSlug: slug, worktreeId } = chosen
      void cleanupWorktree({ jobName, projectSlug: slug, worktreeId })
        .then((podGone) => podGone && deleteWorktreeState(slug, worktreeId))
        .then((removed) => (removed && recordedRow
          ? applyWorktreeEvent({ type: 'worktree-create-failed', projectSlug, worktreeId })
          : undefined))
        .catch(() => { /* best-effort; the stale-session reaper retries */ })
      reserved = undefined
    } else if (chosen && recordedRow) {
      // An untouched spare is still a perfectly good spare — putting the flag
      // back returns it to the pool rather than stranding a pod whose row no
      // longer says it is reapable.
      try {
        await restoreSpareWorktree(projectSlug, chosen.worktreeId)
      } catch {
        // Best-effort; the row has no pod to back it either way.
      }
    }
    if (propagate) throw err
    return undefined
  } finally {
    if (reserved) claiming.delete(reserved)
  }
}
