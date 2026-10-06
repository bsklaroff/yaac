/**
 * Reconcile step that keeps every project's image chain built,
 * so workspace create does not wait minutes for a build after a
 * Dockerfile.yaac edit.
 *
 * Each sweep starts one background task per project not already in
 * flight. The build coordinator shares builds per tag, so a workspace
 * create joins the sweep's build instead of starting another. Skipped in
 * e2e, where the global setup prebuilds every image.
 */
import { ensureImage } from './build-coordinator'
import { serverLog } from '#log'
import { env, testEnv } from '@yaac/shared/env'
import type { YaacConfig } from '@yaac/shared/types'
import {
  forgetImageBuild,
  getImageBuild,
  hasBlockingFailure,
  imageBuildProjectIds,
  resolveImageChain,
} from '#drivers/k8s/image-engine'

/** How long a failed build stops the sweep from retrying that chain.
 *  Retry in the webapp or a Dockerfile edit (new tag) lifts it at once;
 *  dismissing the row does not. Workspace creates ignore it. */
const FAILED_RETRY_MS = 10 * 60_000

/** Project ids with a prewarm task in flight. */
const prewarming = new Set<string>()

/**
 * Ensure one project's chain is built. When all is
 * warm this is a few registry HEADs, so a pruned image is rebuilt on the
 * next sweep (or, for a yaac-shipped layer, reports `yaac cluster install`).
 *
 * `config` has no default: a missing one would silently build the default
 * chain, dropping the nestable layer for a `nestedContainers` project.
 */
export async function prewarmProjectImage(
  projectId: string,
  config: YaacConfig,
): Promise<void> {
  const nestedContainers = config.nestedContainers === true
  const prefix = testEnv.imagePrefix ?? 'yaac'

  const { layers } = await resolveImageChain(projectId, prefix, nestedContainers)
  if (hasBlockingFailure(layers.map((l) => l.tag), FAILED_RETRY_MS)) return

  await ensureImage(projectId, testEnv.imagePrefix, false, nestedContainers, {
    reason: 'prewarm',
  })
}

/**
 * Start a background prewarm task per project. A failure is logged and its
 * failed build row holds off retries for FAILED_RETRY_MS.
 */
export function reconcileImagePrewarm(
  projectIds: string[],
  projectConfig: (projectId: string) => Promise<YaacConfig | undefined>,
): void {
  if (!env.imagePrewarm) return
  if (testEnv.requirePrebuiltImages) return

  for (const projectId of projectIds) {
    if (prewarming.has(projectId)) continue
    prewarming.add(projectId)
    void projectConfig(projectId)
      .then((config) => prewarmProjectImage(projectId, config ?? {}))
      .catch((err: unknown) => {
        serverLog(`[image-prewarm] ${projectId}: ${String(err)}`)
      })
      .finally(() => prewarming.delete(projectId))
  }
}

/** Test helper: forget in-flight prewarm marks. */
export function _resetImagePrewarmForTests(): void {
  prewarming.clear()
}

/**
 * The webapp's "Retry" for a finished image build. Forgets the build row
 * (so its failure stops blocking the sweep) and rebuilds each owning
 * project's chain in the background. Returns false when the id is unknown
 * or still running.
 */
export function retryImageBuild(
  id: string,
  projectConfig: (projectId: string) => Promise<YaacConfig | undefined>,
): boolean {
  const entry = getImageBuild(id)
  if (!entry || entry.status === 'running') return false
  const projectIds = imageBuildProjectIds(id)
  forgetImageBuild(id)
  for (const projectId of projectIds) {
    void projectConfig(projectId)
      .then((config) => prewarmProjectImage(projectId, config ?? {}))
      .catch((err: unknown) => serverLog(`[image-retry] ${projectId}: ${String(err)}`))
  }
  return true
}
