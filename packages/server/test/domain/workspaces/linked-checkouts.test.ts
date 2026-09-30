import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import { git } from '@yaac/test-utils/git'
import { repoDir, workspaceDir } from '@yaac/shared/project-paths'
import { closeDb } from '#db/client'
import { recordProject } from '#db'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { cloneRepo } from '#domain/git'
import { convertLinkedCheckouts } from '#domain/workspaces'

/**
 * A project as an older install left it: two workspaces with linked
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
    await git(repoDir(SLUG), ['worktree', 'add', '-q', '-b', `agent/${id}`, workspaceDir(SLUG, id), 'origin/main'])
    await recordWorkspaceCreated({ projectSlug: SLUG, workspaceId: id, baseBranch: 'main' })
  }
})

afterAll(async () => {
  await closeDb()
  await cleanupTempDir(tmp)
})

describe('convertLinkedCheckouts', () => {
  it('converts stopped checkouts, and takes the main clone back once none is left', async () => {
    const isClone = async (id: string): Promise<boolean> =>
      (await fs.stat(path.join(workspaceDir(SLUG, id), '.git'))).isDirectory()
    const admins = path.join(repoDir(SLUG), '.git', 'worktrees')

    installFakeWorkspaceDriver({
      list: () => Promise.resolve([handleFixture({ workspaceId: RUNNING, projectSlug: SLUG })]),
    })
    await convertLinkedCheckouts()
    expect(await isClone(STOPPED)).toBe(true)
    expect(await isClone(RUNNING)).toBe(false)
    // The running workspace still has an admin dir, so the main clone is
    // left as is.
    expect(await fs.readdir(admins)).toEqual([RUNNING])

    installFakeWorkspaceDriver({ list: () => Promise.resolve([]) })
    await convertLinkedCheckouts()
    expect(await isClone(RUNNING)).toBe(true)
    await expect(fs.access(admins)).rejects.toThrow()
    await expect(fs.access(path.join(repoDir(SLUG), '.git', 'hooks'))).rejects.toThrow()
    for (const id of [STOPPED, RUNNING]) {
      expect((await git(workspaceDir(SLUG, id), ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe(`agent/${id}`)
    }
  })
})
