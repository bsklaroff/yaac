import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir, createTestRepo, podmanAvailable } from '@test/helpers/setup'
import { projectAdd } from '@/commands/project-add'
import { podman } from '@/lib/podman'
import { resolveContainer } from '@/lib/container-resolve'
import { ensureImage } from '@/lib/image-builder'
import { claudeDir, worktreeDir, worktreesDir, repoDir } from '@/lib/paths'
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
      'yaac.managed': 'true',
      'yaac.project': projectSlug,
      'yaac.session-id': sessionId,
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
  let tmpDir: string
  let isPodmanAvailable: boolean
  const containersToCleanup: string[] = []

  beforeAll(async () => {
    isPodmanAvailable = await podmanAvailable()
  })

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
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
    await cleanupTempDir(tmpDir)
  })

  it('resolves container by session ID', async () => {
    if (!isPodmanAvailable) return

    const repoPath = path.join(tmpDir, 'shell-proj')
    await createTestRepo(repoPath)
    await projectAdd(repoPath)

    const { containerName, sessionId } = await createMinimalContainer('shell-proj')
    containersToCleanup.push(containerName)

    const resolved = await resolveContainer(sessionId)
    expect(resolved).toBe(containerName)
  })

  it('resolves container by prefix match on session ID', async () => {
    if (!isPodmanAvailable) return

    const repoPath = path.join(tmpDir, 'prefix-proj')
    await createTestRepo(repoPath)
    await projectAdd(repoPath)

    const { containerName, sessionId } = await createMinimalContainer('prefix-proj')
    containersToCleanup.push(containerName)

    // Use first 4 chars as prefix
    const prefix = sessionId.slice(0, 4)
    const resolved = await resolveContainer(prefix)
    expect(resolved).toBe(containerName)
  })

  it('resolves container by full container name', async () => {
    if (!isPodmanAvailable) return

    const repoPath = path.join(tmpDir, 'name-proj')
    await createTestRepo(repoPath)
    await projectAdd(repoPath)

    const { containerName } = await createMinimalContainer('name-proj')
    containersToCleanup.push(containerName)

    const resolved = await resolveContainer(containerName)
    expect(resolved).toBe(containerName)
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
