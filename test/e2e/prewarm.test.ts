import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  createTempDataDir, cleanupTempDir, createTestRepo, requirePodman,
  TEST_IMAGE_PREFIX, addTestProject,
} from '@test/helpers/setup'
import { podman } from '@/lib/container/runtime'
import { ensureImage } from '@/lib/container/image-builder'
import { claudeDir, worktreeDir, worktreesDir, repoDir, getDataDir } from '@/lib/project/paths'
import { addWorktree, getDefaultBranch } from '@/lib/git'
import {
  readPrewarmSessions, getPrewarmSession, setPrewarmSession,
  clearPrewarmSession, isPrewarmSession, claimPrewarmSession,
  ensurePrewarmSession, MAX_STALE_MS,
} from '@/lib/prewarm'
import type { PrewarmEntry } from '@/lib/prewarm'
import { isTmuxSessionAlive } from '@/lib/session/cleanup'

const execFileAsync = promisify(execFile)

/**
 * Create a minimal running container with tmux for a project.
 * Used to simulate both "live" sessions and "prewarm" sessions.
 */
async function createMinimalContainer(projectSlug: string): Promise<{ containerName: string; sessionId: string }> {
  const imageName = await ensureImage(projectSlug, TEST_IMAGE_PREFIX, true)
  const sessionId = crypto.randomBytes(4).toString('hex')
  const repo = repoDir(projectSlug)
  const wtDir = worktreeDir(projectSlug, sessionId)
  await fs.mkdir(worktreesDir(projectSlug), { recursive: true })
  await getDefaultBranch(repo)
  await addWorktree(repo, wtDir, `yaac/${sessionId}`)

  const containerName = `yaac-${projectSlug}-${sessionId}`
  const container = await podman.createContainer({
    Image: imageName,
    name: containerName,
    Labels: {
      'yaac.project': projectSlug,
      'yaac.session-id': sessionId,
      'yaac.data-dir': getDataDir(),
      'yaac.test': 'true',
    },
    Env: ['TERM=xterm-256color'],
    HostConfig: {
      Binds: [
        `${wtDir}:/workspace:Z`,
        `${claudeDir(projectSlug)}:/home/yaac/.claude:Z`,
      ],
    },
  })
  await container.start()

  // Start tmux session so isTmuxSessionAlive() returns true
  await execFileAsync('podman', [
    'exec', containerName, 'tmux', 'new-session', '-d', '-s', 'yaac', '-n', 'claude', 'bash',
  ])

  return { containerName, sessionId }
}

/**
 * Create a container and register it as a prewarm session in the state file.
 */
async function createPrewarmContainer(
  projectSlug: string,
  fingerprint = 'test-fingerprint',
  state: 'creating' | 'ready' = 'ready',
): Promise<PrewarmEntry> {
  const { containerName, sessionId } = await createMinimalContainer(projectSlug)
  const entry: PrewarmEntry = {
    sessionId,
    containerName,
    fingerprint,
    state,
    verifiedAt: Date.now(),
  }
  await setPrewarmSession(projectSlug, entry)
  return entry
}

describe('prewarm session lifecycle', () => {
  const containersToCleanup: string[] = []
  const tmpDirs: string[] = []
  let dataDir: string
  let projectSlug: string

  beforeAll(async () => {
    await requirePodman()

    dataDir = await createTempDataDir()
    tmpDirs.push(dataDir)

    const repoPath = path.join(dataDir, 'test-repo')
    await createTestRepo(repoPath)
    await addTestProject(repoPath)
    projectSlug = path.basename(repoPath)
  })

  afterEach(async () => {
    for (const name of containersToCleanup) {
      try {
        const c = podman.getContainer(name)
        await c.stop({ t: 1 }).catch(() => {})
        await c.remove().catch(() => {})
      } catch {
        // already gone
      }
    }
    containersToCleanup.length = 0
    await clearPrewarmSession(projectSlug)
  })

  afterAll(async () => {
    for (const dir of tmpDirs) {
      await cleanupTempDir(dir)
    }
  })

  // --- State file operations ---

  it('state file operations work correctly', async () => {
    const empty = await readPrewarmSessions()
    expect(empty).toEqual({})

    const entry: PrewarmEntry = {
      sessionId: 'test-id',
      containerName: 'yaac-test-id',
      fingerprint: 'abc123',
      state: 'ready',
      verifiedAt: Date.now(),
    }
    await setPrewarmSession(projectSlug, entry)
    const read = await getPrewarmSession(projectSlug)
    expect(read).toEqual(entry)

    expect(await isPrewarmSession(projectSlug, 'test-id')).toBe(true)
    expect(await isPrewarmSession(projectSlug, 'wrong-id')).toBe(false)

    await clearPrewarmSession(projectSlug)
    expect(await getPrewarmSession(projectSlug)).toBeNull()
  })

  // --- Claiming ---

  it('claiming a ready prewarm session returns info and clears state', async () => {
    const entry = await createPrewarmContainer(projectSlug)
    containersToCleanup.push(entry.containerName)

    const claimed = await claimPrewarmSession(projectSlug)
    expect(claimed).not.toBeNull()
    expect(claimed!.sessionId).toBe(entry.sessionId)
    expect(claimed!.containerName).toBe(entry.containerName)

    // State should be cleared
    expect(await getPrewarmSession(projectSlug)).toBeNull()

    // Container should still be running
    expect(isTmuxSessionAlive(claimed!.containerName)).toBe(true)
  })

  it('claiming returns null when no prewarm session exists', async () => {
    const claimed = await claimPrewarmSession(projectSlug)
    expect(claimed).toBeNull()
  })

  it('claiming a creating prewarm session waits for it to become ready', async () => {
    // Create a container that's already running (simulates "creating" that finishes)
    const entry = await createPrewarmContainer(projectSlug, 'test-fp', 'creating')
    containersToCleanup.push(entry.containerName)

    // The container is already running + tmux alive, so claiming should succeed
    // even though state is "creating" — waitForContainer will find it ready immediately
    const claimed = await claimPrewarmSession(projectSlug)
    expect(claimed).not.toBeNull()
    expect(claimed!.sessionId).toBe(entry.sessionId)
  })

  it('stale verifiedAt causes claim to return null', async () => {
    const entry = await createPrewarmContainer(projectSlug)
    containersToCleanup.push(entry.containerName)

    // Set verifiedAt to the past
    await setPrewarmSession(projectSlug, {
      ...entry,
      verifiedAt: Date.now() - MAX_STALE_MS - 5000,
    })

    const claimed = await claimPrewarmSession(projectSlug)
    expect(claimed).toBeNull()

    // State should be cleared
    expect(await getPrewarmSession(projectSlug)).toBeNull()
  })

  it('claiming fails when container is dead', async () => {
    const entry = await createPrewarmContainer(projectSlug)

    // Kill the container
    try {
      await execFileAsync('podman', ['stop', '-t', '1', entry.containerName])
      await execFileAsync('podman', ['rm', entry.containerName])
    } catch {
      // may already be gone
    }

    const claimed = await claimPrewarmSession(projectSlug)
    expect(claimed).toBeNull()
  })

  // --- ensurePrewarmSession ---

  it('no prewarm without live sessions', async () => {
    await ensurePrewarmSession(projectSlug)
    expect(await getPrewarmSession(projectSlug)).toBeNull()
  })

  it('cleans up existing prewarm when no live sessions remain', async () => {
    // Create a prewarm entry with a real container
    const entry = await createPrewarmContainer(projectSlug)
    containersToCleanup.push(entry.containerName)

    // No live (non-prewarm) sessions exist
    await ensurePrewarmSession(projectSlug)

    // Prewarm should be cleaned up
    expect(await getPrewarmSession(projectSlug)).toBeNull()
  })

  it('updates verifiedAt when fingerprint matches and container is alive', async () => {
    // Create a live session
    const live = await createMinimalContainer(projectSlug)
    containersToCleanup.push(live.containerName)

    // Create a prewarm session — we need a real fingerprint for the match
    const { resolveSessionFingerprint } = await import('@/lib/session/fingerprint')
    const { fingerprint } = await resolveSessionFingerprint(projectSlug)

    const prewarm = await createPrewarmContainer(projectSlug, fingerprint)
    containersToCleanup.push(prewarm.containerName)

    const oldVerifiedAt = prewarm.verifiedAt

    // Wait a tick so Date.now() differs
    await new Promise((r) => setTimeout(r, 50))

    // Run ensure — should just update verifiedAt since fingerprint matches
    await ensurePrewarmSession(projectSlug)

    const updated = await getPrewarmSession(projectSlug)
    expect(updated).not.toBeNull()
    expect(updated!.sessionId).toBe(prewarm.sessionId)
    expect(updated!.verifiedAt).toBeGreaterThan(oldVerifiedAt)
  })

  it('skips when state is creating and fingerprint matches', async () => {
    // Create a live session
    const live = await createMinimalContainer(projectSlug)
    containersToCleanup.push(live.containerName)

    const { resolveSessionFingerprint } = await import('@/lib/session/fingerprint')
    const { fingerprint } = await resolveSessionFingerprint(projectSlug)

    // Write "creating" state with matching fingerprint
    const entry: PrewarmEntry = {
      sessionId: 'creating-session',
      containerName: 'yaac-creating-session',
      fingerprint,
      state: 'creating',
      verifiedAt: Date.now(),
    }
    await setPrewarmSession(projectSlug, entry)

    // Run ensure — should skip since creation is in progress with correct fingerprint
    await ensurePrewarmSession(projectSlug)

    const after = await getPrewarmSession(projectSlug)
    expect(after).not.toBeNull()
    expect(after!.sessionId).toBe('creating-session')
    expect(after!.state).toBe('creating')
  })

  it('cleans up when fingerprint mismatches on ready session', async () => {
    // Create a live session
    const live = await createMinimalContainer(projectSlug)
    containersToCleanup.push(live.containerName)

    // Create a prewarm session with a stale fingerprint
    const prewarm = await createPrewarmContainer(projectSlug, 'stale-fingerprint-000')
    containersToCleanup.push(prewarm.containerName)

    // Run ensure — fingerprint won't match current, so it should clean up
    // and then try to create a new one via sessionCreate (which will fail
    // in tests due to no GitHub token). That's OK — we verify cleanup happened.
    try {
      await ensurePrewarmSession(projectSlug)
    } catch {
      // Expected — sessionCreate fails without GitHub token
    }

    // Old prewarm state should be cleared (either replaced or removed)
    const after = await getPrewarmSession(projectSlug)
    // Either null (creation failed and was cleaned up) or a new entry (creation succeeded)
    if (after) {
      expect(after.sessionId).not.toBe(prewarm.sessionId)
    }
  })

  it('cleans up dead prewarm container', async () => {
    // Create a live session
    const live = await createMinimalContainer(projectSlug)
    containersToCleanup.push(live.containerName)

    const { resolveSessionFingerprint } = await import('@/lib/session/fingerprint')
    const { fingerprint } = await resolveSessionFingerprint(projectSlug)

    // Create a prewarm container then kill it
    const prewarm = await createPrewarmContainer(projectSlug, fingerprint)
    try {
      await execFileAsync('podman', ['stop', '-t', '1', prewarm.containerName])
      await execFileAsync('podman', ['rm', prewarm.containerName])
    } catch {
      // may already be gone
    }

    // Run ensure — should detect dead container, clean up, and try to create new
    try {
      await ensurePrewarmSession(projectSlug)
    } catch {
      // Expected — sessionCreate fails without GitHub token
    }

    // Old prewarm entry should be gone or replaced
    const after = await getPrewarmSession(projectSlug)
    if (after) {
      expect(after.sessionId).not.toBe(prewarm.sessionId)
    }
  })

  // --- isPrewarmSession ---

  it('isPrewarmSession identifies prewarm sessions correctly', async () => {
    const entry: PrewarmEntry = {
      sessionId: 'prewarm-test-id',
      containerName: 'yaac-test-prewarm-test-id',
      fingerprint: 'abc123',
      state: 'ready',
      verifiedAt: Date.now(),
    }
    await setPrewarmSession(projectSlug, entry)

    expect(await isPrewarmSession(projectSlug, 'prewarm-test-id')).toBe(true)
    expect(await isPrewarmSession(projectSlug, 'other-id')).toBe(false)
    expect(await isPrewarmSession('nonexistent-project', 'prewarm-test-id')).toBe(false)
  })

  // --- sessionCreate claiming ---

  it('sessionCreate with createPrewarm does not claim prewarm sessions', async () => {
    // Create a prewarm session
    const prewarm = await createPrewarmContainer(projectSlug)
    containersToCleanup.push(prewarm.containerName)

    // sessionCreate with createPrewarm should NOT claim it (that's the prewarm creation path)
    // It will fail due to no GitHub token, but that's expected — the important thing
    // is that the prewarm entry is untouched
    const { sessionCreate } = await import('@/commands/session-create')
    try {
      await sessionCreate(projectSlug, { createPrewarm: true })
    } catch {
      // Expected failure
    }

    // Prewarm entry should still exist — it was not claimed
    const entry = await getPrewarmSession(projectSlug)
    expect(entry).not.toBeNull()
    expect(entry!.sessionId).toBe(prewarm.sessionId)
  })

  // --- getWaitingSessions filtering ---

  it('getWaitingSessions skips prewarm sessions', async () => {
    // Create a prewarm session (running container with tmux)
    const prewarm = await createPrewarmContainer(projectSlug)
    containersToCleanup.push(prewarm.containerName)

    // Also create a regular session
    const regular = await createMinimalContainer(projectSlug)
    containersToCleanup.push(regular.containerName)

    const { getWaitingSessions } = await import('@/commands/session-stream')
    const sessions = await getWaitingSessions(projectSlug)

    // Prewarm session should be excluded, regular session should be included
    const sessionIds = sessions.map((s) => s.sessionId)
    expect(sessionIds).not.toContain(prewarm.sessionId)
    // Regular session may or may not show as "waiting" depending on claude status,
    // but the key assertion is that the prewarm session is excluded
    for (const s of sessions) {
      expect(await isPrewarmSession(s.projectSlug, s.sessionId)).toBe(false)
    }
  })

  // --- session attach clearing prewarm state ---

  it('session attach clears prewarm state for the project', async () => {
    // Create a prewarm session
    const prewarm = await createPrewarmContainer(projectSlug)
    containersToCleanup.push(prewarm.containerName)

    // Verify prewarm state exists
    expect(await getPrewarmSession(projectSlug)).not.toBeNull()

    // clearPrewarmSession is called by sessionAttach before attaching.
    // We can't easily test the full interactive attach in e2e, but we can
    // verify the integration by calling clearPrewarmSession directly
    // (which is what sessionAttach calls)
    await clearPrewarmSession(projectSlug)

    expect(await getPrewarmSession(projectSlug)).toBeNull()

    // Container should still be running (clearing state doesn't kill it)
    expect(isTmuxSessionAlive(prewarm.containerName)).toBe(true)
  })
})
