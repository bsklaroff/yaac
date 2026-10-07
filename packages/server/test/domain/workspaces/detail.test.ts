import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DEMO_PROJECT_ID } from '@yaac/test-utils/project-fixture'
import { handleFixture, installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'

import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { claudeDir, projectDir } from '@yaac/shared/project-paths'
import { recordAgentSessions, setAgentSessionCapture } from '#db/agent-session-store'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { closeDb } from '#db/client'
import {
  getWorkspaceBlockedHosts,
  getWorkspaceChanges,
  getWorkspaceDetail,
  getWorkspacePrompt,
} from '#domain/workspaces/detail'
import { ServerError } from '@yaac/shared/errors'
import { CHANGES_BASE_UNRESOLVED, WorkspaceExecError } from '#drivers/contract'
import type { WorkspaceChanges } from '@yaac/shared/types'

const mockFind = vi.fn()
const mockBlockedHosts = vi.fn<(workspaceId: string) => Promise<string[]>>()

describe('session detail helpers', () => {
  let tmpDir: string

  beforeEach(async () => {
    mockFind.mockReset().mockResolvedValue(undefined)
    mockBlockedHosts.mockReset().mockResolvedValue([])
    installFakeWorkspaceDriver({
      find: mockFind,
      blockedHosts: mockBlockedHosts,
    })
    tmpDir = await createTempDataDir()
    // By default nothing is running, so each helper must refuse outright.
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('getWorkspaceDetail throws NOT_FOUND for unknown ids', async () => {
    await expect(getWorkspaceDetail('nonexistent-session')).rejects.toBeInstanceOf(ServerError)
    await expect(getWorkspaceDetail('nonexistent-session')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('getWorkspaceBlockedHosts throws NOT_FOUND for unknown ids', async () => {
    await expect(getWorkspaceBlockedHosts('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('getWorkspaceDetail reports what the runtime says about the workspace', async () => {
    mockFind.mockResolvedValue(handleFixture({ workspaceId: 'w1', projectId: DEMO_PROJECT_ID }))
    mockBlockedHosts.mockResolvedValue(['evil.example', 'blocked.example'])

    const detail = await getWorkspaceDetail('w1')

    expect(mockBlockedHosts).toHaveBeenCalledWith('w1')
    expect(detail).toMatchObject({
      workspaceId: 'w1',
      projectId: DEMO_PROJECT_ID,
      blockedHostsCount: 2,
    })
  })

  it('getWorkspaceBlockedHosts relays the runtime’s list', async () => {
    mockFind.mockResolvedValue(handleFixture({ workspaceId: 'w1' }))
    mockBlockedHosts.mockResolvedValue(['evil.example'])
    await expect(getWorkspaceBlockedHosts('w1')).resolves.toEqual(['evil.example'])
  })
})

describe('getWorkspaceChanges', () => {
  const EMPTY: WorkspaceChanges = {
    base: 'main', baseResolved: true, files: [], diff: '', truncated: false,
  }
  const mockChanges = vi.fn<
    (jobName: string, base?: string, defaultBase?: string, diff?: boolean) => Promise<WorkspaceChanges>
  >()
  let tmpDir: string
  let seq = 0

  beforeEach(async () => {
    mockChanges.mockReset().mockResolvedValue(EMPTY)
    tmpDir = await createTempDataDir()
    seq += 1
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  /** A running workspace whose row records `base` as its fork branch. */
  async function installRunning(base: string | null = 'main'): Promise<string> {
    const workspaceId = `chg-${seq}`
    if (base !== null) await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: workspaceId, baseBranch: base })
    installFakeWorkspaceDriver({
      find: () => Promise.resolve(handleFixture({
        workspaceId, projectId: DEMO_PROJECT_ID, jobName: `yaac-demo-${workspaceId}`, state: 'running',
      })),
      changes: mockChanges,
    })
    return workspaceId
  }

  // Once the agent pushes its branch, @{upstream} is the branch itself and
  // the runtime's default base shows an empty diff. Diffing against the fork
  // branch keeps committed work visible until it merges.
  it('passes the fork branch as the default base', async () => {
    const workspaceId = await installRunning()

    await getWorkspaceChanges(workspaceId)

    expect(mockChanges).toHaveBeenCalledExactlyOnceWith(
      `yaac-demo-${workspaceId}`, undefined, 'main', true,
    )
  })

  it('lets an explicit base win, still offering the fork branch as the default', async () => {
    const workspaceId = await installRunning()

    await getWorkspaceChanges(workspaceId, 'origin/release', false)

    expect(mockChanges).toHaveBeenCalledExactlyOnceWith(
      `yaac-demo-${workspaceId}`, 'origin/release', 'main', false,
    )
  })

  it('asks with no default when nothing records a fork branch', async () => {
    const workspaceId = await installRunning(null)

    await getWorkspaceChanges(workspaceId)

    expect(mockChanges).toHaveBeenCalledExactlyOnceWith(
      `yaac-demo-${workspaceId}`, undefined, undefined, true,
    )
  })

  it('refuses a workspace that is not running', async () => {
    installFakeWorkspaceDriver({ find: () => Promise.resolve(undefined), changes: mockChanges })

    await expect(getWorkspaceChanges('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mockChanges).not.toHaveBeenCalled()
  })

  // Only this layer knows the ref came from the caller; otherwise it would
  // reach the route as an exec failure and answer 500.
  it('answers VALIDATION for an explicit base that resolves nowhere', async () => {
    const workspaceId = await installRunning()
    mockChanges.mockRejectedValue(
      new WorkspaceExecError('command exited 4', CHANGES_BASE_UNRESOLVED, '', ''),
    )

    const err = await getWorkspaceChanges(workspaceId, 'no-such-branch').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ServerError)
    expect(err).toMatchObject({ code: 'VALIDATION', httpStatus: 400 })
    // The message must name the ref; it is the caller's only clue.
    expect((err as ServerError).message).toContain('no-such-branch')
  })

  // With no explicit base, the recorded fork branch failed to resolve. That
  // is a server fault, not the caller's.
  it('keeps an unresolvable default base a server fault', async () => {
    const workspaceId = await installRunning()
    const failure = new WorkspaceExecError('command exited 4', CHANGES_BASE_UNRESOLVED, '', '')
    mockChanges.mockRejectedValue(failure)

    await expect(getWorkspaceChanges(workspaceId)).rejects.toBe(failure)
  })

  // Other nonzero exits say nothing about the ref (exit 3 means "no
  // /workspace"), and calling them user error would hide real breakage.
  it('leaves other exec failures alone even with an explicit base', async () => {
    const workspaceId = await installRunning()
    const failure = new WorkspaceExecError('command exited 3', 3, '', '')
    mockChanges.mockRejectedValue(failure)

    await expect(getWorkspaceChanges(workspaceId, 'dev')).rejects.toBe(failure)
  })
})

/**
 * The first prompt is recorded state (a captured row, or a transcript on the
 * host), so these cases need no running workspace. That matches its callers:
 * the stopped list, and a server whose substrate is down.
 */
describe('getWorkspacePrompt', () => {
  const PROJECT = DEMO_PROJECT_ID
  const WORKSPACE = 'wt-prompt'
  const SESSION = '33333333-3333-3333-3333-333333333333'
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    await recordWorkspaceCreated({ projectId: PROJECT, workspaceId: WORKSPACE })
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  async function seedConversation(capture: {
    firstPrompt?: string
    transcriptPath?: string
  }): Promise<void> {
    await recordAgentSessions(PROJECT, WORKSPACE, [
      { tool: 'claude', agentSessionId: SESSION, mode: 'tui' },
    ])
    await setAgentSessionCapture(PROJECT, 'claude', SESSION, capture)
  }

  it('answers from the captured row when the substrate cannot be asked', async () => {
    installFakeWorkspaceDriver({
      find: () => Promise.reject(new ServerError('RUNTIME_UNAVAILABLE', 'connection refused')),
    })
    await seedConversation({ firstPrompt: 'fix the router' })

    await expect(getWorkspacePrompt(WORKSPACE)).resolves.toBe('fix the router')
  })

  // No prompt was captured, so the transcript is read on the host at the
  // path the row records.
  it('falls back to the recorded transcript of a workspace with no pod', async () => {
    installFakeWorkspaceDriver({ find: () => Promise.resolve(undefined) })
    const file = path.join(claudeDir(PROJECT), 'projects', '-workspace', `${SESSION}.jsonl`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({
      type: 'user', uuid: 'u1', parentUuid: null, sessionId: SESSION, cwd: '/workspace',
      timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'what changed?' },
    }) + '\n')
    await seedConversation({
      transcriptPath: path.relative(projectDir(PROJECT), file),
    })

    await expect(getWorkspacePrompt(WORKSPACE)).resolves.toBe('what changed?')
  })

  it('throws NOT_FOUND when neither the substrate nor the record knows the id', async () => {
    installFakeWorkspaceDriver({ find: () => Promise.resolve(undefined) })
    await expect(getWorkspacePrompt('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
