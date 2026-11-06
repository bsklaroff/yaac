import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { handleFixture, installFakeWorkspaceDriver, workspacePathsFixture } from '#test/support/fake-driver'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { git } from '@yaac/test-utils/git'
import { closeDb } from '#db/client'
import { recordProject } from '#db/project-store'
import { BUILT_IN_USER_ID } from '#db/user-store'
import { getWorkspaceRow } from '#db'
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
  await recordProject({ id: PROJ, name: 'demo', remoteUrl: origin, addedAt: '2026-01-01T00:00:00.000Z' }, BUILT_IN_USER_ID)
  await cloneRepo(origin, repoDir(PROJ), null)
  checkout = path.join(tmpDir, 'checkout')
  await git(tmpDir, ['clone', '-q', repoDir(PROJ), checkout])
  await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'ws-1', baseBranch: 'main' })
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

const baseOf = async (): Promise<string | undefined> => (await getWorkspaceRow(PROJ, 'ws-1'))?.baseBranch

describe('setWorkspaceBase', () => {
  it('bases a running workspace on a just-pushed branch, which its checkout then has', async () => {
    running = [handleFixture({ workspaceId: 'ws-1', projectId: PROJ })]
    await git(origin, ['branch', 'pr/stacked'])

    expect(await setWorkspaceBase(local, 'ws-1', ' pr/stacked ')).toEqual({ workspaceId: 'ws-1', baseBranch: 'pr/stacked' })
    expect(await baseOf()).toBe('pr/stacked')
    expect(await git(checkout, ['rev-parse', '--verify', '-q', 'refs/remotes/origin/pr/stacked'])).toMatch(/^[0-9a-f]{40}/)
  })

  it('bases a stopped workspace too, from its row alone', async () => {
    await setWorkspaceBase(local, 'ws-1', 'other')
    expect(await baseOf()).toBe('other')
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
