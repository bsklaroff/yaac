import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { podman } from '@/lib/container/runtime'
import { getDataDir, repoDir } from '@/lib/project/paths'
import { resolveSessionFingerprint } from '@/lib/session/fingerprint'
import { isTmuxSessionAlive, cleanupSession } from '@/lib/session/cleanup'
import { fetchOrigin } from '@/lib/git'
import { resolveTokenForUrl } from '@/lib/project/credentials'
import { sessionCreate } from '@/commands/session-create'
import simpleGit from 'simple-git'

/** Maximum age of verifiedAt before a prewarm session is considered stale (30s). */
export const MAX_STALE_MS = 30_000

export interface PrewarmEntry {
  sessionId: string
  containerName: string
  fingerprint: string
  state: 'creating' | 'ready'
  verifiedAt: number
}

function prewarmFilePath(): string {
  return path.join(getDataDir(), '.prewarm-sessions.json')
}

export async function readPrewarmSessions(): Promise<Record<string, PrewarmEntry>> {
  try {
    const raw = await fs.readFile(prewarmFilePath(), 'utf8')
    return JSON.parse(raw) as Record<string, PrewarmEntry>
  } catch {
    return {}
  }
}

async function writePrewarmSessions(data: Record<string, PrewarmEntry>): Promise<void> {
  await fs.writeFile(prewarmFilePath(), JSON.stringify(data, null, 2) + '\n')
}

export async function getPrewarmSession(slug: string): Promise<PrewarmEntry | null> {
  const data = await readPrewarmSessions()
  return data[slug] ?? null
}

export async function setPrewarmSession(slug: string, entry: PrewarmEntry): Promise<void> {
  const data = await readPrewarmSessions()
  data[slug] = entry
  await writePrewarmSessions(data)
}

export async function clearPrewarmSession(slug: string): Promise<void> {
  const data = await readPrewarmSessions()
  if (!(slug in data)) return
  delete data[slug]
  await writePrewarmSessions(data)
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
    if (isTmuxSessionAlive(name)) return true
  }

  return false
}

/**
 * Discover all projects with live sessions and ensure a prewarm session
 * exists for each. Used when the monitor is watching all projects.
 */
export async function ensurePrewarmSessions(): Promise<void> {
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
      await ensurePrewarmSession(slug)
    } catch (err) {
      console.error(`Prewarm [${slug}]: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

export async function ensurePrewarmSession(projectSlug: string): Promise<void> {
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
    if (existing.fingerprint === fingerprint) {
      if (existing.state === 'creating') {
        // Creation in progress for correct fingerprint — skip
        return
      }

      // State is "ready" — verify container is still alive
      const alive = isContainerRunning(existing.containerName) && isTmuxSessionAlive(existing.containerName)
      if (alive) {
        // Fresh prewarm session — update verifiedAt
        await setPrewarmSession(projectSlug, { ...existing, verifiedAt: Date.now() })
        return
      }
    }

    // Stale or dead — clean up
    await cleanupPrewarmSession(existing, projectSlug)
    await clearPrewarmSession(projectSlug)
  }

  // Create new prewarm session — sessionCreate generates its own sessionId
  // We write "creating" state first, then update with the real sessionId after creation
  const placeholderId = crypto.randomUUID()
  const placeholderName = `yaac-${projectSlug}-${placeholderId}`

  await setPrewarmSession(projectSlug, {
    sessionId: placeholderId,
    containerName: placeholderName,
    fingerprint,
    state: 'creating',
    verifiedAt: Date.now(),
  })

  try {
    const sessionId = await sessionCreate(projectSlug, { createPrewarm: true })
    if (!sessionId) {
      await clearPrewarmSession(projectSlug)
      return
    }
    const containerName = `yaac-${projectSlug}-${sessionId}`
    await setPrewarmSession(projectSlug, {
      sessionId,
      containerName,
      fingerprint,
      state: 'ready',
      verifiedAt: Date.now(),
    })
  } catch (err) {
    await clearPrewarmSession(projectSlug)
    throw err
  }
}

export async function claimPrewarmSession(
  projectSlug: string,
): Promise<{ sessionId: string; containerName: string } | null> {
  const entry = await getPrewarmSession(projectSlug)
  if (!entry) return null

  // Check verifiedAt freshness — if the monitor stopped, don't use stale sessions
  if (Date.now() - entry.verifiedAt > MAX_STALE_MS) {
    await cleanupPrewarmSession(entry, projectSlug)
    await clearPrewarmSession(projectSlug)
    return null
  }

  const { sessionId, containerName } = entry

  // Clear immediately so monitor can start creating a new prewarm session
  await clearPrewarmSession(projectSlug)

  // If still creating, wait for it to become ready
  if (entry.state === 'creating') {
    const ready = await waitForContainer(containerName, 120_000)
    if (!ready) return null
  }

  // The monitor already verified container + tmux liveness when it set
  // verifiedAt (within MAX_STALE_MS, checked above). Skip the expensive
  // podman exec tmux check and just do a cheap container-running check
  // in case it crashed since the last monitor tick.
  if (!isContainerRunning(containerName)) {
    return null
  }

  return { sessionId, containerName }
}

function isContainerRunning(containerName: string): boolean {
  try {
    const result = execSync(`podman inspect --format '{{.State.Running}}' ${containerName}`, { stdio: 'pipe' })
    return result.toString().trim() === 'true'
  } catch {
    return false
  }
}

async function waitForContainer(containerName: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (isContainerRunning(containerName) && isTmuxSessionAlive(containerName)) {
      return true
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
      execSync(`podman rm -f ${entry.containerName}`, { stdio: 'pipe' })
    } catch {
      // already gone
    }
  }
}
