import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import simpleGit from 'simple-git'
import { setDataDir, projectDir, repoDir } from '@yaac/shared/project-paths'
import { getProjectBranches } from '#lib/project/branches'
import { setProjectReferenceBranch } from '#lib/project/local-config'
import { cloneRepo } from '#lib/git'

describe('getProjectBranches', () => {
  let tmp: string
  let sourceRepo: string
  const slug = 'proj'

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-branches-test-'))
    setDataDir(tmp)
    await fs.mkdir(projectDir(slug), { recursive: true })
    await fs.writeFile(path.join(projectDir(slug), 'project.json'), '{}')

    sourceRepo = path.join(tmp, 'source')
    await fs.mkdir(sourceRepo, { recursive: true })
    const git = simpleGit(sourceRepo)
    await git.raw(['init', '-b', 'main'])
    await git.addConfig('user.email', 'test@test.com')
    await git.addConfig('user.name', 'Test')
    await fs.writeFile(path.join(sourceRepo, 'hello.txt'), 'hello\n')
    await git.add('.')
    await git.commit('initial')
    await git.checkoutLocalBranch('develop')
    await git.checkout('main')

    await cloneRepo(sourceRepo, repoDir(slug), null)
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('returns branches, the default branch, and a null referenceBranch when unset', async () => {
    const result = await getProjectBranches(slug)
    expect(result.branches).toContain('main')
    expect(result.branches).toContain('develop')
    expect(result.branches).not.toContain('HEAD')
    expect(result.defaultBranch).toBe('main')
    expect(result.referenceBranch).toBeNull()
  })

  it('surfaces the configured referenceBranch', async () => {
    await setProjectReferenceBranch(slug, 'develop')
    const result = await getProjectBranches(slug)
    expect(result.referenceBranch).toBe('develop')
  })

  it('refresh picks up a branch pushed after the clone', async () => {
    const git = simpleGit(sourceRepo)
    await git.checkoutLocalBranch('feature/new')
    await git.checkout('main')

    expect((await getProjectBranches(slug)).branches).not.toContain('feature/new')
    const refreshed = await getProjectBranches(slug, { refresh: true })
    expect(refreshed.branches).toContain('feature/new')
  })

  it('throws NOT_FOUND for an unknown project', async () => {
    await expect(getProjectBranches('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
