import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { handleFixture, installFakeWorktreeDriver } from '@yaac/test-utils/fake-driver'

// The fork-branch fallback reads the checkout host-side; that git call is the
// process boundary, and stubbing it is what lets the changes cases below
// choose a fork branch without a clone on disk.
vi.mock('#domain/git', () => ({ worktreeUpstreamBranch: vi.fn() }))

import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#db/client'
import { worktreeUpstreamBranch } from '#domain/git'
import {
  getWorktreeBlockedHosts,
  getWorktreeChanges,
  getWorktreeDetail,
  getWorktreePrompt,
} from '#domain/worktrees/detail'
import { ServerError } from '@yaac/shared/errors'
import { CHANGES_BASE_UNRESOLVED, WorkspaceExecError } from '#drivers/contract'
import type { VirtualClusterStatus } from '#drivers/contract'
import type { WorktreeChanges } from '@yaac/shared/types'

// Every helper here resolves the workspace through the runtime first.
const mockFind = vi.fn()
const mockBlockedHosts = vi.fn<(workspaceId: string) => Promise<string[]>>()
const mockVcluster = vi.fn<(workspaceId: string) => Promise<VirtualClusterStatus | null>>()

describe('session detail helpers', () => {
  let tmpDir: string

  beforeEach(async () => {
    mockFind.mockReset().mockResolvedValue(undefined)
    mockBlockedHosts.mockReset().mockResolvedValue([])
    mockVcluster.mockReset().mockResolvedValue(null)
    installFakeWorktreeDriver({
      find: mockFind,
      blockedHosts: mockBlockedHosts,
      virtualClusterStatus: mockVcluster,
    })
    tmpDir = await createTempDataDir()
    // The default above is a runtime running nothing: every helper here
    // resolves the workspace first, so that is what proves each one refuses
    // rather than half-answering.
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('getWorktreeDetail throws NOT_FOUND for unknown ids', async () => {
    await expect(getWorktreeDetail('nonexistent-session')).rejects.toBeInstanceOf(ServerError)
    await expect(getWorktreeDetail('nonexistent-session')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('getWorktreeBlockedHosts throws NOT_FOUND for unknown ids', async () => {
    await expect(getWorktreeBlockedHosts('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('getWorktreePrompt throws NOT_FOUND for unknown ids', async () => {
    await expect(getWorktreePrompt('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('getWorktreeDetail reports what the runtime says about the workspace', async () => {
    mockFind.mockResolvedValue(handleFixture({ workspaceId: 'w1', projectSlug: 'demo' }))
    mockBlockedHosts.mockResolvedValue(['evil.example', 'blocked.example'])
    mockVcluster.mockResolvedValue({ name: 'yvc-w1', ready: true, phase: 'ready' })

    const detail = await getWorktreeDetail('w1')

    expect(mockBlockedHosts).toHaveBeenCalledWith('w1')
    expect(detail).toMatchObject({
      worktreeId: 'w1',
      projectSlug: 'demo',
      blockedHostsCount: 2,
      virtualCluster: { name: 'yvc-w1', ready: true, phase: 'ready' },
    })
  })

  // A workspace with no nested cluster is the common case, and the key is
  // omitted rather than sent as null — the wire shape the webapp reads.
  it('getWorktreeDetail omits the nested cluster when there is none', async () => {
    mockFind.mockResolvedValue(handleFixture({ workspaceId: 'w1' }))
    expect(await getWorktreeDetail('w1')).not.toHaveProperty('virtualCluster')
  })

  // Detail has to render even when that one extra read hiccups: it is a
  // display surface, and a blank nested-cluster block beats an error page.
  it('getWorktreeDetail still renders when the nested-cluster read fails', async () => {
    mockFind.mockResolvedValue(handleFixture({ workspaceId: 'w1' }))
    mockVcluster.mockRejectedValue(new Error('apiserver down'))

    const detail = await getWorktreeDetail('w1')
    expect(detail.worktreeId).toBe('w1')
    expect(detail.virtualCluster).toBeUndefined()
  })

  it('getWorktreeBlockedHosts relays the runtime’s list', async () => {
    mockFind.mockResolvedValue(handleFixture({ workspaceId: 'w1' }))
    mockBlockedHosts.mockResolvedValue(['evil.example'])
    await expect(getWorktreeBlockedHosts('w1')).resolves.toEqual(['evil.example'])
  })
})

describe('getWorktreeChanges', () => {
  const EMPTY: WorktreeChanges = {
    base: 'main', baseResolved: true, files: [], diff: '', truncated: false,
  }
  const mockChanges = vi.fn<
    (jobName: string, base?: string, defaultBase?: string) => Promise<WorktreeChanges>
  >()
  let tmpDir: string
  let seq = 0

  beforeEach(async () => {
    mockChanges.mockReset().mockResolvedValue(EMPTY)
    vi.mocked(worktreeUpstreamBranch).mockReset().mockResolvedValue('main')
    tmpDir = await createTempDataDir()
    // A fresh id per case: the fork branch is cached per worktree for 30s,
    // and a shared id would let one case answer the next one's lookup.
    seq += 1
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  function installRunning(): string {
    const workspaceId = `chg-${seq}`
    installFakeWorktreeDriver({
      find: () => Promise.resolve(handleFixture({
        workspaceId, projectSlug: 'demo', jobName: `yaac-demo-${workspaceId}`, state: 'running',
      })),
      changes: mockChanges,
    })
    return workspaceId
  }

  // THE reason this verb exists rather than a bare `changes` call: once the
  // agent renames and pushes its branch, the current branch's own @{upstream}
  // is itself, so the runtime's default base collapses the diff to nothing.
  // The fork point keeps committed work visible until it merges.
  it('passes the fork branch as the default base', async () => {
    const workspaceId = installRunning()

    await getWorktreeChanges(workspaceId)

    expect(mockChanges).toHaveBeenCalledExactlyOnceWith(
      `yaac-demo-${workspaceId}`, undefined, 'main',
    )
  })

  it('lets an explicit base win, still offering the fork branch as the default', async () => {
    const workspaceId = installRunning()

    await getWorktreeChanges(workspaceId, 'origin/release')

    expect(mockChanges).toHaveBeenCalledExactlyOnceWith(
      `yaac-demo-${workspaceId}`, 'origin/release', 'main',
    )
  })

  // Nothing recorded a fork branch and the checkout has none either: the
  // runtime is asked with no default rather than with a guess.
  it('asks with no default when nothing records a fork branch', async () => {
    const workspaceId = installRunning()
    vi.mocked(worktreeUpstreamBranch).mockResolvedValue(null)

    await getWorktreeChanges(workspaceId)

    expect(mockChanges).toHaveBeenCalledExactlyOnceWith(
      `yaac-demo-${workspaceId}`, undefined, undefined,
    )
  })

  it('refuses a worktree that is not running', async () => {
    installFakeWorktreeDriver({ find: () => Promise.resolve(undefined), changes: mockChanges })

    await expect(getWorktreeChanges('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mockChanges).not.toHaveBeenCalled()
  })

  // A ref the CALLER named that resolves nowhere is a bad request, and this
  // is the only place that knows the ref came from them — left alone it
  // reaches the route as a bare exec failure and answers 500.
  it('answers VALIDATION for an explicit base that resolves nowhere', async () => {
    const workspaceId = installRunning()
    mockChanges.mockRejectedValue(
      new WorkspaceExecError('command exited 4', CHANGES_BASE_UNRESOLVED, '', ''),
    )

    const err = await getWorktreeChanges(workspaceId, 'no-such-branch').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ServerError)
    expect(err).toMatchObject({ code: 'VALIDATION', httpStatus: 400 })
    // The message has to name the ref: it is the caller's only clue.
    expect((err as ServerError).message).toContain('no-such-branch')
  })

  // The same code with no explicit base means the RECORDED fork branch is the
  // one that resolves nowhere — our inconsistency, not the caller's, so it
  // must keep surfacing as a fault rather than being blamed on them.
  it('keeps an unresolvable default base a server fault', async () => {
    const workspaceId = installRunning()
    const failure = new WorkspaceExecError('command exited 4', CHANGES_BASE_UNRESOLVED, '', '')
    mockChanges.mockRejectedValue(failure)

    await expect(getWorktreeChanges(workspaceId)).rejects.toBe(failure)
  })

  // Every other exec failure stays what it was: a nonzero exit on its own is
  // no evidence of a bad ref (exit 3 is "this worktree has no /workspace"),
  // and relabelling those as user error would hide real breakage.
  it('leaves other exec failures alone even with an explicit base', async () => {
    const workspaceId = installRunning()
    const failure = new WorkspaceExecError('command exited 3', 3, '', '')
    mockChanges.mockRejectedValue(failure)

    await expect(getWorktreeChanges(workspaceId, 'dev')).rejects.toBe(failure)
  })
})
