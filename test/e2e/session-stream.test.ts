import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { createTempDataDir, cleanupTempDir, createTestRepo, requirePodman, TEST_IMAGE_PREFIX, addTestProject, podmanRetry } from '@test/helpers/setup'
import { podman } from '@/lib/container/runtime'
import { ensureImage } from '@/lib/container/image-builder'
import { claudeDir, worktreeDir, worktreesDir, repoDir, getDataDir } from '@/lib/project/paths'
import { addWorktree, getDefaultBranch } from '@/lib/git'
import { getWaitingSessions, sessionStream } from '@/commands/session-stream'

async function createContainerWithWaitingStatus(projectSlug: string): Promise<{
  containerName: string
  sessionId: string
}> {
  const imageName = await ensureImage(projectSlug, TEST_IMAGE_PREFIX, true)
  const sessionId = crypto.randomBytes(4).toString('hex')
  const wtDir = worktreeDir(projectSlug, sessionId)
  await fs.mkdir(worktreesDir(projectSlug), { recursive: true })
  await getDefaultBranch(repoDir(projectSlug))
  await addWorktree(repoDir(projectSlug), wtDir, `yaac/${sessionId}`)

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

  // Start tmux session with zsh
  await podmanRetry([
    'exec', containerName, 'tmux', 'new-session', '-d', '-s', 'yaac', '-n', 'claude', 'zsh',
  ])

  // Write JSONL to simulate "waiting" status
  const sessionsDir = path.join(claudeDir(projectSlug), 'projects', '-workspace')
  await fs.mkdir(sessionsDir, { recursive: true })
  await fs.writeFile(
    path.join(sessionsDir, `${sessionId}.jsonl`),
    JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn' } }) + '\n',
  )

  return { containerName, sessionId }
}

async function createContainerWithRunningStatus(projectSlug: string): Promise<{
  containerName: string
  sessionId: string
}> {
  const imageName = await ensureImage(projectSlug, TEST_IMAGE_PREFIX, true)
  const sessionId = crypto.randomBytes(4).toString('hex')
  const wtDir = worktreeDir(projectSlug, sessionId)
  await fs.mkdir(worktreesDir(projectSlug), { recursive: true })
  await getDefaultBranch(repoDir(projectSlug))
  await addWorktree(repoDir(projectSlug), wtDir, `yaac/${sessionId}`)

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

  // Start tmux but write a "running" JSONL (tool_use stop_reason)
  await podmanRetry([
    'exec', containerName, 'tmux', 'new-session', '-d', '-s', 'yaac', '-n', 'claude', 'zsh',
  ])

  const sessionsDir = path.join(claudeDir(projectSlug), 'projects', '-workspace')
  await fs.mkdir(sessionsDir, { recursive: true })
  await fs.writeFile(
    path.join(sessionsDir, `${sessionId}.jsonl`),
    JSON.stringify({ type: 'assistant', message: { stop_reason: 'tool_use' } }) + '\n',
  )

  return { containerName, sessionId }
}

describe('yaac session stream', () => {
  const containersToCleanup: string[] = []
  const tmpDirs: string[] = []

  afterEach(async () => {
    for (const name of containersToCleanup) {
      try {
        const c = podman.getContainer(name)
        await c.stop({ t: 1 })
        await c.remove()
      } catch {
        // already gone
      }
    }
    containersToCleanup.length = 0
    for (const dir of tmpDirs) {
      await cleanupTempDir(dir)
    }
    tmpDirs.length = 0
  })

  it('exits immediately when no waiting sessions exist', async () => {
    await requirePodman()

    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)

    const logs: string[] = []
    const origLog = console.log
    console.log = (msg: string) => logs.push(msg)

    await sessionStream()

    console.log = origLog
    expect(logs.join('\n')).toContain('No projects found')
  })

  describe('getWaitingSessions with real containers (shared)', () => {
    let tmpDir: string
    let containerA: { containerName: string; sessionId: string }
    let containerB: { containerName: string; sessionId: string }

    beforeAll(async () => {
      await requirePodman()
      tmpDir = await createTempDataDir()

      const repoPath = path.join(tmpDir, 'stream-proj')
      await createTestRepo(repoPath)
      await addTestProject(repoPath)

      containerA = await createContainerWithWaitingStatus('stream-proj')
      // Small delay to ensure different Created timestamps
      await new Promise((r) => setTimeout(r, 1100))
      containerB = await createContainerWithWaitingStatus('stream-proj')
    })

    afterAll(async () => {
      for (const c of [containerA, containerB]) {
        if (!c) continue
        try {
          const container = podman.getContainer(c.containerName)
          await container.stop({ t: 1 })
          await container.remove()
        } catch {
          // already gone
        }
      }
      if (tmpDir) await cleanupTempDir(tmpDir)
    })

    it('returns sessions sorted oldest first', async () => {
      const sessions = await getWaitingSessions()
      expect(sessions.length).toBeGreaterThanOrEqual(2)

      const idxA = sessions.findIndex((s) => s.sessionId === containerA.sessionId)
      const idxB = sessions.findIndex((s) => s.sessionId === containerB.sessionId)
      expect(idxA).toBeLessThan(idxB)
    })

    it('skips sessions with cleanup already in progress', async () => {
      const sessions = await getWaitingSessions(undefined, new Set([containerA.sessionId]))
      const ids = sessions.map((s) => s.sessionId)
      expect(ids).not.toContain(containerA.sessionId)
      expect(ids).toContain(containerB.sessionId)
    })
  })

  describe('project filtering (shared)', () => {
    let tmpDir: string
    let containerA: { containerName: string; sessionId: string }
    let containerB: { containerName: string; sessionId: string }

    beforeAll(async () => {
      await requirePodman()
      tmpDir = await createTempDataDir()

      const repoA = path.join(tmpDir, 'stream-a')
      const repoB = path.join(tmpDir, 'stream-b')
      await createTestRepo(repoA)
      await createTestRepo(repoB)
      await addTestProject(repoA)
      await addTestProject(repoB)

      containerA = await createContainerWithWaitingStatus('stream-a')
      containerB = await createContainerWithWaitingStatus('stream-b')
    })

    afterAll(async () => {
      for (const c of [containerA, containerB]) {
        if (!c) continue
        try {
          const container = podman.getContainer(c.containerName)
          await container.stop({ t: 1 })
          await container.remove()
        } catch {
          // already gone
        }
      }
      if (tmpDir) await cleanupTempDir(tmpDir)
    })

    it('filters by project slug', async () => {
      const sessions = await getWaitingSessions('stream-a')
      const slugs = sessions.map((s) => s.projectSlug)
      expect(slugs).toContain('stream-a')
      expect(slugs).not.toContain('stream-b')
    })
  })

  it('skips non-waiting (running status) sessions', async () => {
    await requirePodman()

    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)

    const repoPath = path.join(tmpDir, 'stream-running')
    await createTestRepo(repoPath)
    await addTestProject(repoPath)

    const { containerName } = await createContainerWithRunningStatus('stream-running')
    containersToCleanup.push(containerName)

    const sessions = await getWaitingSessions()
    const slugs = sessions.map((s) => s.projectSlug)
    expect(slugs).not.toContain('stream-running')
  })
})
