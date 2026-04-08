import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir, createTestRepo, getDataDir } from '@test/helpers/setup'
import { projectAdd } from '@/commands/project-add'
import type { ProjectMeta } from '@/types'

describe('yaac project add', () => {
  let tmpDir: string
  let testRepoDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    testRepoDir = path.join(tmpDir, 'test-source-repo')
    await createTestRepo(testRepoDir)
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('clones a repo and creates project structure', async () => {
    await projectAdd(testRepoDir)

    const projectsDir = path.join(getDataDir(), 'projects', 'test-source-repo')

    // project.json exists
    const metaRaw = await fs.readFile(path.join(projectsDir, 'project.json'), 'utf8')
    const meta = JSON.parse(metaRaw) as ProjectMeta
    expect(meta.slug).toBe('test-source-repo')
    expect(meta.remoteUrl).toBe(testRepoDir)
    expect(meta.addedAt).toBeTruthy()

    // repo/ was cloned
    const readme = await fs.readFile(path.join(projectsDir, 'repo', 'README.md'), 'utf8')
    expect(readme).toContain('Test repo')

    // claude/ dir exists
    await expect(fs.access(path.join(projectsDir, 'claude'))).resolves.toBeUndefined()
  })

  it('derives correct slug from URL with .git suffix', async () => {
    // Simulate a .git-suffixed URL by renaming
    const renamedRepo = testRepoDir + '.git'
    await fs.rename(testRepoDir, renamedRepo)

    await projectAdd(renamedRepo)

    const projectsDir = path.join(getDataDir(), 'projects', 'test-source-repo')
    const metaRaw = await fs.readFile(path.join(projectsDir, 'project.json'), 'utf8')
    const meta = JSON.parse(metaRaw) as ProjectMeta
    expect(meta.slug).toBe('test-source-repo')
  })

  it('errors gracefully on duplicate slug', async () => {
    await projectAdd(testRepoDir)

    // Capture exitCode
    process.exitCode = undefined
    await projectAdd(testRepoDir)
    expect(process.exitCode).toBe(1)
    process.exitCode = undefined
  })

  it('errors gracefully on invalid URL', async () => {
    process.exitCode = undefined
    await projectAdd('/nonexistent/path/to/repo')
    expect(process.exitCode).toBe(1)
    process.exitCode = undefined
  })
})
