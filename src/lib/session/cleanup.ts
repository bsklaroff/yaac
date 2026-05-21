import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { podman } from '@/lib/container/runtime'
import { evictClaudeStatusCache } from '@/lib/session/claude-status'
import { proxyClient } from '@/lib/container/proxy-client'
import { resolveImageTag } from '@/lib/container/image-builder'
import {
  buildPromoterShellCommand,
  promoteSessionImages,
  removeSessionGraphrootVolume,
  sessionGraphrootVolumeName,
} from '@/lib/container/image-promoter'
import { resolveProjectConfig } from '@/lib/project/config'
import {
  cachedPackagesDir,
  projectDir,
  sessionTmuxDir,
} from '@/lib/project/paths'
import { CONTAINER_TMUX_SOCK, getProjectsDir, getDataDir } from '@/shared/paths'
import { stopSessionForwarders } from '@/lib/session/port-forwarders'

const execFileAsync = promisify(execFile)

/**
 * Absolute host path to `<cachedPackages>/modules/<sessionId>` — the
 * per-session ephemeral-modules root whose subdirs back the
 * `/workspace/<relPath>` symlinks installed at session start. See
 * `installEphemeralModuleLinks` in `src/daemon/session-create.ts`.
 */
export function sessionModulesDir(projectSlug: string, sessionId: string): string {
  return path.join(cachedPackagesDir(projectSlug), 'modules', sessionId)
}

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
 * Short-TTL cache for `isTmuxSessionAlive` results, keyed by
 * `${slug}/${sessionId}`. Each entry holds either a settled
 * (boolean, expiresAt) row or an in-flight Promise so concurrent
 * callers coalesce onto the same probe. Without this, /session/list
 * (called every ~5s by the UI), the background loop's
 * `hasLiveSessions`, and the stream-picker each run the same
 * has-session check independently for every container.
 */
const TMUX_ALIVE_TTL_MS = 2_000
const TMUX_PROBE_TIMEOUT_MS = 2_000

type TmuxAliveEntry =
  | { kind: 'settled'; value: boolean; expiresAt: number }
  | { kind: 'inflight'; promise: Promise<boolean> }

const tmuxAliveCache = new Map<string, TmuxAliveEntry>()

function tmuxAliveKey(slug: string, sessionId: string): string {
  return `${slug}/${sessionId}`
}

/**
 * Test-only: drop every cached entry. Production callers never need to
 * invalidate because the TTL is short and `cleanupSession` already
 * removes the cache entry — but tests that mock different probe
 * behavior across cases need to start each case from a clean slate.
 */
export function _clearTmuxAliveCacheForTests(): void {
  tmuxAliveCache.clear()
}

/**
 * Probe tmux liveness by running `tmux has-session` inside the container
 * via `podman exec`. We can't connect to the bind-mounted UNIX socket
 * from the host: on podman-machine (macOS) the socket file appears on
 * the host via virtio-fs/9p but the listening kernel state lives in the
 * VM, so host-side `connect()` always fails with ECONNREFUSED. Running
 * the client inside the container is the only portable signal.
 *
 * Exit 0 → session present. Non-zero / timeout / missing container → false.
 */
async function probeTmuxSessionAlive(slug: string, sessionId: string): Promise<boolean> {
  const containerName = `yaac-${slug}-${sessionId}`
  try {
    await execFileAsync(
      'podman',
      ['exec', containerName, 'tmux', '-S', CONTAINER_TMUX_SOCK, 'has-session', '-t', 'yaac'],
      { timeout: TMUX_PROBE_TIMEOUT_MS },
    )
    return true
  } catch {
    return false
  }
}

/**
 * Check whether tmux session "yaac" is alive for the given session.
 *
 * Results are cached for `TMUX_ALIVE_TTL_MS` and concurrent callers
 * for the same session share one in-flight probe, so the underlying
 * `podman exec` runs at most once per session per TTL window.
 */
export async function isTmuxSessionAlive(slug: string, sessionId: string): Promise<boolean> {
  const key = tmuxAliveKey(slug, sessionId)
  const now = Date.now()
  const cached = tmuxAliveCache.get(key)
  if (cached) {
    if (cached.kind === 'inflight') return cached.promise
    if (cached.expiresAt > now) return cached.value
  }
  const promise = probeTmuxSessionAlive(slug, sessionId).then((value) => {
    tmuxAliveCache.set(key, {
      kind: 'settled',
      value,
      expiresAt: Date.now() + TMUX_ALIVE_TTL_MS,
    })
    return value
  })
  tmuxAliveCache.set(key, { kind: 'inflight', promise })
  return promise
}

export async function cleanupSession(params: {
  containerName: string
  projectSlug: string
  sessionId: string
}): Promise<void> {
  const { containerName, projectSlug, sessionId } = params
  const container = podman.getContainer(containerName)

  // Drop any cached tmux-alive / claude-status entry so a subsequent
  // caller doesn't see a stale value from this session's previous
  // probe (or, in the worst case, a value belonging to a brand-new
  // session with the same id).
  tmuxAliveCache.delete(tmuxAliveKey(projectSlug, sessionId))
  evictClaudeStatusCache(projectSlug, sessionId)

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
        const imageRef = await resolveImageTag(projectSlug, process.env.YAAC_IMAGE_PREFIX, true)
        await promoteSessionImages(projectSlug, sessionId, imageRef)
      } catch (err) {
        console.warn(`Promoter for session ${sessionId} failed: ${(err as Error).message}`)
      }
      await removeSessionGraphrootVolume(sessionId)
    }
  } catch {
    // config resolution failed — skip promotion silently
  }

  // Remove the per-session ephemeral-modules backing dir from
  // `.cached-packages/modules/<sid>`. No-op if the feature was disabled
  // for this session (dir won't exist).
  await fs.rm(sessionModulesDir(projectSlug, sessionId), {
    recursive: true,
    force: true,
  })

  // Remove the per-session tmux dir holding the server socket and
  // pipe-pane log. The container is gone; the bind-mount source is
  // garbage now.
  await fs.rm(sessionTmuxDir(projectSlug, sessionId), {
    recursive: true,
    force: true,
  })

  console.log(`Session ${sessionId} cleaned up.`)
}

/**
 * Remove the session's state from the proxy sidecar (in-process, fast),
 * then spawn a detached background process to do the slow container
 * teardown so the calling process can exit immediately.
 */
export async function cleanupSessionDetached(params: {
  containerName: string
  projectSlug: string
  sessionId: string
}): Promise<void> {
  const { containerName, projectSlug, sessionId } = params

  tmuxAliveCache.delete(tmuxAliveKey(projectSlug, sessionId))
  evictClaudeStatusCache(projectSlug, sessionId)

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
      const imageRef = await resolveImageTag(projectSlug, process.env.YAAC_IMAGE_PREFIX, true)
      promoterCmd = `${buildPromoterShellCommand(projectSlug, sessionId, imageRef)} 2>/dev/null || true`
      graphrootRm = `podman volume rm -f ${sessionGraphrootVolumeName(sessionId)} 2>/dev/null || true`
    }
  } catch {
    // config or image-tag resolution failed — skip the promoter bits; the
    // orphan-GC on next daemon start will clean up the volume.
  }

  const modulesDir = sessionModulesDir(projectSlug, sessionId)
  const ephemeralModulesRm = `rm -rf '${modulesDir.replace(/'/g, `'\\''`)}' 2>/dev/null || true`

  const tmuxDir = sessionTmuxDir(projectSlug, sessionId)
  const tmuxDirRm = `rm -rf '${tmuxDir.replace(/'/g, `'\\''`)}' 2>/dev/null || true`

  const script = [
    `podman stop -t 5 ${containerName} 2>/dev/null || true`,
    `podman rm ${containerName} 2>/dev/null || true`,
    ...(promoterCmd ? [promoterCmd] : []),
    ...(graphrootRm ? [graphrootRm] : []),
    ephemeralModulesRm,
    tmuxDirRm,
  ].join('; ')

  const child = spawn('sh', ['-c', script], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}

/**
 * Daemon-startup sweep: remove `.cached-packages/modules/<sid>`
 * directories whose session container is no longer alive. Catches
 * leftovers from crashes, killed daemons, and host reboots. Mirrors
 * `gcOrphanSessionVolumes` (`src/lib/container/image-promoter.ts`)
 * but operates on host directories rather than podman volumes.
 */
export async function gcOrphanEphemeralModuleDirs(): Promise<void> {
  const dataDir = getDataDir()

  let liveSessionIds: Set<string>
  try {
    const containers = await podman.listContainers({
      all: true,
      filters: { label: [`yaac.data-dir=${dataDir}`] },
    })
    liveSessionIds = new Set(
      containers
        .map((c) => c.Labels?.['yaac.session-id'])
        .filter((id): id is string => !!id),
    )
  } catch (err) {
    console.warn(`Orphan modules GC: failed to list containers: ${(err as Error).message}`)
    return
  }

  let projectSlugs: string[]
  try {
    projectSlugs = await fs.readdir(getProjectsDir())
  } catch {
    return
  }

  for (const slug of projectSlugs) {
    const modulesRoot = path.join(cachedPackagesDir(slug), 'modules')
    let entries: string[] = []
    try {
      entries = await fs.readdir(modulesRoot)
    } catch { /* missing modules dir → nothing to sweep there */ }
    for (const sid of entries) {
      if (liveSessionIds.has(sid)) continue
      const dir = path.join(modulesRoot, sid)
      try {
        await fs.rm(dir, { recursive: true, force: true })
        console.log(`Removed orphan ephemeral modules dir ${dir}`)
      } catch (err) {
        console.warn(`Orphan modules GC: failed to remove ${dir}: ${(err as Error).message}`)
      }
    }

    // Per-session tmux bind-mount dirs live under <projectDir>/sessions/<sid>/tmux.
    // The parent `sessions/` dir is unique to this feature, so a flat
    // readdir of `sessions/` gives us the session id list directly.
    const sessionsRoot = path.join(projectDir(slug), 'sessions')
    let sessionEntries: string[] = []
    try {
      sessionEntries = await fs.readdir(sessionsRoot)
    } catch { /* missing sessions dir → nothing to sweep there */ }
    for (const sid of sessionEntries) {
      if (liveSessionIds.has(sid)) continue
      const dir = path.join(sessionsRoot, sid)
      try {
        await fs.rm(dir, { recursive: true, force: true })
        console.log(`Removed orphan session dir ${dir}`)
      } catch (err) {
        console.warn(`Orphan session GC: failed to remove ${dir}: ${(err as Error).message}`)
      }
    }
  }
}
