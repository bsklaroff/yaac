import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDataDir, cleanupTempDir, createTestRepo } from '@yaac/test-utils/setup'
import { git } from '@yaac/test-utils/git'
import { DEMO_PROJECT_ID, seedProject } from '@yaac/test-utils/project-fixture'
import { reconcileReadyTrees } from '#domain/workspaces'
import { recordWorkspaceCreated, recordWorkspaceStopped } from '#db/workspace-store'
import { insertRepo } from '#db/repo-store'
import { BUILT_IN_USER_ID } from '#db'
import { closeDb } from '#db/client'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'
import { repoDir } from '@yaac/shared/project-paths'

/** A second repo whose default branch is `dev`, its main clone a step ahead
 *  of the demo repo's. */
const DEV = 'e1e1e1e1-0000-4000-8000-000000000001'
/** A repo whose main clone is gone. */
const GONE = 'e1e1e1e1-0000-4000-8000-000000000002'
/** A repo only a workspace stopped two days ago holds. */
const STALE = 'e1e1e1e1-0000-4000-8000-000000000003'

let tmpDir: string
let kept: Array<Array<{ repoId: string; commit: string }>>

/** A main clone with `origin/<branch>` at its one commit, as its default. */
async function mainClone(repoId: string, branch: string): Promise<void> {
  const dir = repoDir(repoId)
  await createTestRepo(dir)
  await git(dir, ['commit', '--allow-empty', '-qm', repoId])
  await git(dir, ['update-ref', `refs/remotes/origin/${branch}`, 'HEAD'])
  await git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`])
  await insertRepo({ id: repoId, owner: BUILT_IN_USER_ID, remoteUrl: `https://github.com/o/${repoId}.git` })
}

const tip = async (repoId: string, branch: string): Promise<string> =>
  (await git(repoDir(repoId), ['rev-parse', `origin/${branch}`])).trim()

/** What the last pass asked the runtime to keep, in repo order. */
const lastKept = (): Array<{ repoId: string; commit: string }> =>
  [...(kept.at(-1) ?? [])].sort((a, b) => a.repoId.localeCompare(b.repoId))

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  kept = []
  installFakeWorkspaceDriver({ keepReadyTrees: (trees) => { kept.push(trees); return Promise.resolve() } })
  await seedProject()
  await mainClone(DEV, 'dev')
  await mainClone(STALE, 'main')
  await insertRepo({ id: GONE, owner: BUILT_IN_USER_ID, remoteUrl: 'https://github.com/o/gone.git' })
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('reconcileReadyTrees', () => {
  it('keeps one tree per repo of the workspaces running or stopped within a day, at its default branch\'s tip as each pass reads it', async () => {
    const at = (repoId: string, path: string): { repoId: string; path: string } => ({ repoId, path })
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'flat', repos: [at(DEMO_PROJECT_ID, '')] })
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'nested', repos: [at(DEMO_PROJECT_ID, 'a'), at(DEV, 'b'), at(GONE, 'c')] })
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'old', repos: [at(STALE, '')] })
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() - 2 * 24 * 60 * 60_000 })
    await recordWorkspaceStopped(DEMO_PROJECT_ID, 'old')
    vi.useRealTimers()
    await recordWorkspaceStopped(DEMO_PROJECT_ID, 'nested')

    await reconcileReadyTrees()
    // The demo repo once, though two hold it, and none for the clone that
    // cannot be read.
    expect(lastKept()).toEqual([
      { repoId: DEMO_PROJECT_ID, commit: await tip(DEMO_PROJECT_ID, 'main') },
      { repoId: DEV, commit: await tip(DEV, 'dev') },
    ])

    // A fetch moves the default branch; the next pass keeps the new tip.
    const before = await tip(DEMO_PROJECT_ID, 'main')
    await git(repoDir(DEMO_PROJECT_ID), ['commit', '--allow-empty', '-qm', 'moved'])
    await git(repoDir(DEMO_PROJECT_ID), ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    await reconcileReadyTrees()
    expect(lastKept()[0]).toEqual({ repoId: DEMO_PROJECT_ID, commit: await tip(DEMO_PROJECT_ID, 'main') })
    expect(lastKept()[0].commit).not.toBe(before)

    // With none left, the runtime is told to keep none.
    await recordWorkspaceStopped(DEMO_PROJECT_ID, 'flat')
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2 * 24 * 60 * 60_000 })
    await reconcileReadyTrees()
    expect(kept.at(-1)).toEqual([])
  })
})
