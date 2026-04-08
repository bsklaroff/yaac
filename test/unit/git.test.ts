import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import simpleGit from 'simple-git'
import { cloneRepo, getDefaultBranch, addWorktree, removeWorktree, fetchAndPullDefault } from '@/lib/git'

describe('git helpers', () => {
  let tmpDir: string
  let sourceRepo: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-git-test-'))
    sourceRepo = path.join(tmpDir, 'source')

    // Create a source repo with a commit
    await fs.mkdir(sourceRepo, { recursive: true })
    const git = simpleGit(sourceRepo)
    await git.init()
    await git.addConfig('user.email', 'test@test.com')
    await git.addConfig('user.name', 'Test')
    await fs.writeFile(path.join(sourceRepo, 'hello.txt'), 'hello world\n')
    await git.add('.')
    await git.commit('initial')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('clones a repo into a destination', async () => {
    const dest = path.join(tmpDir, 'clone')
    await cloneRepo(sourceRepo, dest)

    const cloned = await fs.readFile(path.join(dest, 'hello.txt'), 'utf8')
    expect(cloned).toBe('hello world\n')
  })

  it('gets the default branch name', async () => {
    const branch = await getDefaultBranch(sourceRepo)
    expect(['main', 'master']).toContain(branch)
  })

  it('creates a worktree with a new branch', async () => {
    const wtPath = path.join(tmpDir, 'worktree')
    await addWorktree(sourceRepo, wtPath, 'yaac/test-session')

    // Verify worktree exists and has files
    const content = await fs.readFile(path.join(wtPath, 'hello.txt'), 'utf8')
    expect(content).toBe('hello world\n')

    // Verify branch was created
    const git = simpleGit(wtPath)
    const branch = await git.revparse(['--abbrev-ref', 'HEAD'])
    expect(branch.trim()).toBe('yaac/test-session')
  })

  it('fetchAndPullDefault updates clone from remote', async () => {
    // Clone the source repo
    const cloneDir = path.join(tmpDir, 'clone')
    await cloneRepo(sourceRepo, cloneDir)

    // Add a new commit to the source
    const srcGit = simpleGit(sourceRepo)
    await fs.writeFile(path.join(sourceRepo, 'new-file.txt'), 'new content\n')
    await srcGit.add('.')
    await srcGit.commit('second commit')

    // fetchAndPullDefault should bring the new commit into the clone
    await fetchAndPullDefault(cloneDir)

    const content = await fs.readFile(path.join(cloneDir, 'new-file.txt'), 'utf8')
    expect(content).toBe('new content\n')
  })

  it('fetchAndPullDefault fails gracefully on non-ff changes', async () => {
    const cloneDir = path.join(tmpDir, 'clone')
    await cloneRepo(sourceRepo, cloneDir)

    // Make divergent commits in both source and clone
    const srcGit = simpleGit(sourceRepo)
    await fs.writeFile(path.join(sourceRepo, 'src-file.txt'), 'from source\n')
    await srcGit.add('.')
    await srcGit.commit('source commit')

    const cloneGit = simpleGit(cloneDir)
    await fs.writeFile(path.join(cloneDir, 'clone-file.txt'), 'from clone\n')
    await cloneGit.add('.')
    await cloneGit.commit('clone commit')

    // ff-only merge should fail
    await expect(fetchAndPullDefault(cloneDir)).rejects.toThrow()
  })

  it('removes a worktree', async () => {
    const wtPath = path.join(tmpDir, 'worktree')
    await addWorktree(sourceRepo, wtPath, 'yaac/to-remove')
    await removeWorktree(sourceRepo, wtPath)

    // Verify directory is gone
    await expect(fs.access(wtPath)).rejects.toThrow()
  })
})
