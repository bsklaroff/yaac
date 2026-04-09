import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { createTempDataDir, cleanupTempDir, createTestRepo, podmanAvailable } from '@test/helpers/setup'
import { projectAdd } from '@/commands/project-add'
import { sessionList } from '@/commands/session-list'
import { podman } from '@/lib/podman'
import { ensureImage } from '@/lib/image-builder'
import { claudeDir, worktreeDir, worktreesDir, repoDir, getDataDir } from '@/lib/paths'
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
  return containerName
}

describe('yaac session list', () => {
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
      if (!isPodmanAvailable) return
      tmpDir = await createTempDataDir()

      const repoA = path.join(tmpDir, 'proj-a')
      const repoB = path.join(tmpDir, 'proj-b')
      await createTestRepo(repoA)
      await createTestRepo(repoB)
      await projectAdd(repoA)
      await projectAdd(repoB)

      containerA = await createMinimalContainer('proj-a')
      containerB = await createMinimalContainer('proj-b')
    })

    afterAll(async () => {
      if (!isPodmanAvailable) return
      for (const name of [containerA, containerB]) {
        try {
          const c = podman.getContainer(name)
          await c.stop({ t: 1 })
          await c.remove()
        } catch {
          // already gone
        }
      }
      await cleanupTempDir(tmpDir)
    })

    it('lists running sessions with metadata', async () => {
      if (!isPodmanAvailable) return

      const logs: string[] = []
      const origLog = console.log
      console.log = (msg: string) => logs.push(msg)

      await sessionList()

      console.log = origLog
      const output = logs.join('\n')
      expect(output).toContain('proj-a')
      expect(output).toContain('running')
    })

    it('filters by project when argument is provided', async () => {
      if (!isPodmanAvailable) return

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
    if (!isPodmanAvailable) return

    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)

    const repoPath = path.join(tmpDir, 'stopped-proj')
    await createTestRepo(repoPath)
    await projectAdd(repoPath)

    const containerName = await createMinimalContainer('stopped-proj')
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
  })

  it('lists deleted sessions from JSONL files', async () => {
    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)

    const repoPath = path.join(tmpDir, 'deleted-proj')
    await createTestRepo(repoPath)
    await projectAdd(repoPath)

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
    await projectAdd(repoPath)

    const logs: string[] = []
    const origLog = console.log
    console.log = (msg: string) => logs.push(msg)

    await sessionList('no-deleted', { deleted: true })

    console.log = origLog
    expect(logs.join('\n')).toContain('No deleted sessions')
  })
})
