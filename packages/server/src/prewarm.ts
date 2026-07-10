/**
 * Prewarmed-session pool: claim logic + the pure planner + the in-memory
 * state shared between the claim path (the create route) and the reconcile
 * loop (`packages/server/src/prewarm-reconcile.ts`).
 *
 * A prewarmed spare is a fully-provisioned session whose agent is booted and
 * waiting, stamped with the `yaac.prewarmed` pod label and hidden from
 * user-facing views. The reconciler keeps one spare per active project (see
 * the plan); a `session create` "claims" a spare by removing the label and
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
 * The server is a single process (lock-file enforced), so module-level state
 * is sufficient mutual exclusion — no kubernetes optimistic concurrency.
 */
import { containerExec } from '#lib/k8s/exec'
import { k8sNamespace, kubectlWithRetry } from '#lib/k8s/kubectl'
import { LABEL_PREWARMED, LABEL_TOOL, isPrewarmed, listSessionPods, type SessionPod } from '#lib/k8s/pods'
import { cleanupSessionDetached, isTmuxSessionAlive } from '#lib/session/cleanup'
import { retoolSpare, shellEscape, type SessionCreateResult } from '#session-create'
import type { AgentTool } from '@yaac/shared/types'

/**
 * jobNames of spares currently being claimed. A claim reserves its target
 * here (synchronously, before any await) so a concurrent claim can't grab the
 * same pod and the reconciler never reaps a pod out from under a claim.
 */
export const claiming = new Set<string>()

/**
 * In-flight prewarm spawns, keyed by projectSlug → count. `createSession`
 * only applies the Job near the very end, so a spawn is invisible to
 * `listSessionPods` for seconds; counting it here stops successive ticks from
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
  sessionId: string
}

export interface PrewarmPlan {
  toSpawn: PrewarmSpawn[]
  toReap: PrewarmReapTarget[]
}

/**
 * Pure planner: given the current session pods and the desired pool size +
 * default tool, decide which spares to spawn and which to reap. No side
 * effects (mirrors `classifySessionPods`) so the policy is unit-testable
 * without a cluster.
 *
 * - "claimed" = running, non-prewarmed pods (the real user sessions).
 * - "spares" = prewarmed pods (any phase, so a still-pulling spare counts),
 *   minus any jobName currently being claimed (never spawn against / reap one
 *   mid-claim).
 * - A project with ≥1 claimed session wants `poolSize` spares: spawn to fill
 *   (counting in-flight so we don't stampede) with `defaultTool` booted, and
 *   reap genuine excess. Spares are tool-agnostic — one warmed with a
 *   different tool (e.g. after a `tool set`) is retooled at claim time, so
 *   it still counts toward the pool and is never reaped for its tool.
 * - A project with 0 claimed sessions drains all its spares.
 */
export function computePrewarmPlan(
  pods: SessionPod[],
  poolSize: number,
  defaultTool: AgentTool,
  inFlightCounts: Map<string, number>,
  claimingJobNames: Set<string>,
): PrewarmPlan {
  const claimedByProject = new Map<string, number>()
  const sparesByProject = new Map<string, SessionPod[]>()
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
  const reap = (p: SessionPod): void => {
    toReap.push({ jobName: p.jobName, projectSlug: p.projectSlug, sessionId: p.sessionId })
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
 * Try to claim a ready prewarmed spare for `(projectSlug, tool)`. Returns the
 * claimed session's result (its own id) or `undefined` to fall through to a
 * full cold create. Never throws — any failure degrades to a cold create.
 *
 * Spares are tool-agnostic, so any running spare is claimable; one booted
 * with a different tool is retooled first (`retoolSpare`). The label call is
 * the commit point: a crash after it leaves a normal session (no orphaned
 * state); a crash before it leaves the spare reusable — except once retool
 * mutations have started, when a failed spare is tainted (registration,
 * window name, and label may disagree) and is reaped instead of released.
 */
export async function tryClaimPrewarmed(
  projectSlug: string,
  tool: AgentTool,
  gitUser: { name: string; email: string } | undefined,
  emit: (message: string) => void,
): Promise<SessionCreateResult | undefined> {
  let reserved: string | undefined
  let chosen: SessionPod | undefined
  let mutated = false
  try {
    const pods = await listSessionPods(projectSlug)
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
      if (await isTmuxSessionAlive(c.projectSlug, c.sessionId)) {
        chosen = c
        break
      }
      // Stuck spare (tmux never came up): release it for the reaper.
      claiming.delete(c.jobName)
      reserved = undefined
    }
    if (!chosen) return undefined

    if (chosen.tool !== tool) {
      emit(`Switching prewarmed session to ${tool}...`)
      mutated = true
      await retoolSpare(chosen, tool)
    }

    // Commit: drop the prewarmed label (stamping the new tool in the same
    // call when retooled), flipping the pod to a normal session.
    await kubectlWithRetry([
      'label', 'pod', chosen.podName, '-n', k8sNamespace(), `${LABEL_PREWARMED}-`,
      ...(chosen.tool !== tool ? [`${LABEL_TOOL}=${tool}`, '--overwrite'] : []),
    ])

    // Re-apply git identity so the claiming user's identity wins over the
    // server-global one the spare was warmed with. Skipped when the caller
    // (e.g. the webapp) sends no identity — the warmed-in global is correct.
    if (gitUser) {
      await containerExec(chosen.jobName, `git config --global user.name '${shellEscape(gitUser.name)}'`)
      await containerExec(chosen.jobName, `git config --global user.email '${shellEscape(gitUser.email)}'`)
    }

    emit('Using prewarmed session...')
    return { sessionId: chosen.sessionId, jobName: chosen.jobName, tool, forwardedPorts: [] }
  } catch {
    // Any failure (cluster unreachable, label race lost) → cold create. A
    // spare that failed mid-retool is tainted — reap it so a later claim
    // can't pick up its inconsistent state; the reconciler warms a fresh
    // one. Keep the reservation (jobNames are never reused, so the leaked
    // entry is inert) so a concurrent claim can't grab the dying pod before
    // the detached teardown lands.
    if (chosen && mutated) {
      const { jobName, projectSlug: slug, sessionId } = chosen
      cleanupSessionDetached({ jobName, projectSlug: slug, sessionId })
        .catch(() => { /* best-effort; the stale-session reaper retries */ })
      reserved = undefined
    }
    return undefined
  } finally {
    if (reserved) claiming.delete(reserved)
  }
}
