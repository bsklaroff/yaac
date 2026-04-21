import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { createTempDataDir, cleanupTempDir, createTestRepo, requirePodman, TEST_IMAGE_PREFIX, addTestProject, podmanRetry, removeContainer } from '@test/helpers/setup'
import { bootInProcessDaemon, type InProcessDaemon } from '@test/helpers/daemon'
import { sessionList } from '@/commands/session-list'
import { reconcileStaleSessions } from '@/lib/session/list'
import { podman } from '@/lib/container/runtime'
import { ensureImage } from '@/lib/container/image-builder'
import { claudeDir, worktreeDir, worktreesDir, repoDir, getDataDir } from '@/lib/project/paths'
import { addWorktree, getDefaultBranch } from '@/lib/git'

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
  await podmanRetry([
    'exec', containerName, 'tmux', 'new-session', '-d', '-s', 'yaac', '-n', 'claude', 'zsh',
  ])

  return { containerName, sessionId }
}

describe('yaac session list', () => {
  const containersToCleanup: string[] = []
  const tmpDirs: string[] = []
  let daemon: InProcessDaemon

  beforeEach(async () => {
    daemon = await bootInProcessDaemon()
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await daemon.stop()
    for (const name of containersToCleanup) {
      await removeContainer(name)
    }
    containersToCleanup.length = 0
    for (const dir of tmpDirs) {
      await cleanupTempDir(dir)
    }
    tmpDirs.length = 0
  })

  describe('with running sessions (shared)', () => {
    let tmpDir: string
    let containerA: string
    let containerB: string

    beforeAll(async () => {
      await requirePodman()
      tmpDir = await createTempDataDir()

      const repoA = path.join(tmpDir, 'proj-a')
      const repoB = path.join(tmpDir, 'proj-b')
      await createTestRepo(repoA)
      await createTestRepo(repoB)
      await addTestProject(repoA)
      await addTestProject(repoB)

      ;({ containerName: containerA } = await createMinimalContainer('proj-a'))
      ;({ containerName: containerB } = await createMinimalContainer('proj-b'))
    })

    afterAll(async () => {
      for (const name of [containerA, containerB]) {
        if (name) await removeContainer(name)
      }
      if (tmpDir) await cleanupTempDir(tmpDir)
    })

    it('lists running sessions with metadata', async () => {
      const logs: string[] = []
      const origLog = console.log
      console.log = (msg: string) => logs.push(msg)

      await sessionList()

      console.log = origLog
      const output = logs.join('\n')
      expect(output).toContain('proj-a')
      expect(output).toContain('waiting')
    })

    it('filters by project when argument is provided', async () => {
      const logs: string[] = []
      const origLog = console.log
      console.log = (msg: string) => logs.push(msg)

      await sessionList('proj-a')

      console.log = origLog
      const output = logs.join('\n')
      expect(output).toContain('proj-a')
      expect(output).not.toContain('proj-b')
    })

    it('shows all sessions when no project filter', async () => {
      const logs: string[] = []
      const origLog = console.log
      console.log = (msg: string) => logs.push(msg)

      await sessionList()

      console.log = origLog
      const output = logs.join('\n')
      expect(output).toContain('proj-a')
      expect(output).toContain('proj-b')
    })
  })

  it('auto-cleans exited containers from the list', async () => {
    await requirePodman()
    vi.stubEnv('YAAC_STARTING_GRACE_MS', '0')

    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)

    const repoPath = path.join(tmpDir, 'stopped-proj')
    await createTestRepo(repoPath)
    await addTestProject(repoPath)

    const { containerName, sessionId } = await createMinimalContainer('stopped-proj')
    // Don't add to containersToCleanup — session-list should auto-remove it

    // Stop the container
    const c = podman.getContainer(containerName)
    await c.stop({ t: 1 })

    const logs: string[] = []
    const origLog = console.log
    console.log = (msg: string) => logs.push(msg)

    await sessionList()

    console.log = origLog
    const output = logs.join('\n')
    expect(output).not.toContain('stopped-proj')
    expect(output).not.toContain('exited')
    expect(output).toContain('No active sessions')

    // The background loop owns stale-container reaping. Run a single tick of its
    // reconcile step to simulate the loop catching this container.
    await reconcileStaleSessions()

    await vi.waitFor(async () => {
      const remaining = await podman.listContainers({
        all: true,
        filters: { label: [`yaac.session-id=${sessionId}`] },
      })
      expect(remaining).toHaveLength(0)
    }, { timeout: 15_000, interval: 500 })
  }, 30_000)

  it('auto-cleans zombie containers (running but tmux dead)', async () => {
    await requirePodman()
    vi.stubEnv('YAAC_STARTING_GRACE_MS', '0')

    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)

    const repoPath = path.join(tmpDir, 'zombie-proj')
    await createTestRepo(repoPath)
    await addTestProject(repoPath)

    const { containerName, sessionId } = await createMinimalContainer('zombie-proj')
    // Don't add to containersToCleanup — session-list should auto-remove it

    // Kill the tmux session to simulate a zombie container
    // The container stays "running" but tmux has-session will fail
    await podmanRetry([
      'exec', containerName, 'tmux', 'kill-session', '-t', 'yaac',
    ])

    const logs: string[] = []
    const origLog = console.log
    console.log = (msg: string) => logs.push(msg)

    await sessionList()

    console.log = origLog
    const output = logs.join('\n')

    // Should not appear as an active session
    expect(output).not.toContain('zombie-proj')

    // Background loop reaps; simulate a single tick.
    await reconcileStaleSessions()

    await vi.waitFor(async () => {
      const remaining = await podman.listContainers({
        all: true,
        filters: { label: [`yaac.session-id=${sessionId}`] },
      })
      expect(remaining).toHaveLength(0)
    }, { timeout: 15_000, interval: 500 })
  }, 30_000)

})
