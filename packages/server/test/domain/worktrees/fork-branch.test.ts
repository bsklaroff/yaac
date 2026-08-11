import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

import { closeDb } from '#records/client'
import { recordWorktreeCreated } from '#records/worktree-store'
import { worktreeForkBranch } from '#domain/worktrees/fork-branch'
import { repoDir } from '@yaac/shared/project-paths'

// The row is one source; the checkout is the other. Stubbing the host-side
// git read is what lets these tests assert the ORDER of the two, which is
// the whole point of the module — and it is the process boundary, so the
// fallback itself runs for real.
vi.mock('#platform/git', () => ({ worktreeUpstreamBranch: vi.fn() }))
import { worktreeUpstreamBranch } from '#platform/git'
const fallback = vi.mocked(worktreeUpstreamBranch)

describe('worktreeForkBranch', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    fallback.mockReset()
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  // THE bug this ordering exists for. `branch.agent/<id>.merge` lives in the
  // shared repo config the session's own git writes to, so a `git push -u` for
  // a PR repoints it at the branch just pushed — whose fork point is HEAD, so
  // the pane reports a session with a whole PR in it as having no changes. The
  // row is ours and says `main`.
  it('prefers the session row’s recorded base over the checkout fallback', async () => {
    await recordWorktreeCreated({
      projectSlug: 'demo', worktreeId: 'sid-pushed', baseBranch: 'main',
    })
    fallback.mockResolvedValue('feature/pushed-pr')
    expect(await worktreeForkBranch('demo', 'sid-pushed')).toBe('main')
    expect(fallback).not.toHaveBeenCalled()
  })

  // A session with no row (created by an older yaac) still has to resolve one.
  it('falls back to the checkout when no row records a base', async () => {
    fallback.mockResolvedValue('main')
    expect(await worktreeForkBranch('demo', 'sid-a')).toBe('main')
    expect(fallback).toHaveBeenCalledWith(repoDir('demo'), 'agent/sid-a')
  })

  // The changes endpoint is polled every few seconds and the fallback spawns
  // host git, so repeat reads inside the window must not hit git again.
  it('caches per session so polling does not respawn host git', async () => {
    fallback.mockResolvedValue('main')
    await worktreeForkBranch('demo', 'sid-b')
    await worktreeForkBranch('demo', 'sid-b')
    await worktreeForkBranch('demo', 'sid-b')
    expect(fallback).toHaveBeenCalledTimes(1)
    // A different session is a different entry, not a cache hit.
    await worktreeForkBranch('demo', 'sid-other')
    expect(fallback).toHaveBeenCalledTimes(2)
  })

  // No recorded base anywhere is a normal state (the pod script then falls back
  // on its own), and it must be cached too — otherwise the miss respawns git on
  // every poll for exactly the sessions that are slowest to resolve.
  it('caches a missing base and survives a git failure', async () => {
    fallback.mockResolvedValue(null)
    expect(await worktreeForkBranch('demo', 'sid-c')).toBeNull()
    expect(await worktreeForkBranch('demo', 'sid-c')).toBeNull()
    expect(fallback).toHaveBeenCalledTimes(1)

    fallback.mockRejectedValue(new Error('not a git repo'))
    expect(await worktreeForkBranch('demo', 'sid-d')).toBeNull()
  })
})
