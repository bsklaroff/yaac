import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

import { closeDb } from '#platform/db/client'
import { recordWorktreeCreated } from '#features/records/worktree-store'
import { _resetHerdForTests, _setHerdForTests } from '#herd'
import { sessionForkBranch } from '#features/sessions/fork-branch'

// The row is the server's; the checkout is the herd's. Stubbing the fallback
// is what lets these tests assert the ORDER of the two, which is the whole
// point of the module.
const fallback = vi.fn<(slug: string, id: string) => Promise<string | null>>()

describe('sessionForkBranch', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    fallback.mockReset()
    _setHerdForTests({ workspaces: { worktreeForkFallback: fallback } })
  })

  afterEach(async () => {
    _resetHerdForTests()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  // THE bug this ordering exists for. `branch.agent/<id>.merge` lives in the
  // shared repo config the session's own git writes to, so a `git push -u` for
  // a PR repoints it at the branch just pushed — whose fork point is HEAD, so
  // the pane reports a session with a whole PR in it as having no changes. The
  // row is ours and says `main`.
  it('prefers the session row’s recorded base over the herd’s fallback', async () => {
    await recordWorktreeCreated({
      projectSlug: 'demo', worktreeId: 'sid-pushed', baseBranch: 'main',
    })
    fallback.mockResolvedValue('feature/pushed-pr')
    expect(await sessionForkBranch('demo', 'sid-pushed')).toBe('main')
    expect(fallback).not.toHaveBeenCalled()
  })

  // A session with no row (created by an older yaac) still has to resolve one.
  it('falls back to the herd when no row records a base', async () => {
    fallback.mockResolvedValue('main')
    expect(await sessionForkBranch('demo', 'sid-a')).toBe('main')
    expect(fallback).toHaveBeenCalledWith('demo', 'sid-a')
  })

  // The changes endpoint is polled every few seconds and the fallback spawns
  // host git, so repeat reads inside the window must not hit git again.
  it('caches per session so polling does not respawn host git', async () => {
    fallback.mockResolvedValue('main')
    await sessionForkBranch('demo', 'sid-b')
    await sessionForkBranch('demo', 'sid-b')
    await sessionForkBranch('demo', 'sid-b')
    expect(fallback).toHaveBeenCalledTimes(1)
    // A different session is a different entry, not a cache hit.
    await sessionForkBranch('demo', 'sid-other')
    expect(fallback).toHaveBeenCalledTimes(2)
  })

  // No recorded base anywhere is a normal state (the pod script then falls back
  // on its own), and it must be cached too — otherwise the miss respawns git on
  // every poll for exactly the sessions that are slowest to resolve.
  it('caches a missing base and survives a git failure', async () => {
    fallback.mockResolvedValue(null)
    expect(await sessionForkBranch('demo', 'sid-c')).toBeNull()
    expect(await sessionForkBranch('demo', 'sid-c')).toBeNull()
    expect(fallback).toHaveBeenCalledTimes(1)

    fallback.mockRejectedValue(new Error('not a git repo'))
    expect(await sessionForkBranch('demo', 'sid-d')).toBeNull()
  })
})
