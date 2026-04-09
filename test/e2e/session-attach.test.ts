import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createTempDataDir, cleanupTempDir, createTestRepo, podmanAvailable } from '@test/helpers/setup'
import { projectAdd } from '@/commands/project-add'
import { podman } from '@/lib/podman'
import { resolveContainer } from '@/lib/container-resolve'
import { ensureImage } from '@/lib/image-builder'
import { claudeDir, worktreeDir, worktreesDir, repoDir, getDataDir } from '@/lib/paths'
import { addWorktree } from '@/lib/git'
import crypto from 'node:crypto'

const execFileAsync = promisify(execFile)

async function createContainerWithTmux(projectSlug: string): Promise<{ containerName: string; sessionId: string }> {
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
        `${claudeDir(projectSlug)}:/root/.claude:Z`,
      ],
    },
  })
  await container.start()

  // Start tmux session with bash (not claude, since claude isn't installed in test image)
  await execFileAsync('podman', [
    'exec', containerName, 'tmux', 'new-session', '-d', '-s', 'claude', 'bash',
  ])

  return { containerName, sessionId }
}

describe('yaac session attach', () => {
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
      const repoPath = path.join(tmpDir, 'attach-shared')
      await createTestRepo(repoPath)
      await projectAdd(repoPath)
      const result = await createContainerWithTmux('attach-shared')
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

    it('resolves container and verifies tmux session exists', async () => {
      if (!isPodmanAvailable) return

      // Verify container resolves
      const resolved = await resolveContainer(sessionId)
      expect(resolved).toBe(containerName)

      // Verify tmux session exists (the actual attach would be interactive)
      const { stdout } = await execFileAsync('podman', [
        'exec', containerName, 'tmux', 'list-sessions',
      ])
      expect(stdout).toContain('claude')
    })

    it('resolves container by prefix match', async () => {
      if (!isPodmanAvailable) return

      const resolved = await resolveContainer(sessionId.slice(0, 4))
      expect(resolved).toBe(containerName)
    })

    it('resolves by full container name', async () => {
      if (!isPodmanAvailable) return

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
    if (!isPodmanAvailable) return

    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)
    const repoPath = path.join(tmpDir, 'attach-stopped')
    await createTestRepo(repoPath)
    await projectAdd(repoPath)

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
