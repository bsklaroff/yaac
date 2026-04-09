import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir, createTestRepo, podmanAvailable } from '@test/helpers/setup'
import { projectAdd } from '@/commands/project-add'
import { podman } from '@/lib/podman'
import { resolveContainer } from '@/lib/container-resolve'
import { ensureImage } from '@/lib/image-builder'
import { claudeDir, worktreeDir, worktreesDir, repoDir, getDataDir } from '@/lib/paths'
import { addWorktree } from '@/lib/git'
import crypto from 'node:crypto'

async function createMinimalContainer(projectSlug: string): Promise<{ containerName: string; sessionId: string }> {
  const imageName = await ensureImage(projectSlug)
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
  let isPodmanAvailable: boolean
  const containersToCleanup: string[] = []
  const tmpDirs: string[] = []

  beforeAll(async () => {
    isPodmanAvailable = await podmanAvailable()
  })

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
      if (!isPodmanAvailable) return
      tmpDir = await createTempDataDir()
      const repoPath = path.join(tmpDir, 'shared-proj')
      await createTestRepo(repoPath)
      await projectAdd(repoPath)
      const result = await createMinimalContainer('shared-proj')
      containerName = result.containerName
      sessionId = result.sessionId
    })

    afterAll(async () => {
      if (!isPodmanAvailable) return
      try {
        const c = podman.getContainer(containerName)
        await c.stop({ t: 1 })
        await c.remove()
      } catch {
        // already gone
      }
      await cleanupTempDir(tmpDir)
    })

    it('resolves container by session ID', async () => {
      if (!isPodmanAvailable) return

      const resolved = await resolveContainer(sessionId)
      expect(resolved).toBe(containerName)
    })

    it('resolves container by prefix match on session ID', async () => {
      if (!isPodmanAvailable) return

      // Use first 4 chars as prefix
      const prefix = sessionId.slice(0, 4)
      const resolved = await resolveContainer(prefix)
      expect(resolved).toBe(containerName)
    })

    it('resolves container by full container name', async () => {
      if (!isPodmanAvailable) return

      const resolved = await resolveContainer(containerName)
      expect(resolved).toBe(containerName)
    })
  })

  it('errors on unknown container ID', async () => {
    process.exitCode = undefined
    const resolved = await resolveContainer('nonexistent-id')
    expect(resolved).toBeNull()
    expect(process.exitCode).toBe(1)
    process.exitCode = undefined
  })

  it('errors on stopped container', async () => {
    if (!isPodmanAvailable) return

    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)

    const repoPath = path.join(tmpDir, 'stopped-shell')
    await createTestRepo(repoPath)
    await projectAdd(repoPath)

    const { containerName, sessionId } = await createMinimalContainer('stopped-shell')
    containersToCleanup.push(containerName)

    // Stop the container
    await podman.getContainer(containerName).stop({ t: 1 })

    process.exitCode = undefined
    const resolved = await resolveContainer(sessionId)
    expect(resolved).toBeNull()
    expect(process.exitCode).toBe(1)
    process.exitCode = undefined
  })
})
