import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { handleFixture, installFakeWorktreeDriver } from '@yaac/test-utils/fake-driver'

// The fork-branch fallback reads the checkout host-side; that git call is the
// process boundary, and stubbing it is what lets the changes cases below
// choose a fork branch without a clone on disk.
vi.mock('#domain/git', () => ({ worktreeUpstreamBranch: vi.fn() }))

import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { claudeDir, projectDir } from '@yaac/shared/project-paths'
import { recordAgentSessions, setAgentSessionCapture } from '#db/agent-session-store'
import { recordWorktreeCreated } from '#db/worktree-store'
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
import type { WorktreeChanges } from '@yaac/shared/types'

// Every helper here resolves the workspace through the runtime first.
const mockFind = vi.fn()
const mockBlockedHosts = vi.fn<(workspaceId: string) => Promise<string[]>>()

describe('session detail helpers', () => {
  let tmpDir: string

  beforeEach(async () => {
    mockFind.mockReset().mockResolvedValue(undefined)
    mockBlockedHosts.mockReset().mockResolvedValue([])
    installFakeWorktreeDriver({
      find: mockFind,
      blockedHosts: mockBlockedHosts,
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

  it('getWorktreeDetail reports what the runtime says about the workspace', async () => {
    mockFind.mockResolvedValue(handleFixture({ workspaceId: 'w1', projectSlug: 'demo' }))
    mockBlockedHosts.mockResolvedValue(['evil.example', 'blocked.example'])

    const detail = await getWorktreeDetail('w1')

    expect(mockBlockedHosts).toHaveBeenCalledWith('w1')
    expect(detail).toMatchObject({
      worktreeId: 'w1',
      projectSlug: 'demo',
      blockedHostsCount: 2,
    })
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

/**
 * The founding ask is RECORDED state — a captured row, or a transcript on the
 * host — so every case here answers with no workspace to resolve. That is the
 * state it is asked for in: the stopped list, and a server whose substrate is
 * not up.
 */
describe('getWorktreePrompt', () => {
  const SLUG = 'demo'
  const WORKTREE = 'wt-prompt'
  const SESSION = '33333333-3333-3333-3333-333333333333'
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    await recordWorktreeCreated({ projectSlug: SLUG, worktreeId: WORKTREE })
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  async function seedConversation(capture: {
    firstPrompt?: string
    transcriptPath?: string
  }): Promise<void> {
    await recordAgentSessions(SLUG, WORKTREE, [
      { tool: 'claude', agentSessionId: SESSION, mode: 'tui' },
    ])
    await setAgentSessionCapture(SLUG, 'claude', SESSION, capture)
  }

  // The 503 case: a server whose cluster is not up still knows what every
  // worktree was asked to do, because the answer was never in the cluster.
  it('answers from the captured row when the substrate cannot be asked', async () => {
    installFakeWorktreeDriver({
      find: () => Promise.reject(new ServerError('RUNTIME_UNAVAILABLE', 'connection refused')),
    })
    await seedConversation({ firstPrompt: 'fix the router' })

    await expect(getWorktreePrompt(WORKTREE)).resolves.toBe('fix the router')
  })

  // Nothing captured a prompt before the pod went away, so the recorded
  // transcript is read on the host — the path the row holds, since a stopped
  // worktree has no container to derive one from.
  it('falls back to the recorded transcript of a worktree with no pod', async () => {
    installFakeWorktreeDriver({ find: () => Promise.resolve(undefined) })
    const file = path.join(claudeDir(SLUG), 'projects', '-workspace', `${SESSION}.jsonl`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({
      type: 'user', uuid: 'u1', parentUuid: null, sessionId: SESSION, cwd: '/workspace',
      timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'what changed?' },
    }) + '\n')
    await seedConversation({
      transcriptPath: path.relative(projectDir(SLUG), file),
    })

    await expect(getWorktreePrompt(WORKTREE)).resolves.toBe('what changed?')
  })

  it('throws NOT_FOUND when neither the substrate nor the record knows the id', async () => {
    installFakeWorktreeDriver({ find: () => Promise.resolve(undefined) })
    await expect(getWorktreePrompt('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
