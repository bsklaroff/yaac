import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorktreeDriver } from '@yaac/test-utils/fake-driver'
import { git } from '@yaac/test-utils/git'
import { repoDir, worktreeDir } from '@yaac/shared/project-paths'
import { closeDb } from '#db/client'
import { recordProject } from '#db'
import { recordWorktreeCreated } from '#db/worktree-store'
import { cloneRepo } from '#domain/git'
import { convertLinkedCheckouts } from '#domain/worktrees'

/**
 * A project as an older install left it: two worktrees with linked
 * checkouts made by plain `git worktree add`, one of them still running in
 * a legacy workspace the sweep must not touch.
 */

let tmp: string
const SLUG = 'proj'
const STOPPED = 'wt-stopped'
const RUNNING = 'wt-running'

beforeAll(async () => {
  tmp = await createTempDataDir()
  const source = path.join(tmp, 'source')
  await fs.mkdir(source)
  await git(source, ['init', '-q', '-b', 'main'])
  await git(source, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'initial'])
  await recordProject({ slug: SLUG, remoteUrl: source, addedAt: '2026-01-01T00:00:00.000Z' })
  await cloneRepo(source, repoDir(SLUG), null)
  for (const id of [STOPPED, RUNNING]) {
    await git(repoDir(SLUG), ['worktree', 'add', '-q', '-b', `agent/${id}`, worktreeDir(SLUG, id), 'origin/main'])
    await recordWorktreeCreated({ projectSlug: SLUG, worktreeId: id, baseBranch: 'main' })
  }
})

afterAll(async () => {
  await closeDb()
  await cleanupTempDir(tmp)
})

describe('convertLinkedCheckouts', () => {
  it('converts stopped checkouts, and takes the main clone back once none is left', async () => {
    const isClone = async (id: string): Promise<boolean> =>
      (await fs.stat(path.join(worktreeDir(SLUG, id), '.git'))).isDirectory()
    const worktrees = path.join(repoDir(SLUG), '.git', 'worktrees')

    installFakeWorktreeDriver({
      list: () => Promise.resolve([handleFixture({ workspaceId: RUNNING, projectSlug: SLUG })]),
    })
    await convertLinkedCheckouts()
    expect(await isClone(STOPPED)).toBe(true)
    expect(await isClone(RUNNING)).toBe(false)
    // The running one still owns an admin dir, so the main clone stays as is.
    expect(await fs.readdir(worktrees)).toEqual([RUNNING])

    installFakeWorktreeDriver({ list: () => Promise.resolve([]) })
    await convertLinkedCheckouts()
    expect(await isClone(RUNNING)).toBe(true)
    await expect(fs.access(worktrees)).rejects.toThrow()
    await expect(fs.access(path.join(repoDir(SLUG), '.git', 'hooks'))).rejects.toThrow()
    for (const id of [STOPPED, RUNNING]) {
      expect((await git(worktreeDir(SLUG, id), ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe(`agent/${id}`)
    }
  })
})
