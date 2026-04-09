import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import simpleGit from 'simple-git'
import { cloneRepo, getDefaultBranch, addWorktree, removeWorktree, fetchOrigin, getGitUserConfig } from '@/lib/git'

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

  it('gets default branch from origin/HEAD when available', async () => {
    // Clone the source so we have an "origin" remote
    const cloneDir = path.join(tmpDir, 'clone-default')
    await cloneRepo(sourceRepo, cloneDir)

    // Checkout a different branch so HEAD != default
    const cloneGit = simpleGit(cloneDir)
    await cloneGit.checkoutLocalBranch('feature-branch')

    // getDefaultBranch should still return the remote default, not 'feature-branch'
    const branch = await getDefaultBranch(cloneDir)
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

  it('creates a worktree with upstream tracking', async () => {
    // Clone so we have a remote called "origin"
    const cloneDir = path.join(tmpDir, 'clone')
    await cloneRepo(sourceRepo, cloneDir)

    const defaultBranch = await getDefaultBranch(cloneDir)
    const wtPath = path.join(tmpDir, 'worktree')
    await addWorktree(cloneDir, wtPath, 'yaac/test-tracked', `origin/${defaultBranch}`)

    // Verify the branch tracks origin/<default>
    const git = simpleGit(wtPath)
    const tracking = await git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    expect(tracking.trim()).toBe(`origin/${defaultBranch}`)
  })

  it('fetchOrigin updates remote refs', async () => {
    // Clone the source repo
    const cloneDir = path.join(tmpDir, 'clone')
    await cloneRepo(sourceRepo, cloneDir)

    // Add a new commit to the source
    const srcGit = simpleGit(sourceRepo)
    await fs.writeFile(path.join(sourceRepo, 'new-file.txt'), 'new content\n')
    await srcGit.add('.')
    await srcGit.commit('second commit')

    // fetchOrigin should update remote refs
    await fetchOrigin(cloneDir)

    // Verify origin/main has the new commit (even though local branch hasn't moved)
    const defaultBranch = await getDefaultBranch(cloneDir)
    const cloneGit = simpleGit(cloneDir)
    const log = await cloneGit.log([`origin/${defaultBranch}`])
    expect(log.latest?.message).toBe('second commit')
  })

  it('creates worktree from startPoint with latest remote content', async () => {
    // Clone the source repo
    const cloneDir = path.join(tmpDir, 'clone')
    await cloneRepo(sourceRepo, cloneDir)

    // Add a new commit to the source
    const srcGit = simpleGit(sourceRepo)
    await fs.writeFile(path.join(sourceRepo, 'new-file.txt'), 'new content\n')
    await srcGit.add('.')
    await srcGit.commit('second commit')

    // Fetch so remote refs are updated
    await fetchOrigin(cloneDir)

    // Create worktree from origin/<default> — should include the new commit
    const defaultBranch = await getDefaultBranch(cloneDir)
    const wtPath = path.join(tmpDir, 'wt-startpoint')
    await addWorktree(cloneDir, wtPath, 'yaac/from-origin', `origin/${defaultBranch}`)

    const content = await fs.readFile(path.join(wtPath, 'new-file.txt'), 'utf8')
    expect(content).toBe('new content\n')
  })

  it('getGitUserConfig returns name and email or null', async () => {
    const result = await getGitUserConfig()
    if (result) {
      expect(result).toHaveProperty('name')
      expect(result).toHaveProperty('email')
      expect(typeof result.name).toBe('string')
      expect(typeof result.email).toBe('string')
    } else {
      expect(result).toBeNull()
    }
  })

  it('removes a worktree', async () => {
    const wtPath = path.join(tmpDir, 'worktree')
    await addWorktree(sourceRepo, wtPath, 'yaac/to-remove')
    await removeWorktree(sourceRepo, wtPath)

    // Verify directory is gone
    await expect(fs.access(wtPath)).rejects.toThrow()
  })
})
