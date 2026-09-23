import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { clearGitScratch, getDefaultBranch } from '#domain/git'
import { serverLocalPath } from '@yaac/shared/paths'
import { git } from '@yaac/test-utils/git'

describe('clearGitScratch', () => {
  let repo: string

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-git-scratch-'))
    await git(repo, ['init', '-b', 'main'])
    await git(repo, ['-c', 'user.email=t@t.co', '-c', 'user.name=T', 'commit', '--allow-empty', '-m', 'x'])
  })

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true })
  })

  it('removes what a killed server left behind, and git calls after it still work', async () => {
    const scratch = serverLocalPath('run', 'git-shadow')
    await fs.mkdir(path.join(scratch, 'g-killed', 'objects'), { recursive: true })

    await clearGitScratch()
    await expect(fs.access(scratch)).rejects.toThrow()
    // The next call recreates what it needs, and cleans up after itself.
    expect(await getDefaultBranch(repo)).toBe('main')
    expect(await fs.readdir(scratch)).toEqual([])
  })
})
