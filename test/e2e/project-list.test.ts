import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir, createTestRepo, addTestProject } from '@test/helpers/setup'
import { bootInProcessDaemon, type InProcessDaemon } from '@test/helpers/daemon'
import { projectList } from '@/commands/project-list'

describe('yaac project list', () => {
  let tmpDir: string
  let daemon: InProcessDaemon

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    daemon = await bootInProcessDaemon()
  })

  afterEach(async () => {
    await daemon.stop()
    await cleanupTempDir(tmpDir)
  })

  it('prints empty message when no projects exist', async () => {
    const logs: string[] = []
    const origLog = console.log
    console.log = (msg: string) => logs.push(msg)

    await projectList()

    console.log = origLog
    expect(logs.join('\n')).toContain('No projects found')
  })

  it('lists projects with slug and remote URL', async () => {
    const repo1 = path.join(tmpDir, 'repo-alpha')
    const repo2 = path.join(tmpDir, 'repo-beta')
    await createTestRepo(repo1)
    await createTestRepo(repo2)

    await addTestProject(repo1)
    await addTestProject(repo2)

    const logs: string[] = []
    const origLog = console.log
    console.log = (msg: string) => logs.push(msg)

    await projectList()

    console.log = origLog
    const output = logs.join('\n')
    expect(output).toContain('repo-alpha')
    expect(output).toContain('repo-beta')
    expect(output).toContain(repo1)
    expect(output).toContain(repo2)
  })

  it('shows 0 sessions when no containers are running', async () => {
    const repo = path.join(tmpDir, 'repo-gamma')
    await createTestRepo(repo)
    await addTestProject(repo)

    const logs: string[] = []
    const origLog = console.log
    console.log = (msg: string) => logs.push(msg)

    await projectList()

    console.log = origLog
    const output = logs.join('\n')
    expect(output).toContain('repo-gamma')
    // Session count should be 0
    expect(output).toMatch(/repo-gamma\s+.*\s+0/)
  })
})
