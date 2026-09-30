/**
 * Reconcile step that keeps every project's image chain built and pushed,
 * so workspace create does not wait minutes for a build after a
 * Dockerfile.yaac edit.
 *
 * Each sweep starts one background task per project not already in
 * flight. The build coordinator shares builds per tag, so a workspace
 * create joins the sweep's build instead of starting another. Skipped in
 * e2e, where the global setup prebuilds every image.
 */
import { ensureImage, pushImageShared } from './build-coordinator'
import { proxyClient } from '#drivers/k8s/egress'
import { serverLog } from '#log'
import { env, testEnv } from '@yaac/shared/env'
import type { YaacConfig } from '@yaac/shared/types'
import type { ProjectRef } from '#drivers/contract'
import {
  forgetImageBuild,
  getImageBuild,
  hasBlockingFailure,
  imageBuildProjects,
  resolveImageChain,
} from '#drivers/k8s/image-engine'

/** How long a failed build stops the sweep from retrying that chain.
 *  Retry in the webapp or a Dockerfile edit (new tag) lifts it at once;
 *  dismissing the row does not. Workspace creates ignore it. */
const FAILED_RETRY_MS = 10 * 60_000

/** Min interval between sweeps. Even a warm sweep costs a registry HEAD per
 *  layer per project, so running it every reconcile tick wastes CPU. */
export const PREWARM_SWEEP_INTERVAL_MS = 60_000

/** Project ids with a prewarm task in flight. */
const prewarming = new Set<string>()

let lastSweepMs = 0

/**
 * Ensure one project's chain is built and its final tag pushed. When all is
 * warm this is a few registry HEADs, so a pruned image is rebuilt on the
 * next sweep (or, for a yaac-shipped layer, reports `yaac cluster install`).
 *
 * `config` has no default: a missing one would silently build the default
 * chain, dropping the nestable layer for a `nestedContainers` project.
 */
export async function prewarmProjectImage(
  project: ProjectRef,
  config: YaacConfig,
): Promise<void> {
  const nestedContainers = config.nestedContainers === true
  const prefix = testEnv.imagePrefix ?? 'yaac'

  const { layers, finalTag } = await resolveImageChain(project, prefix, nestedContainers)
  if (hasBlockingFailure([...layers.map((l) => l.tag), finalTag], FAILED_RETRY_MS)) return

  await ensureImage(project, testEnv.imagePrefix, false, nestedContainers, {
    reason: 'prewarm',
  })
  await pushImageShared(finalTag, { project, reason: 'prewarm' })
}

/**
 * Start a background prewarm task per project. A failure is logged and its
 * failed build row holds off retries for FAILED_RETRY_MS. Throttled to
 * PREWARM_SWEEP_INTERVAL_MS.
 */
export function reconcileImagePrewarm(
  projects: ProjectRef[],
  projectConfig: (slug: string) => Promise<YaacConfig | undefined>,
  nowMs: number = Date.now(),
): void {
  if (!env.imagePrewarm) return
  if (testEnv.requirePrebuiltImages) return
  if (nowMs - lastSweepMs < PREWARM_SWEEP_INTERVAL_MS) return
  lastSweepMs = nowMs

  for (const project of projects) {
    if (prewarming.has(project.id)) continue
    prewarming.add(project.id)
    void projectConfig(project.slug)
      .then((config) => prewarmProjectImage(project, config ?? {}))
      .catch((err: unknown) => {
        serverLog(`[image-prewarm] ${project.slug}: ${String(err)}`)
      })
      .finally(() => prewarming.delete(project.id))
  }
}

/** Test helper: forget in-flight prewarm marks and the sweep throttle. */
export function _resetImagePrewarmForTests(): void {
  prewarming.clear()
  lastSweepMs = 0
}

/**
 * The webapp's "Retry" for a finished image build. Forgets the build row
 * (so its failure stops blocking the sweep) and rebuilds in the background:
 * each owning project's chain, or, for a build with no project (the egress
 * proxy's image), `proxyClient.ensureRunning()`. Returns false when the id
 * is unknown or still running.
 */
export function retryImageBuild(
  id: string,
  projectConfig: (slug: string) => Promise<YaacConfig | undefined>,
): boolean {
  const entry = getImageBuild(id)
  if (!entry || entry.status === 'running') return false
  const projects = imageBuildProjects(id)
  forgetImageBuild(id)

  if (projects.length === 0) {
    void proxyClient.ensureRunning().catch((err: unknown) =>
      serverLog(`[image-retry] proxy: ${String(err)}`))
    return true
  }

  for (const project of projects) {
    void projectConfig(project.slug)
      .then((config) => prewarmProjectImage(project, config ?? {}))
      .catch((err: unknown) => serverLog(`[image-retry] ${project.slug}: ${String(err)}`))
  }
  return true
}
