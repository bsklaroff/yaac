import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { createTempDataDir, cleanupTempDir, createTestRepo, requirePodman, TEST_IMAGE_PREFIX, addTestProject, podmanRetry, removeContainer } from '@test/helpers/setup'
import { podman } from '@/lib/container/runtime'
import { resolveContainerAnyState } from '@/lib/container/resolve'
import { ensureImage } from '@/lib/container/image-builder'
import { claudeDir, worktreeDir, worktreesDir, repoDir, getDataDir } from '@/lib/project/paths'
import { addWorktree } from '@/lib/git'

async function createContainer(projectSlug: string): Promise<{ containerName: string; sessionId: string }> {
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

  return { containerName, sessionId }
}

describe('yaac session shell', () => {
  const containersToCleanup: string[] = []
  const tmpDirs: string[] = []

  afterEach(async () => {
    for (const name of containersToCleanup) {
      await removeContainer(name)
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
      const repoPath = path.join(tmpDir, 'shell-shared')
      await createTestRepo(repoPath)
      await addTestProject(repoPath)
      const result = await createContainer('shell-shared')
      containerName = result.containerName
      sessionId = result.sessionId
    })

    afterAll(async () => {
      if (containerName) await removeContainer(containerName)
      if (tmpDir) await cleanupTempDir(tmpDir)
    })

    it('resolves running container for shell by session ID', async () => {
      const resolved = await resolveContainerAnyState(sessionId)
      expect(resolved).not.toBeNull()
      expect(resolved?.name).toBe(containerName)
      expect(resolved?.state).toBe('running')
    })

    it('resolves running container for shell by prefix', async () => {
      const resolved = await resolveContainerAnyState(sessionId.slice(0, 4))
      expect(resolved?.name).toBe(containerName)
    })

    it('container has zsh available for the shell command', async () => {
      const { stdout } = await podmanRetry([
        'exec', containerName, 'zsh', '-c', 'echo shell-ok',
      ])
      expect(stdout).toContain('shell-ok')
    })
  })

  it('errors on unknown container ID', async () => {
    process.exitCode = undefined
    const resolved = await resolveContainerAnyState('nonexistent-shell')
    expect(resolved).toBeNull()
    expect(process.exitCode).toBe(1)
    process.exitCode = undefined
  })

  it('reports exited state for stopped containers', async () => {
    await requirePodman()

    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)
    const repoPath = path.join(tmpDir, 'shell-stopped')
    await createTestRepo(repoPath)
    await addTestProject(repoPath)

    const { containerName, sessionId } = await createContainer('shell-stopped')
    containersToCleanup.push(containerName)

    await podman.getContainer(containerName).stop({ t: 1 })

    const resolved = await resolveContainerAnyState(sessionId)
    expect(resolved?.state).toBe('exited')
  })
})
