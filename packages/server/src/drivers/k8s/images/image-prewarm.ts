/**
 * Reconcile step that keeps every project's image chain built and
 * pushed, so worktree create finds warm images instead of paying a builder
 * pod (minutes after a Dockerfile.yaac edit) inside the create request.
 *
 * Each tick sweeps all projects and fires one detached prewarm task per
 * project not already in flight — the tick body itself never blocks on a
 * build. Concurrent chains coalesce per-tag in the build coordinator:
 * two projects needing the same base wait on one build, then their distinct
 * downstream layers build in parallel.
 *
 * The coordinator's single-flight dedup means a worktree create just joins
 * the sweep's build rather than starting a second one.
 * Skipped in e2e (images are prebuilt by the global setup; workers must
 * never race a build).
 */
import { ensureImage, pushImageShared } from './build-coordinator'
import { proxyClient } from '#drivers/k8s/egress'
import { serverLog } from '#log'
import { env, testEnv } from '@yaac/shared/env'
import type { YaacConfig } from '@yaac/shared/types'
import {
  forgetImageBuild,
  getImageBuild,
  hasBlockingFailure,
  resolveImageChain,
} from '#drivers/k8s/image-engine'

/** How long a failed chain build blocks the sweep from retrying. Hitting
 *  retry in the webapp (which forgets the failed entry) or editing the
 *  Dockerfile (which changes the tag) re-enables the sweep immediately;
 *  dismissing the row does not; worktree creates always bypass it. */
const FAILED_RETRY_MS = 10 * 60_000

/** Min interval between full sweeps. A warm-project sweep is cheap but not
 *  free — one detached task per project, each running a registry HEAD per
 *  layer — and at the 5s tick cadence that steady churn was a measurable
 *  slice of server CPU. A minute
 *  bounds how long a Dockerfile edit or an externally pruned image waits
 *  for the sweep; worktree creates bypass the sweep and build immediately. */
export const PREWARM_SWEEP_INTERVAL_MS = 60_000

/** Projects with a prewarm task in flight; added synchronously before the
 *  task's first await so a concurrent tick can't double-fire. */
const prewarming = new Set<string>()

let lastSweepMs = 0

/** Ensure one project's chain is built and its final tag pushed. No-op when
 *  everything is warm (a handful of registry HEADs), so an image pruned out
 *  from under the install self-heals within a tick — or, for a yaac-shipped
 *  layer, surfaces the error naming `yaac cluster install`.
 *
 *  WHICH chain a project should keep warm follows from its config, which is
 *  the caller's to resolve — the pass hands it down (`ctx.projectConfig`),
 *  as it does the project list.
 *
 *  `config` is required, with no default, deliberately: an omitted one would
 *  build the all-defaults chain and SUCCEED at it, which for a
 *  nestedContainers project means a chain missing its nestable layer. A
 *  caller writing `{}` is making that call; a caller who forgot should not
 *  compile. */
export async function prewarmProjectImage(
  projectSlug: string,
  config: YaacConfig,
): Promise<void> {
  const nestedContainers = config.nestedContainers === true
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
export function reconcileImagePrewarm(
  projectSlugs: string[],
  projectConfig: (slug: string) => Promise<YaacConfig | undefined>,
  nowMs: number = Date.now(),
): void {
  if (!env.imagePrewarm) return
  if (testEnv.requirePrebuiltImages) return
  if (nowMs - lastSweepMs < PREWARM_SWEEP_INTERVAL_MS) return
  lastSweepMs = nowMs

  for (const slug of projectSlugs) {
    if (prewarming.has(slug)) continue
    prewarming.add(slug)
    void projectConfig(slug)
      .then((config) => prewarmProjectImage(slug, config ?? {}))
      .catch((err: unknown) => {
        serverLog(`[image-prewarm] ${slug}: ${String(err)}`)
      })
      .finally(() => prewarming.delete(slug))
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
 * owning project's chain, via `prewarmProjectImage`, which the coordinator
 * single-flights and de-dups against any in-flight build. The rebuild
 * registers its own fresh entry, so the "building" row reappears.
 *
 * An entry with no owning project is an INFRASTRUCTURE build — the shared
 * egress sidecar, which belongs to no project's chain. Re-running
 * `ensureRunning` is what rebuilds it: that path redeploys the sidecar when
 * its image tag is missing, which is exactly what the failed build left
 * behind. It is driven here rather than handed back to a caller because
 * nothing above this folder should have to know which builds are ours.
 *
 * `false` means the id is unknown or still running, so there was nothing to
 * retry. Otherwise the rebuild is already running in the background:
 * fire-and-forget either way, since each owns its own registry entry and
 * error logging, and the caller's answer is only that there WAS something.
 */
export function retryImageBuild(
  id: string,
  projectConfig: (slug: string) => Promise<YaacConfig | undefined>,
): boolean {
  const entry = getImageBuild(id)
  if (!entry || entry.status === 'running') return false
  forgetImageBuild(id)

  if (entry.projectSlugs.length === 0) {
    void proxyClient.ensureRunning().catch((err: unknown) =>
      serverLog(`[image-retry] proxy: ${String(err)}`))
    return true
  }

  for (const slug of entry.projectSlugs) {
    void projectConfig(slug)
      .then((config) => prewarmProjectImage(slug, config ?? {}))
      .catch((err: unknown) => serverLog(`[image-retry] ${slug}: ${String(err)}`))
  }
  return true
}
