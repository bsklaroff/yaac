import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorktreeDriver, snapshotFixture, workspacePathsFixture } from '@yaac/test-utils/fake-driver'
import { git } from '@yaac/test-utils/git'
import { repoDir, worktreeDir } from '@yaac/shared/project-paths'
import { closeDb } from '#db/client'
import { recordProject } from '#db'
import { cloneRepo, createCheckout } from '#domain/git'
import { fetchProjectOrigin, refreshProjectOrigins } from '#domain/projects'
import { execFileAsync } from '#lib/shell'

/**
 * A project whose remote is a repo on this disk, one running worktree whose
 * checkout is a real clone of the main clone, and a driver whose `exec` runs
 * the in-workspace command as a host shell in that checkout — what it is for
 * a host workspace.
 */

let tmp: string
let source: string
const SLUG = 'proj'
const WT = 'wt-1'
const execs: string[] = []
const running = handleFixture({ workspaceId: WT, projectSlug: SLUG, jobName: WT })

const tip = async (repo: string, ref: string): Promise<string> => (await git(repo, ['rev-parse', ref])).trim()
const commit = (msg: string): Promise<string> =>
  git(source, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', msg])

function installDriver(): void {
  installFakeWorktreeDriver({
    list: () => Promise.resolve([running]),
    workspacePaths: () => workspacePathsFixture({ workspaceDir: worktreeDir(SLUG, WT) }),
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
  await recordProject({ slug: SLUG, remoteUrl: source, addedAt: '2026-01-01T00:00:00.000Z' })
  await cloneRepo(source, repoDir(SLUG), null)
  await createCheckout(repoDir(SLUG), worktreeDir(SLUG, WT), { branch: `agent/${WT}`, baseBranch: 'main', remoteUrl: source })
})

afterAll(async () => {
  await closeDb()
  await cleanupTempDir(tmp)
})

describe('refreshProjectOrigins', () => {
  it('fetches a project with a running worktree once per interval, and fans the fetch out', async () => {
    installDriver()
    await commit('timed')
    execs.length = 0

    await refreshProjectOrigins(snapshotFixture([running]))
    await vi.waitFor(async () => {
      expect(await tip(worktreeDir(SLUG, WT), 'origin/main')).toBe(await tip(source, 'main'))
    }, { timeout: 10_000, interval: 50 })

    // Fetched just now: the next pass leaves it be.
    await commit('too soon')
    await refreshProjectOrigins(snapshotFixture([running]))
    await new Promise((r) => setTimeout(r, 300))
    expect(await tip(repoDir(SLUG), 'origin/main')).not.toBe(await tip(source, 'main'))
  })
})

describe('fetchProjectOrigin', () => {
  it('brings every running workspace up to the main clone, coalescing a burst', async () => {
    installDriver()
    await commit('burst')
    execs.length = 0

    await Promise.all([fetchProjectOrigin(SLUG), fetchProjectOrigin(SLUG), fetchProjectOrigin(SLUG)])
    await vi.waitFor(async () => {
      expect(await tip(worktreeDir(SLUG, WT), 'origin/main')).toBe(await tip(source, 'main'))
    }, { timeout: 10_000, interval: 50 })
    await new Promise((r) => setTimeout(r, 300))
    // One worktree, at most two rounds however many fetches asked.
    expect(execs.length).toBeGreaterThanOrEqual(1)
    expect(execs.length).toBeLessThanOrEqual(2)
  })
})
