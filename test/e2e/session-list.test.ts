import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createTempDataDir, cleanupTempDir, createTestRepo, requirePodman, TEST_IMAGE_PREFIX, addTestProject } from '@test/helpers/setup'
import { sessionList } from '@/commands/session-list'
import { podman } from '@/lib/container/runtime'
import { ensureImage } from '@/lib/container/image-builder'
import { claudeDir, worktreeDir, worktreesDir, repoDir, getDataDir } from '@/lib/project/paths'
import { addWorktree, getDefaultBranch } from '@/lib/git'

const execFileAsync = promisify(execFile)

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
    'exec', containerName, 'tmux', 'new-session', '-d', '-s', 'yaac', '-n', 'claude', 'zsh',
  ])

  return { containerName, sessionId }
}

describe('yaac session list', () => {
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

  it('prints empty message when no sessions exist', async () => {
    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)

    const logs: string[] = []
    const origLog = console.log
    console.log = (msg: string) => logs.push(msg)

    await sessionList()

    console.log = origLog
    expect(logs.join('\n')).toContain('No active sessions')
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
        if (!name) continue
        try {
          const c = podman.getContainer(name)
          await c.stop({ t: 1 })
          await c.remove()
        } catch {
          // already gone
        }
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
    expect(output).toContain('Cleaning up')

    // Wait for detached cleanup process to finish
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

    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)

    const repoPath = path.join(tmpDir, 'zombie-proj')
    await createTestRepo(repoPath)
    await addTestProject(repoPath)

    const { containerName, sessionId } = await createMinimalContainer('zombie-proj')
    // Don't add to containersToCleanup — session-list should auto-remove it

    // Kill the tmux session to simulate a zombie container
    // The container stays "running" but tmux has-session will fail
    await execFileAsync('podman', [
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
    // Should show cleanup message
    expect(output).toContain('Cleaning up')

    // Wait for detached cleanup process to finish
    await vi.waitFor(async () => {
      const remaining = await podman.listContainers({
        all: true,
        filters: { label: [`yaac.session-id=${sessionId}`] },
      })
      expect(remaining).toHaveLength(0)
    }, { timeout: 15_000, interval: 500 })
  }, 30_000)

  it('lists deleted sessions from JSONL files', async () => {
    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)

    const repoPath = path.join(tmpDir, 'deleted-proj')
    await createTestRepo(repoPath)
    await addTestProject(repoPath)

    // Create a fake Claude Code session JSONL file
    const sessionsDir = path.join(claudeDir('deleted-proj'), 'projects', '-workspace')
    await fs.mkdir(sessionsDir, { recursive: true })
    const fakeSessionId = crypto.randomUUID()
    await fs.writeFile(
      path.join(sessionsDir, `${fakeSessionId}.jsonl`),
      `{"type":"permission-mode","sessionId":"${fakeSessionId}"}\n`,
    )

    const logs: string[] = []
    const origLog = console.log
    console.log = (msg: string) => logs.push(msg)

    await sessionList('deleted-proj', { deleted: true })

    console.log = origLog
    const output = logs.join('\n')
    expect(output).toContain(fakeSessionId.slice(0, 8))
    expect(output).toContain('deleted-proj')
  })

  it('shows empty message when no deleted sessions', async () => {
    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)

    const repoPath = path.join(tmpDir, 'no-deleted')
    await createTestRepo(repoPath)
    await addTestProject(repoPath)

    const logs: string[] = []
    const origLog = console.log
    console.log = (msg: string) => logs.push(msg)

    await sessionList('no-deleted', { deleted: true })

    console.log = origLog
    expect(logs.join('\n')).toContain('No deleted sessions')
  })
})
