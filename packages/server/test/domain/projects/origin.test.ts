import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver, snapshotFixture, workspacePathsFixture } from '@yaac/test-utils/fake-driver'
import { git } from '@yaac/test-utils/git'
import { repoDir, workspaceDir } from '@yaac/shared/project-paths'
import { closeDb } from '#db/client'
import { BUILT_IN_USER_ID, recordProject } from '#db'
import { cloneRepo, createCheckout } from '#domain/git'
import { fetchProjectOrigin, refreshProjectOrigins } from '#domain/projects'
import { execFileAsync } from '#lib/shell'

/**
 * Fixture: a project whose remote is a local repo, one running workspace
 * whose checkout is a real clone of the main clone, and a driver whose `exec`
 * runs the command in a host shell in that checkout, as it does for a
 * containerless workspace.
 */

let tmp: string
let source: string
const PROJECT_ID = '3f1e0c2a-9b8d-4e7f-a6c5-0d1e2f3a4b5c'
const WT = 'wt-1'
const execs: string[] = []
const running = handleFixture({ workspaceId: WT, projectId: PROJECT_ID, jobName: WT })

const tip = async (repo: string, ref: string): Promise<string> => (await git(repo, ['rev-parse', ref])).trim()
const commit = (msg: string): Promise<string> =>
  git(source, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', msg])

function installDriver(): void {
  installFakeWorkspaceDriver({
    list: () => Promise.resolve([running]),
    workspacePaths: () => workspacePathsFixture({ workspaceDir: workspaceDir(PROJECT_ID, WT) }),
    exec: async (_job, cmd) => {
      execs.push(cmd)
      return execFileAsync('sh', ['-c', cmd])
    },
  })
}

beforeAll(async () => {
  tmp = await createTempDataDir()
  source = path.join(tmp, 'source')
  await fs.mkdir(source)
  await git(source, ['init', '-q', '-b', 'main'])
  await commit('initial')
  await recordProject({ id: PROJECT_ID, name: 'proj', remoteUrl: source, addedAt: '2026-01-01T00:00:00.000Z' }, BUILT_IN_USER_ID)
  await cloneRepo(source, repoDir(PROJECT_ID), null)
  await createCheckout(repoDir(PROJECT_ID), workspaceDir(PROJECT_ID, WT), { branch: `agent/${WT}`, baseBranch: 'main', remoteUrl: source })
})

afterAll(async () => {
  await closeDb()
  await cleanupTempDir(tmp)
})

describe('refreshProjectOrigins', () => {
  it('fetches a project with a running workspace once per interval, and fans the fetch out', async () => {
    installDriver()
    await commit('timed')
    execs.length = 0

    await refreshProjectOrigins(snapshotFixture([running]))
    await vi.waitFor(async () => {
      expect(await tip(workspaceDir(PROJECT_ID, WT), 'origin/main')).toBe(await tip(source, 'main'))
    }, { timeout: 10_000, interval: 50 })

    // Fetched moments ago, so the next pass skips it.
    await commit('too soon')
    await refreshProjectOrigins(snapshotFixture([running]))
    await new Promise((r) => setTimeout(r, 300))
    expect(await tip(repoDir(PROJECT_ID), 'origin/main')).not.toBe(await tip(source, 'main'))
  })
})

describe('fetchProjectOrigin', () => {
  it('brings every running workspace up to the main clone, coalescing a burst', async () => {
    installDriver()
    await commit('burst')
    execs.length = 0

    await Promise.all([fetchProjectOrigin(PROJECT_ID), fetchProjectOrigin(PROJECT_ID), fetchProjectOrigin(PROJECT_ID)])
    await vi.waitFor(async () => {
      expect(await tip(workspaceDir(PROJECT_ID, WT), 'origin/main')).toBe(await tip(source, 'main'))
    }, { timeout: 10_000, interval: 50 })
    await new Promise((r) => setTimeout(r, 300))
    // The burst coalesces into at most two rounds.
    expect(execs.length).toBeGreaterThanOrEqual(1)
    expect(execs.length).toBeLessThanOrEqual(2)
  })
})
