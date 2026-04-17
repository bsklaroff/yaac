import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir, createTestRepo, requirePodman, TEST_IMAGE_PREFIX, addTestProject, podmanRetry } from '@test/helpers/setup'
import { podman } from '@/lib/container/runtime'
import { resolveContainer } from '@/lib/container/resolve'
import { ensureImage } from '@/lib/container/image-builder'
import { claudeDir, worktreeDir, worktreesDir, repoDir, getDataDir } from '@/lib/project/paths'
import { addWorktree } from '@/lib/git'
import crypto from 'node:crypto'

async function createContainerWithTmux(projectSlug: string): Promise<{ containerName: string; sessionId: string }> {
  const imageName = await ensureImage(projectSlug, TEST_IMAGE_PREFIX, true)
  const sessionId = crypto.randomBytes(4).toString('hex')
  const wtDir = worktreeDir(projectSlug, sessionId)
  await fs.mkdir(worktreesDir(projectSlug), { recursive: true })
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

  // Start tmux session with zsh (not claude, since claude isn't installed in test image)
  await podmanRetry([
    'exec', containerName, 'tmux', 'new-session', '-d', '-s', 'yaac', '-n', 'claude', 'zsh',
  ])

  return { containerName, sessionId }
}

describe('yaac session attach', () => {
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

  describe('container resolution (shared session)', () => {
    let containerName: string
    let sessionId: string
    let tmpDir: string

    beforeAll(async () => {
      await requirePodman()
      tmpDir = await createTempDataDir()
      const repoPath = path.join(tmpDir, 'attach-shared')
      await createTestRepo(repoPath)
      await addTestProject(repoPath)
      const result = await createContainerWithTmux('attach-shared')
      containerName = result.containerName
      sessionId = result.sessionId
    })

    afterAll(async () => {
      try {
        if (containerName) {
          const c = podman.getContainer(containerName)
          await c.stop({ t: 1 })
          await c.remove()
        }
      } catch {
        // already gone
      }
      if (tmpDir) await cleanupTempDir(tmpDir)
    })

    it('resolves container and verifies tmux session exists', async () => {
      // Verify container resolves
      const resolved = await resolveContainer(sessionId)
      expect(resolved).toBe(containerName)

      // Verify tmux session exists (the actual attach would be interactive)
      const { stdout } = await podmanRetry([
        'exec', containerName, 'tmux', 'list-sessions',
      ])
      expect(stdout).toContain('yaac')
    })

    it('resolves container by prefix match', async () => {
      const resolved = await resolveContainer(sessionId.slice(0, 4))
      expect(resolved).toBe(containerName)
    })

    it('resolves by full container name', async () => {
      const resolved = await resolveContainer(containerName)
      expect(resolved).toBe(containerName)
    })
  })

  it('errors on unknown container ID', async () => {
    process.exitCode = undefined
    const resolved = await resolveContainer('nonexistent')
    expect(resolved).toBeNull()
    expect(process.exitCode).toBe(1)
    process.exitCode = undefined
  })

  it('errors on stopped container', async () => {
    await requirePodman()

    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)
    const repoPath = path.join(tmpDir, 'attach-stopped')
    await createTestRepo(repoPath)
    await addTestProject(repoPath)

    const { containerName, sessionId } = await createContainerWithTmux('attach-stopped')
    containersToCleanup.push(containerName)

    await podman.getContainer(containerName).stop({ t: 1 })

    process.exitCode = undefined
    const resolved = await resolveContainer(sessionId)
    expect(resolved).toBeNull()
    expect(process.exitCode).toBe(1)
    process.exitCode = undefined
  })
})
