import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { createTempDataDir, cleanupTempDir, createTestRepo, requirePodman, TEST_IMAGE_PREFIX, addTestProject, removeContainer } from '@test/helpers/setup'
import { bootInProcessDaemon, type InProcessDaemon } from '@test/helpers/daemon'
import { sessionDelete } from '@/commands/session-delete'
import { exitOnClientError } from '@/lib/daemon-client'
import { podman } from '@/lib/container/runtime'
import { ensureImage } from '@/lib/container/image-builder'
import { claudeDir, worktreeDir, worktreesDir, repoDir, getDataDir } from '@/lib/project/paths'
import { addWorktree } from '@/lib/git'

async function createMinimalContainer(projectSlug: string): Promise<{ containerName: string; sessionId: string }> {
  const imageName = await ensureImage(projectSlug, TEST_IMAGE_PREFIX, true)
  const sessionId = crypto.randomUUID()
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

describe('yaac session delete', { timeout: 120_000 }, () => {
  let tmpDir: string
  let daemon: InProcessDaemon
  const containersToCleanup: string[] = []

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    daemon = await bootInProcessDaemon()
  })

  afterEach(async () => {
    for (const name of containersToCleanup) {
      await removeContainer(name)
    }
    containersToCleanup.length = 0
    await daemon.stop()
    if (tmpDir) await cleanupTempDir(tmpDir)
  })

  it('deletes a running session', async () => {
    await requirePodman()

    const repoPath = path.join(tmpDir, 'del-running')
    await createTestRepo(repoPath)
    await addTestProject(repoPath)

    const { sessionId } = await createMinimalContainer('del-running')
    // Don't add to cleanup — sessionDelete should remove it

    await sessionDelete(sessionId)

    // Wait for detached cleanup process to finish
    await vi.waitFor(async () => {
      const containers = await podman.listContainers({
        all: true,
        filters: { label: [`yaac.session-id=${sessionId}`] },
      })
      expect(containers).toHaveLength(0)
    }, { timeout: 15_000, interval: 500 })

    // Worktree should be gone (removed after container, so poll for it)
    const wtDir = worktreeDir('del-running', sessionId)
    await vi.waitFor(async () => {
      await expect(fs.access(wtDir)).rejects.toThrow()
    }, { timeout: 15_000, interval: 500 })
  })

  it('deletes a stopped session', async () => {
    await requirePodman()

    const repoPath = path.join(tmpDir, 'del-stopped')
    await createTestRepo(repoPath)
    await addTestProject(repoPath)

    const { containerName, sessionId } = await createMinimalContainer('del-stopped')

    // Stop the container first
    await podman.getContainer(containerName).stop({ t: 1 })

    await sessionDelete(sessionId)

    // Wait for detached cleanup process to finish
    await vi.waitFor(async () => {
      const containers = await podman.listContainers({
        all: true,
        filters: { label: [`yaac.session-id=${sessionId}`] },
      })
      expect(containers).toHaveLength(0)
    }, { timeout: 15_000, interval: 500 })
  })

  it('errors on unknown session ID', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`)
    }) as never)
    const origErr = console.error
    console.error = () => {}
    try {
      await sessionDelete('nonexistent-id')
    } catch (err) {
      try { exitOnClientError(err) } catch { /* exit spy throws */ }
    }
    console.error = origErr
    expect(exitSpy).toHaveBeenCalledWith(1)
    exitSpy.mockRestore()
  })
})
