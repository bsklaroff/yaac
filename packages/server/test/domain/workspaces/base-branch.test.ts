import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { handleFixture, installFakeWorkspaceDriver, workspacePathsFixture } from '#test/support/fake-driver'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { git } from '@yaac/test-utils/git'
import { closeDb } from '#db/client'
import { BUILT_IN_USER_ID } from '#db/user-store'
import { insertRepo, listWorkspaceRepos } from '#db'
import { recordTestProject } from '@yaac/test-utils/project-fixture'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { cloneRepo } from '#domain/git'
import { setWorkspaceBase } from '#domain/workspaces'
import type { RuntimeHandle } from '#drivers/contract'
import { repoDir } from '@yaac/shared/project-paths'

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const

let tmpDir: string
let origin: string
/** The workspace's own clone, which a running workspace's exec runs in. */
let checkout: string
let running: RuntimeHandle[]

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  running = []
  // The runtime runs commands on the host, as the containerless driver
  // does, so the origin refresh lands in a real checkout.
  installFakeWorkspaceDriver({
    find: (workspaceId) => Promise.resolve(running.find((h) => h.workspaceId === workspaceId)),
    workspacePaths: () => workspacePathsFixture({ workspaceDir: checkout }),
    exec: async (_job, command) => {
      const { stdout, stderr } = await promisify(execFile)('sh', ['-c', command])
      return { stdout, stderr }
    },
  })
  origin = path.join(tmpDir, 'origin')
  await fs.mkdir(origin)
  await git(origin, ['init', '-q', '-b', 'main'])
  await git(origin, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'])
  // On origin since the clone, so basing on it fetches nothing.
  await git(origin, ['branch', 'other'])
  await recordTestProject(PROJ, { remoteUrl: origin })
  await cloneRepo(origin, repoDir(PROJ), null)
  checkout = path.join(tmpDir, 'checkout')
  await git(tmpDir, ['clone', '-q', repoDir(PROJ), checkout])
  await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'ws-1', repos: [{ repoId: PROJ, path: '', baseBranch: 'main' }] })
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

const baseOf = async (workspaceId = 'ws-1', at = ''): Promise<string | undefined> =>
  (await listWorkspaceRepos(workspaceId)).find((r) => r.path === at)?.baseBranch

describe('setWorkspaceBase', () => {
  it('bases a running workspace on a just-pushed branch, which its checkout then has', async () => {
    running = [handleFixture({ workspaceId: 'ws-1', projectId: PROJ })]
    await git(origin, ['branch', 'pr/stacked'])

    expect(await setWorkspaceBase(local, 'ws-1', ' pr/stacked ')).toEqual({ workspaceId: 'ws-1', repo: '', baseBranch: 'pr/stacked' })
    expect(await baseOf()).toBe('pr/stacked')
    expect(await git(checkout, ['rev-parse', '--verify', '-q', 'refs/remotes/origin/pr/stacked'])).toMatch(/^[0-9a-f]{40}/)
  })

  it('bases a stopped workspace too, from its row alone', async () => {
    await setWorkspaceBase(local, 'ws-1', 'other')
    expect(await baseOf()).toBe('other')
  })

  it('bases the checkout named, by folder or repo, in a workspace with several, and no other', async () => {
    const WEB = '11111111-2222-4333-8444-555555555555'
    await cloneRepo(origin, repoDir(WEB), null)
    await insertRepo({ id: WEB, owner: BUILT_IN_USER_ID, remoteUrl: origin })
    // `api` was created at a commit, so it has no base yet; `gone` is a
    // checkout whose repo no longer has a row, which nothing can name.
    await recordWorkspaceCreated({
      projectId: PROJ,
      workspaceId: 'ws-2',
      repos: [
        { repoId: WEB, path: 'web', baseBranch: 'main' },
        { repoId: PROJ, path: 'api', startCommit: 'c'.repeat(40) },
        { repoId: '99999999-2222-4333-8444-555555555555', path: 'gone', baseBranch: 'main' },
      ],
    })
    await expect(setWorkspaceBase(local, 'ws-2', 'other'))
      .rejects.toMatchObject({ code: 'VALIDATION', message: /several repos; name one of: api, web$/ })
    expect(await setWorkspaceBase(local, 'ws-2', 'other', 'web')).toEqual({ workspaceId: 'ws-2', repo: 'web', baseBranch: 'other' })
    expect([await baseOf('ws-2', 'api'), await baseOf('ws-2', 'web')]).toEqual([undefined, 'other'])
    expect(await setWorkspaceBase(local, 'ws-2', 'main', PROJ)).toEqual({ workspaceId: 'ws-2', repo: 'api', baseBranch: 'main' })
    for (const at of ['docs', 'gone']) {
      await expect(setWorkspaceBase(local, 'ws-2', 'other', at)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    }

    // A workspace with no repos has nothing to base.
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'ws-3', repos: [] })
    await expect(setWorkspaceBase(local, 'ws-3', 'other')).rejects.toMatchObject({ code: 'VALIDATION', message: /has no repos/ })
  })

  it('refuses what is not a branch on origin, fetching at most once per interval', async () => {
    // Past any fetch an earlier test made, which the interval is keyed on.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 3_600_000)
    try {
      // Never a branch name, so refused before any fetch.
      for (const name of ['main~1', 'main:evil', '--upload-pack=x', 'a..b', 'x\ny', 'x/', '@', 'HEAD']) {
        await expect(setWorkspaceBase(local, 'ws-1', name)).rejects.toThrow(`"${name}" is not a branch name`)
      }
      await expect(setWorkspaceBase(local, 'ws-1', '  ')).rejects.toThrow('a base branch is required')
      const missing = 'branch "ghost" not found on origin (pushed just now? retry in 10s)'
      await expect(setWorkspaceBase(local, 'ws-1', 'ghost')).rejects.toThrow(missing)
      // Pushed now, but origin was fetched moments ago, so not again yet.
      await git(origin, ['branch', 'ghost'])
      await expect(setWorkspaceBase(local, 'ws-1', 'ghost')).rejects.toThrow(missing)
      vi.setSystemTime(Date.now() + 10_000)
      await setWorkspaceBase(local, 'ws-1', 'ghost')
      expect(await baseOf()).toBe('ghost')
    } finally {
      vi.useRealTimers()
    }
  })
})
