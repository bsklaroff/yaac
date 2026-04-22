import { spawn } from 'node:child_process'
import { podman, shellPodmanWithRetry } from '@/lib/container/runtime'
import { proxyClient } from '@/lib/container/proxy-client'
import { resolveImageTag } from '@/lib/container/image-builder'
import {
  buildPromoterShellCommand,
  promoteSessionImages,
  removeSessionGraphrootVolume,
  sessionGraphrootVolumeName,
} from '@/lib/container/image-promoter'
import { removeWorktree } from '@/lib/git'
import { resolveProjectConfig } from '@/lib/project/config'
import { repoDir, worktreeDir } from '@/lib/project/paths'
import { stopSessionForwarders } from '@/lib/session/port-forwarders'

/**
 * Best-effort removal of the session's state from the proxy sidecar. If
 * the sidecar isn't running there's nothing to clean up. Errors are
 * swallowed so cleanup never blocks container teardown on a sidecar hiccup.
 */
async function removeSessionFromProxy(sessionId: string): Promise<void> {
  try {
    const attached = await proxyClient.attachIfRunning()
    if (!attached) return
    await proxyClient.removeSession(sessionId)
  } catch (err) {
    console.warn(
      `Failed to remove session ${sessionId} from proxy: ${(err as Error).message}`,
    )
  }
}

/**
 * Check whether tmux session "yaac" is alive inside the given container.
 *
 * Uses `shellPodmanWithRetry` with a tight budget so transient podman/OCI
 * errors (container state improper, conmon churn, etc.) do not masquerade
 * as "session is dead" — which would otherwise trigger destructive cleanup
 * of a live session.  The default retry budget (8 attempts, ~12.6s) is
 * much too long here: this function is called from hot paths in
 * `getWaitingSessions` (once per container) and in
 * `finalizeAttachedSession` (right after the user exits a session, when
 * the container is often truly gone).  A tight budget keeps stale-session
 * detection effectively asynchronous without losing protection against
 * short state-transition races.
 */
export async function isTmuxSessionAlive(containerName: string): Promise<boolean> {
  try {
    await shellPodmanWithRetry(`podman exec ${containerName} tmux has-session -t yaac`, {
      maxAttempts: 3,
      baseDelay: 100,
    })
    return true
  } catch {
    return false
  }
}

export async function cleanupSession(params: {
  containerName: string
  projectSlug: string
  sessionId: string
}): Promise<void> {
  const { containerName, projectSlug, sessionId } = params
  const container = podman.getContainer(containerName)

  stopSessionForwarders(sessionId)
  await removeSessionFromProxy(sessionId)

  try {
    await container.stop({ t: 5 })
  } catch {
    // container may already be stopped
  }

  try {
    await container.remove()
  } catch {
    // container may already be removed
  }

  // For nestedContainers sessions: salvage image layers from the session's
  // per-session podman graphroot into the project's shared image cache,
  // then drop the now-obsolete graphroot volume. Best-effort — never blocks
  // teardown on cache salvage or volume removal.
  try {
    const config = await resolveProjectConfig(projectSlug)
    if (config?.nestedContainers) {
      try {
        const imageRef = await resolveImageTag(projectSlug, undefined, true)
        await promoteSessionImages(projectSlug, sessionId, imageRef)
      } catch (err) {
        console.warn(`Promoter for session ${sessionId} failed: ${(err as Error).message}`)
      }
      await removeSessionGraphrootVolume(sessionId)
    }
  } catch {
    // config resolution failed — skip promotion silently
  }

  try {
    await removeWorktree(repoDir(projectSlug), worktreeDir(projectSlug, sessionId))
  } catch {
    // worktree may not exist
  }

  console.log(`Session ${sessionId} cleaned up.`)
}

/**
 * Remove the session's state from the proxy sidecar (in-process, fast),
 * then spawn a detached background process to do the slow container +
 * worktree teardown so the calling process can exit immediately.
 */
export async function cleanupSessionDetached(params: {
  containerName: string
  projectSlug: string
  sessionId: string
}): Promise<void> {
  const { containerName, projectSlug, sessionId } = params
  const wtDir = worktreeDir(projectSlug, sessionId)
  const rDir = repoDir(projectSlug)

  stopSessionForwarders(sessionId)
  await removeSessionFromProxy(sessionId)

  // For nestedContainers projects, include promoter + per-session volume
  // removal in the detached script so the caller can exit immediately but
  // the cache still gets salvaged and the volume cleaned up in the
  // background. Image ref is resolved in-process — cheap and avoids
  // needing config access inside the detached shell.
  let promoterCmd = ''
  let graphrootRm = ''
  try {
    const config = await resolveProjectConfig(projectSlug)
    if (config?.nestedContainers) {
      const imageRef = await resolveImageTag(projectSlug, undefined, true)
      promoterCmd = `${buildPromoterShellCommand(projectSlug, sessionId, imageRef)} 2>/dev/null || true`
      graphrootRm = `podman volume rm -f ${sessionGraphrootVolumeName(sessionId)} 2>/dev/null || true`
    }
  } catch {
    // config or image-tag resolution failed — skip the promoter bits; the
    // orphan-GC on next daemon start will clean up the volume.
  }

  // Build a shell script that stops + removes the container, optionally
  // runs the promoter + drops the graphroot volume, then removes the
  // worktree. Each step ignores errors (the resource may already be gone).
  const script = [
    `podman stop -t 5 ${containerName} 2>/dev/null || true`,
    `podman rm ${containerName} 2>/dev/null || true`,
    ...(promoterCmd ? [promoterCmd] : []),
    ...(graphrootRm ? [graphrootRm] : []),
    `git -C '${rDir}' worktree remove '${wtDir}' 2>/dev/null || true`,
  ].join('; ')

  const child = spawn('sh', ['-c', script], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}
