/**
 * Reconcile step that keeps every project's image chain built and
 * pushed, so session create finds warm images instead of paying a podman
 * build (minutes after a Dockerfile.default edit) inside the create request.
 *
 * Each tick sweeps all projects and fires one detached prewarm task per
 * project not already in flight — the tick body itself never blocks on a
 * build. Concurrent chains coalesce per-tag in the build coordinator:
 * two projects needing the same base wait on one build, then their distinct
 * downstream layers build in parallel.
 *
 * Runs in nested yaac sessions too — in-pod podman builds are slower, but
 * that's exactly when proactive building pays off (editing dockerfiles from
 * inside a yaac-in-yaac dev session is the hot path), and the coordinator's
 * single-flight dedup means a session create just joins the sweep's build.
 * Skipped in e2e (images are prebuilt by the global setup; workers must
 * never race a build).
 */
import { listProjects, resolveProjectConfig } from '#features/projects'
import { resolveImageChain } from './image-builder'
import { ensureImage, pushImageShared } from './build-coordinator'
import { forgetImageBuild, getImageBuild, hasBlockingFailure } from './image-builds'
import { proxyClient } from '#features/sessions/egress/proxy-client'
import { serverLog } from '#log'
import { env, testEnv } from '@yaac/shared/env'

/** How long a failed chain build blocks the sweep from retrying. Hitting
 *  retry in the webapp (which forgets the failed entry) or editing the
 *  Dockerfile (which changes the tag) re-enables the sweep immediately;
 *  dismissing the row does not; session creates always bypass it. */
const FAILED_RETRY_MS = 10 * 60_000

/** Min interval between full sweeps. A warm-project sweep is cheap but not
 *  free — one detached task per project, each running a handful of podman
 *  inspects plus a registry HEAD — and at the 5s tick cadence that steady
 *  child-process churn was a measurable slice of server CPU. A minute
 *  bounds how long a Dockerfile edit or an externally pruned image waits
 *  for the sweep; session creates bypass the sweep and build immediately. */
export const PREWARM_SWEEP_INTERVAL_MS = 60_000

/** Projects with a prewarm task in flight; added synchronously before the
 *  task's first await so a concurrent tick can't double-fire. */
const prewarming = new Set<string>()

let lastSweepMs = 0

/** Ensure one project's chain is built and its final tag pushed. No-op when
 *  everything is warm (a handful of `podman image inspect`s + one registry
 *  HEAD), so an externally pruned image self-heals within a tick. */
export async function prewarmProjectImage(projectSlug: string): Promise<void> {
  const config = await resolveProjectConfig(projectSlug) ?? {}
  const nestedContainers = config.nestedContainers === true || config.virtualCluster === true
  const prefix = testEnv.imagePrefix ?? 'yaac'

  const { layers, finalTag } = await resolveImageChain(projectSlug, prefix, nestedContainers)
  if (hasBlockingFailure([...layers.map((l) => l.tag), finalTag], FAILED_RETRY_MS)) return

  await ensureImage(projectSlug, testEnv.imagePrefix, false, nestedContainers, {
    reason: 'prewarm',
  })
  await pushImageShared(finalTag, { projectSlug, reason: 'prewarm' })
}

/**
 * Sweep all projects once, firing detached prewarm tasks. Best-effort: a
 * failure logs, marks the chain for backoff via its build entry, and the
 * next eligible tick retries. Throttled to PREWARM_SWEEP_INTERVAL_MS.
 */
export async function reconcileImagePrewarm(nowMs: number = Date.now()): Promise<void> {
  if (!env.imagePrewarm) return
  if (testEnv.requirePrebuiltImages) return
  if (nowMs - lastSweepMs < PREWARM_SWEEP_INTERVAL_MS) return
  lastSweepMs = nowMs

  let projects
  try {
    projects = await listProjects()
  } catch {
    return
  }

  for (const project of projects) {
    if (prewarming.has(project.slug)) continue
    prewarming.add(project.slug)
    void prewarmProjectImage(project.slug)
      .catch((err: unknown) => {
        serverLog(`[image-prewarm] ${project.slug}: ${String(err)}`)
      })
      .finally(() => prewarming.delete(project.slug))
  }
}

/** Test helper: forget in-flight prewarm marks and the sweep throttle. */
export function _resetImagePrewarmForTests(): void {
  prewarming.clear()
  lastSweepMs = 0
}

/**
 * Explicit retry of a finished image build, driving the webapp's "Retry"
 * action. Dismissing a failed row only hides it (and keeps backing off the
 * prewarm sweep); retry is the deliberate "rebuild now" path.
 *
 * It forgets the tracked entry — so its failure stops gating
 * `hasBlockingFailure` — then re-triggers the build the row stood for: the
 * owning project's chain (via `prewarmProjectImage`, which the coordinator
 * single-flights and de-dups against any in-flight build), or the shared
 * proxy sidecar for an infrastructure build with no owning project. The
 * rebuild registers its own fresh entry, so the "building" row reappears.
 *
 * Returns false when the id is unknown or still running (nothing to retry);
 * otherwise forgets the entry and fires the rebuild in the background,
 * returning true. Fire-and-forget: the rebuild owns its own registry entry
 * and error logging.
 */
export function retryImageBuild(id: string): boolean {
  const entry = getImageBuild(id)
  if (!entry || entry.status === 'running') return false
  forgetImageBuild(id)

  if (entry.projectSlugs.length > 0) {
    for (const slug of entry.projectSlugs) {
      void prewarmProjectImage(slug).catch((err: unknown) =>
        serverLog(`[image-retry] ${slug}: ${String(err)}`))
    }
  } else {
    // No owning project: the shared proxy sidecar. Re-running ensureRunning
    // rebuilds its image when the tag is missing (which a failed build left).
    void proxyClient.ensureRunning().catch((err: unknown) =>
      serverLog(`[image-retry] proxy: ${String(err)}`))
  }
  return true
}
