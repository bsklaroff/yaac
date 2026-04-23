import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { podman, podmanExecWithRetry, shellPodmanWithRetry } from '@/lib/container/runtime'
import { getDataDir, repoDir } from '@/lib/project/paths'
import { resolveSessionFingerprint } from '@/lib/session/fingerprint'
import { isTmuxSessionAlive, cleanupSession } from '@/lib/session/cleanup'
import { fetchOrigin } from '@/lib/git'
import { resolveTokenForUrl } from '@/lib/project/credentials'
import { createSession } from '@/daemon/session-create'
import type { AgentTool } from '@/shared/types'
import simpleGit from 'simple-git'

/** Maximum age of verifiedAt before a prewarm session is considered stale (30s). */
export const MAX_STALE_MS = 30_000

export interface PrewarmEntry {
  sessionId: string
  containerName: string
  fingerprint: string
  state: 'creating' | 'ready' | 'failed'
  verifiedAt: number
  /** Agent tool this prewarm session was created with (default: 'claude'). */
  tool?: AgentTool
}

function prewarmFilePath(): string {
  return path.join(getDataDir(), '.prewarm-sessions.json')
}

/**
 * Chained-promise mutex that serializes read-modify-write cycles on the
 * state file. All callers live in the daemon process (the daemon is
 * single-instance via `~/.yaac/.daemon.lock`), so in-process is enough.
 *
 * Without this, `ensurePrewarmSession`'s verifiedAt refresh could race
 * `claimPrewarmSession`: the monitor reads the entry, does a slow
 * alive-check, then blindly writes the entry back — resurrecting a
 * claimed session in the state file as a ghost prewarm. The claimed
 * container is then stuck labeled `prewarm` forever, and subsequent
 * claims can hand the same container to a second caller.
 */
let stateFileMutex: Promise<unknown> = Promise.resolve()

function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = (): Promise<T> => fn()
  const result = stateFileMutex.then(run, run)
  stateFileMutex = result.catch(() => undefined)
  return result
}

async function readStateUnlocked(): Promise<Record<string, PrewarmEntry>> {
  try {
    const raw = await fs.readFile(prewarmFilePath(), 'utf8')
    return JSON.parse(raw) as Record<string, PrewarmEntry>
  } catch {
    return {}
  }
}

async function writeStateUnlocked(data: Record<string, PrewarmEntry>): Promise<void> {
  await fs.writeFile(prewarmFilePath(), JSON.stringify(data, null, 2) + '\n')
}

export async function readPrewarmSessions(): Promise<Record<string, PrewarmEntry>> {
  return withStateLock(readStateUnlocked)
}

export async function getPrewarmSession(slug: string): Promise<PrewarmEntry | null> {
  const data = await readPrewarmSessions()
  return data[slug] ?? null
}

export async function setPrewarmSession(slug: string, entry: PrewarmEntry): Promise<void> {
  return withStateLock(async () => {
    const data = await readStateUnlocked()
    data[slug] = entry
    await writeStateUnlocked(data)
  })
}

export async function clearPrewarmSession(slug: string): Promise<void> {
  return withStateLock(async () => {
    const data = await readStateUnlocked()
    if (!(slug in data)) return
    delete data[slug]
    await writeStateUnlocked(data)
  })
}

/**
 * Atomic compare-and-set. Updates the state-file entry for `slug` only if
 * the current entry's sessionId matches `expectedSessionId`. Returns true
 * on success, false if the entry was cleared or replaced concurrently
 * (typically by `claimPrewarmSession`). Callers use this whenever they
 * are about to write an entry derived from a state snapshot that might be
 * stale by the time they write — the monitor's verifiedAt refresh, and
 * the creation path's state='ready' / state='failed' writes.
 */
export async function updatePrewarmSessionIfMatch(
  slug: string,
  expectedSessionId: string,
  entry: PrewarmEntry,
): Promise<boolean> {
  return withStateLock(async () => {
    const data = await readStateUnlocked()
    if (data[slug]?.sessionId !== expectedSessionId) return false
    data[slug] = entry
    await writeStateUnlocked(data)
    return true
  })
}

export async function clearFailedPrewarmSessions(): Promise<void> {
  const failed = await withStateLock(async () => {
    const data = await readStateUnlocked()
    const removed: Array<[string, PrewarmEntry]> = []
    for (const slug of Object.keys(data)) {
      if (data[slug].state === 'failed') {
        removed.push([slug, data[slug]])
        delete data[slug]
      }
    }
    if (removed.length > 0) await writeStateUnlocked(data)
    return removed
  })
  // Safety net: if the failure path didn't tear down the container (older
  // entries, or crashes between cleanup and setPrewarmSession), make sure
  // nothing leaks past the state-file entry. Runs outside the state-file
  // lock — cleanup is I/O-heavy and independent of the file state.
  for (const [slug, entry] of failed) {
    await cleanupPrewarmSession(entry, slug)
  }
}

export async function isPrewarmSession(slug: string, sessionId: string): Promise<boolean> {
  const entry = await getPrewarmSession(slug)
  return entry !== null && entry.sessionId === sessionId
}

/**
 * Check if a project has at least one live (non-prewarm) session.
 */
async function hasLiveSessions(projectSlug: string, prewarmContainerName?: string): Promise<boolean> {
  const containers = await podman.listContainers({
    all: true,
    filters: {
      label: [
        `yaac.data-dir=${getDataDir()}`,
        `yaac.project=${projectSlug}`,
      ],
    },
  })

  for (const c of containers) {
    const name = c.Names?.[0]?.replace(/^\//, '') ?? c.Id
    if (name === prewarmContainerName) continue
    if (c.State !== 'running') continue
    if (await isTmuxSessionAlive(name)) return true
  }

  return false
}

/**
 * Discover all projects with live sessions and ensure a prewarm session
 * exists for each. Used when the monitor is watching all projects.
 */
export async function ensurePrewarmSessions(tool: AgentTool = 'claude'): Promise<void> {
  // List all managed containers to discover active project slugs
  const containers = await podman.listContainers({
    all: true,
    filters: { label: [`yaac.data-dir=${getDataDir()}`] },
  })

  const projectSlugs = new Set<string>()
  for (const c of containers) {
    const slug = c.Labels?.['yaac.project']
    if (slug) projectSlugs.add(slug)
  }

  // Also check the prewarm state file for projects that may have prewarm
  // sessions but no other containers (need to clean them up)
  const prewarmData = await readPrewarmSessions()
  for (const slug of Object.keys(prewarmData)) {
    projectSlugs.add(slug)
  }

  for (const slug of projectSlugs) {
    try {
      await ensurePrewarmSession(slug, tool)
    } catch (err) {
      console.error(`Prewarm [${slug}]: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

export async function ensurePrewarmSession(projectSlug: string, tool: AgentTool = 'claude'): Promise<void> {
  const existing = await getPrewarmSession(projectSlug)

  // Only prewarm if the project has at least one live non-prewarm session
  const live = await hasLiveSessions(projectSlug, existing?.containerName)
  if (!live) {
    if (existing) {
      await cleanupPrewarmSession(existing, projectSlug)
      await clearPrewarmSession(projectSlug)
    }
    return
  }

  // Fetch origin so fingerprint reflects latest remote state
  const repo = repoDir(projectSlug)
  const remoteUrl = (await simpleGit(repo).remote(['get-url', 'origin']))?.trim()
  if (remoteUrl) {
    const token = await resolveTokenForUrl(remoteUrl)
    if (token) {
      try {
        await fetchOrigin(repo, token)
      } catch {
        // non-fatal — use whatever remote state we have
      }
    }
  }

  const { fingerprint } = await resolveSessionFingerprint(projectSlug)

  if (existing) {
    if (existing.fingerprint === fingerprint && (existing.tool ?? 'claude') === tool) {
      if (existing.state === 'creating') {
        // Creation in progress for correct fingerprint — skip
        return
      }

      if (existing.state === 'failed') {
        // Already failed for this fingerprint — don't retry
        return
      }

      // State is "ready" — verify container is still alive
      const alive = await isContainerRunning(existing.containerName) && await isTmuxSessionAlive(existing.containerName)
      if (alive) {
        // CAS the refresh: a concurrent claimPrewarmSession may have
        // cleared the entry while we were running the alive-check, and
        // a blind setPrewarmSession would resurrect the claimed session
        // as a ghost prewarm. updatePrewarmSessionIfMatch returns false
        // in that case — we just return, the claimer owns it now.
        await updatePrewarmSessionIfMatch(projectSlug, existing.sessionId, {
          ...existing,
          verifiedAt: Date.now(),
        })
        return
      }
    }

    // Stale or dead — clean up
    if (existing.state !== 'failed') {
      await cleanupPrewarmSession(existing, projectSlug)
    }
    await clearPrewarmSession(projectSlug)
  }

  // Pre-generate the sessionId so the "creating" entry has the real
  // container name. This lets claimPrewarmSession clear the entry
  // immediately and poll for the container by name.
  const sessionId = crypto.randomUUID()
  const containerName = `yaac-${projectSlug}-${sessionId}`

  await setPrewarmSession(projectSlug, {
    sessionId,
    containerName,
    fingerprint,
    state: 'creating',
    verifiedAt: Date.now(),
    tool,
  })

  try {
    const createdResult = await createSession(projectSlug, { createPrewarm: true, sessionId, tool })
    if (!createdResult?.sessionId) {
      await clearPrewarmSession(projectSlug)
      return
    }
    // CAS: a concurrent claimPrewarmSession may have cleared our 'creating'
    // entry while createSession ran. If so, the claimer now owns the
    // container and we must not re-register it as a prewarm.
    await updatePrewarmSessionIfMatch(projectSlug, sessionId, {
      sessionId,
      containerName,
      fingerprint,
      state: 'ready',
      verifiedAt: Date.now(),
      tool,
    })
  } catch (err) {
    // CAS: only mark failed (and tear down the half-created container) if
    // the entry wasn't claimed in the meantime. If it was claimed, the
    // claimer now owns the container — leave it alone. Marking failed
    // before teardown means a concurrent claim racing the teardown sees
    // state='failed' and bails out cleanly.
    const applied = await updatePrewarmSessionIfMatch(projectSlug, sessionId, {
      sessionId,
      containerName,
      fingerprint,
      state: 'failed',
      verifiedAt: Date.now(),
      tool,
    })
    if (applied) {
      // Tear down the half-created container. Otherwise the container
      // lives on, isPrewarmSession returns false once the failed entry is
      // cleared, and listActiveSessions reports it as a waiting session.
      await cleanupPrewarmSession({ sessionId, containerName, fingerprint, state: 'creating', verifiedAt: Date.now(), tool }, projectSlug)
    }
    throw err
  }
}

export async function claimPrewarmSession(
  projectSlug: string,
  tool: AgentTool = 'claude',
): Promise<{ sessionId: string; containerName: string } | null> {
  const entry = await getPrewarmSession(projectSlug)
  if (!entry || entry.state === 'failed') return null

  // Only claim if the requested tool matches the prewarmed tool
  if ((entry.tool ?? 'claude') !== tool) return null

  // Check verifiedAt freshness — if the monitor stopped, don't use stale sessions
  if (Date.now() - entry.verifiedAt > MAX_STALE_MS) {
    await cleanupPrewarmSession(entry, projectSlug)
    await clearPrewarmSession(projectSlug)
    return null
  }

  const { sessionId, containerName } = entry

  // Clear immediately so monitor can start creating a new prewarm session
  await clearPrewarmSession(projectSlug)

  // If still creating, wait for the container to become ready
  if (entry.state === 'creating') {
    const ready = await waitForContainer(containerName, 120_000)
    if (!ready) return null
  }

  // The monitor already verified container + tmux liveness when it set
  // verifiedAt (within MAX_STALE_MS, checked above). Skip the expensive
  // podman exec tmux check and just do a cheap container-running check
  // in case it crashed since the last monitor tick.
  if (!(await isContainerRunning(containerName))) {
    return null
  }

  return { sessionId, containerName }
}

async function inspectContainerState(
  containerName: string,
): Promise<{ exists: boolean; running: boolean }> {
  try {
    const result = await podmanExecWithRetry(
      ['inspect', '--format', '{{.State.Running}}', containerName],
      { maxAttempts: 1 },
    )
    return { exists: true, running: result.stdout.trim() === 'true' }
  } catch {
    return { exists: false, running: false }
  }
}

async function isContainerRunning(containerName: string): Promise<boolean> {
  return (await inspectContainerState(containerName)).running
}

/**
 * Poll for a prewarm container to become ready (running + tmux session up).
 *
 * The claim path clears the prewarm state file before calling this, so the
 * creator can't signal failure through the state — if creation aborts
 * mid-flight, the creator's error handler `podman rm -f`s the half-created
 * container and throws. We detect that by tracking whether the container
 * was ever observed; once it transitions from seen → gone, we know
 * creation was abandoned and return false immediately instead of burning
 * the full timeoutMs polling a container that will never come back.
 */
async function waitForContainer(containerName: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  let sawContainer = false
  while (Date.now() - start < timeoutMs) {
    const state = await inspectContainerState(containerName)
    if (state.exists) {
      sawContainer = true
      if (state.running && await isTmuxSessionAlive(containerName)) {
        return true
      }
    } else if (sawContainer) {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return false
}

async function cleanupPrewarmSession(entry: PrewarmEntry, projectSlug: string): Promise<void> {
  try {
    await cleanupSession({
      containerName: entry.containerName,
      projectSlug,
      sessionId: entry.sessionId,
    })
  } catch {
    // Force remove if normal cleanup fails
    try {
      await shellPodmanWithRetry(`podman rm -f ${entry.containerName}`, { maxAttempts: 1 })
    } catch {
      // already gone
    }
  }
}
