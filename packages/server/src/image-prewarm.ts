/**
 * Background-loop step that keeps every project's image chain built and
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
import { listProjects } from '#lib/project/list'
import { resolveProjectConfig } from '#lib/project/config'
import { resolveImageChain } from '#lib/container/image-builder'
import { ensureImage, pushImageShared } from '#lib/container/build-coordinator'
import { hasBlockingFailure } from '#image-builds'
import { serverLog } from '#log'
import { env, testEnv } from '@yaac/shared/env'

/** How long a failed chain build blocks the sweep from retrying. Hitting
 *  retry in the webapp (which forgets the failed entry) or editing the
 *  Dockerfile (which changes the tag) re-enables the sweep immediately;
 *  dismissing the row does not; session creates always bypass it. */
const FAILED_RETRY_MS = 10 * 60_000

/** Projects with a prewarm task in flight; added synchronously before the
 *  task's first await so a concurrent tick can't double-fire. */
const prewarming = new Set<string>()

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
 * next eligible tick retries.
 */
export async function reconcileImagePrewarm(): Promise<void> {
  if (!env.imagePrewarm) return
  if (testEnv.requirePrebuiltImages) return

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

/** Test helper: forget in-flight prewarm marks. */
export function _resetImagePrewarmForTests(): void {
  prewarming.clear()
}
