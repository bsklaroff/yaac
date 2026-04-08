import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { createTempDataDir, cleanupTempDir, createTestRepo, podmanAvailable } from '@test/helpers/setup'
import { projectAdd } from '@/commands/project-add'
import { sessionList } from '@/commands/session-list'
import { podman } from '@/lib/podman'
import { ensureImage } from '@/lib/image-builder'
import { claudeDir, worktreeDir, worktreesDir, repoDir } from '@/lib/paths'
import { addWorktree, getDefaultBranch } from '@/lib/git'

async function createMinimalContainer(projectSlug: string): Promise<string> {
  const imageName = await ensureImage(projectSlug)
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
  return containerName
}

describe('yaac session list', () => {
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

  it('prints empty message when no sessions exist', async () => {
    const logs: string[] = []
    const origLog = console.log
    console.log = (msg: string) => logs.push(msg)

    await sessionList()

    console.log = origLog
    expect(logs.join('\n')).toContain('No active sessions')
  })

  it('lists running sessions with metadata', async () => {
    if (!isPodmanAvailable) return

    const repoPath = path.join(tmpDir, 'list-project')
    await createTestRepo(repoPath)
    await projectAdd(repoPath)

    const containerName = await createMinimalContainer('list-project')
    containersToCleanup.push(containerName)

    const logs: string[] = []
    const origLog = console.log
    console.log = (msg: string) => logs.push(msg)

    await sessionList()

    console.log = origLog
    const output = logs.join('\n')
    expect(output).toContain('list-project')
    expect(output).toContain(containerName)
    expect(output).toContain('running')
  })

  it('filters by project when argument is provided', async () => {
    if (!isPodmanAvailable) return

    const repo1 = path.join(tmpDir, 'proj-a')
    const repo2 = path.join(tmpDir, 'proj-b')
    await createTestRepo(repo1)
    await createTestRepo(repo2)
    await projectAdd(repo1)
    await projectAdd(repo2)

    const container1 = await createMinimalContainer('proj-a')
    const container2 = await createMinimalContainer('proj-b')
    containersToCleanup.push(container1, container2)

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
    if (!isPodmanAvailable) return

    const repo1 = path.join(tmpDir, 'all-a')
    const repo2 = path.join(tmpDir, 'all-b')
    await createTestRepo(repo1)
    await createTestRepo(repo2)
    await projectAdd(repo1)
    await projectAdd(repo2)

    const container1 = await createMinimalContainer('all-a')
    const container2 = await createMinimalContainer('all-b')
    containersToCleanup.push(container1, container2)

    const logs: string[] = []
    const origLog = console.log
    console.log = (msg: string) => logs.push(msg)

    await sessionList()

    console.log = origLog
    const output = logs.join('\n')
    expect(output).toContain('all-a')
    expect(output).toContain('all-b')
  })

  it('correctly reports stopped container status', async () => {
    if (!isPodmanAvailable) return

    const repoPath = path.join(tmpDir, 'stopped-proj')
    await createTestRepo(repoPath)
    await projectAdd(repoPath)

    const containerName = await createMinimalContainer('stopped-proj')
    containersToCleanup.push(containerName)

    // Stop the container
    const c = podman.getContainer(containerName)
    await c.stop({ t: 1 })

    const logs: string[] = []
    const origLog = console.log
    console.log = (msg: string) => logs.push(msg)

    await sessionList()

    console.log = origLog
    const output = logs.join('\n')
    expect(output).toContain('stopped-proj')
    expect(output).toContain('exited')
  })
})
