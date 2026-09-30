/**
 * The runtime half of a workspace listing — `observeWorkspaces`.
 *
 * Mocked at the contract boundary only, so the classification, the
 * terminating prune and the per-agent liveness join all run for real against
 * the status store. What a driver contributes is exactly what it is asked
 * for here: which workspaces exist, and the four per-workspace facts only it
 * can see.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { observeWorkspaces } from '#runtime/status/observe'
import {
  setAgentStatus,
  setLiveAgents,
  setWorkspaceStreamHealth,
  _resetWorkspaceStatusStoreForTests,
} from '#runtime/status/status-store'
import {
  markWorkspaceTerminating,
  isWorkspaceTerminating,
  _clearTerminatingForTests,
} from '#runtime/status/terminating'
import { handleFixture, installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import type { RuntimeHandle, WorkspaceDriver } from '#drivers/contract'

const list = vi.fn<WorkspaceDriver['list']>()

function workspace(overrides: Partial<RuntimeHandle> = {}): RuntimeHandle {
  return handleFixture({ projectSlug: 'proj', workspaceId: 'w1', jobName: 'yaac-proj-w1', ...overrides })
}

/** Alive to the display path, which reads stream health rather than probing. */
function streaming(slug: string, id: string): void {
  setWorkspaceStreamHealth(slug, id, true)
}

beforeEach(() => {
  vi.resetAllMocks()
  _resetWorkspaceStatusStoreForTests()
  _clearTerminatingForTests()
  list.mockResolvedValue([])
  installFakeWorkspaceDriver({ list })
})

describe('observeWorkspaces', () => {
  it('takes the listing from the push-fed view, since it runs on every snapshot', async () => {
    await observeWorkspaces('proj')
    expect(list).toHaveBeenCalledWith('proj', { preferCache: true })
  })

  it('joins each workspace with what only the driver can see', async () => {
    list.mockResolvedValue([workspace()])
    streaming('proj', 'w1')
    installFakeWorkspaceDriver({
      list,
      blockedHosts: () => Promise.resolve(['evil.test']),
      forwardedPorts: () => Promise.resolve([{ containerPort: 3000, hostPort: 19000 }]),
      unforwardedPorts: () => Promise.resolve([8080]),
      allGitAuthFailures: () => Promise.resolve({
        proj: [{ host: 'github.com', status: 401, atMs: 1 }],
      }),
    })

    const report = await observeWorkspaces()

    expect(report.workspaces).toHaveLength(1)
    expect(report.workspaces[0]).toMatchObject({
      workspaceId: 'w1',
      projectSlug: 'proj',
      phase: 'running',
      blockedHosts: ['evil.test'],
      forwardedPorts: [{ containerPort: 3000, hostPort: 19000 }],
      unforwardedPorts: [8080],
    })
    expect(report.gitAuthFailures.proj).toHaveLength(1)
  })

  it('reports each live agent by handle, and the workspace aggregate over them', async () => {
    list.mockResolvedValue([workspace()])
    streaming('proj', 'w1')
    setLiveAgents('proj', 'w1', [
      { handle: '%0', tool: 'claude' },
      { handle: '%1', tool: 'claude' },
    ])
    setAgentStatus('proj', 'w1', '%0', 'running')
    setAgentStatus('proj', 'w1', '%1', 'waiting')

    const [w] = (await observeWorkspaces()).workspaces

    expect(w.agents.map((a) => [a.handle, a.status])).toEqual([['%0', 'running'], ['%1', 'waiting']])
    // Any agent waiting makes the workspace wait — that is the badge's meaning.
    expect(w.status).toBe('waiting')
  })

  it('hides prewarmed spares, which are not workspaces until claimed', async () => {
    list.mockResolvedValue([
      workspace({ workspaceId: 'spare', prewarmed: true }),
      workspace(),
    ])
    streaming('proj', 'w1')

    const report = await observeWorkspaces()

    expect(report.workspaces.map((w) => w.workspaceId)).toEqual(['w1'])
  })

  it('reports a marked workspace as terminating, with no status read', async () => {
    // The store was evicted at teardown, so reading it would default to
    // `waiting` — a spurious attention badge on a row that is disappearing.
    markWorkspaceTerminating('w1')
    list.mockResolvedValue([workspace()])

    const [w] = (await observeWorkspaces()).workspaces

    expect(w.phase).toBe('terminating')
    expect(w.status).toBe('running')
    expect(w.agents).toEqual([])
    expect(w.waitingSinceMs).toBeUndefined()
  })

  it('forgets a terminating mark once its workspace is gone', async () => {
    markWorkspaceTerminating('gone')
    list.mockResolvedValue([workspace()])
    streaming('proj', 'w1')

    await observeWorkspaces()

    // Otherwise the mark leaks, and an id reused by a later workspace renders
    // permanently greyed.
    expect(isWorkspaceTerminating('gone')).toBe(false)
  })

  it('reports a workspace whose runtime is gone as stale, with its death cause', async () => {
    list.mockResolvedValue([workspace({
      running: false,
      state: 'failed',
      createdAtMs: 1,
      deathCause: { reason: 'crashed', detail: 'exit code 1' },
    })])

    const report = await observeWorkspaces()

    expect(report.workspaces).toEqual([])
    expect(report.stale).toEqual([{
      jobName: 'yaac-proj-w1',
      projectSlug: 'proj',
      workspaceId: 'w1',
      zombie: false,
      deathCause: { reason: 'crashed', detail: 'exit code 1' },
    }])
  })
})
