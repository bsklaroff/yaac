import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installRealWorkspaceDriver } from '@yaac/test-utils/real-driver'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

vi.mock('#drivers/k8s/substrate/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return {
    ...actual,
    listWorkspacePods: vi.fn().mockResolvedValue([]),
    listWorkspaceJobs: vi.fn().mockResolvedValue([]),
  }
})

vi.mock('#runtime/agents/agent-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof agentToolsModule>()
  return {
    ...actual,
    getAgentSessionFirstMessage: vi.fn().mockResolvedValue(undefined),
  }
})

// Only the substrate and first-message lookup are stubbed; the listing joins
// real rows with the real status store.
import { listWorkspacePods, type PodInfo } from '#drivers/k8s/substrate/pods'
import type * as podsModule from '#drivers/k8s/substrate/pods'
import type * as agentToolsModule from '#runtime/agents/agent-tools'
import {
  setAgentStatus,
  _resetWorkspaceStatusStoreForTests,
} from '#runtime/status/status-store'
import { listActiveWorkspaces, _clearListActiveInflightForTests } from '#domain/workspaces/list'

const mockListPods = vi.mocked(listWorkspacePods)

function pod(workspaceId: string): PodInfo {
  return {
    jobName: `yaac-demo-${workspaceId}`,
    podName: `yaac-demo-${workspaceId}-x1`,
    workspaceId,
    projectSlug: 'demo',
    projectId: '3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c',
    tool: 'claude',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: 1_000,
    labels: {},
  }
}

/** listActiveWorkspaces with the single-flight cache cleared between calls,
 *  so each call in a test observes fresh store state. */
async function listFresh(): Promise<Awaited<ReturnType<typeof listActiveWorkspaces>>> {
  _clearListActiveInflightForTests()
  return listActiveWorkspaces()
}

describe('listActiveWorkspaces waitingSinceMs (store projection)', () => {
  let tmpDir: string

  beforeEach(async () => {
    installRealWorkspaceDriver()
    tmpDir = await createTempDataDir()
    _resetWorkspaceStatusStoreForTests()
    mockListPods.mockReset()
    mockListPods.mockResolvedValue([pod('s1')])
  })

  afterEach(async () => {
    vi.useRealTimers()
    await cleanupTempDir(tmpDir)
  })

  it('projects the store spell into the entry, stable across listings', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    setAgentStatus('demo', 's1', '%0', 'waiting')
    const first = await listFresh()
    expect(first.workspaces[0].status).toBe('waiting')
    expect(first.workspaces[0].waitingSinceMs).toBe(1_000)

    // The waiting stamp stays at when the wait began.
    vi.setSystemTime(60_000)
    const second = await listFresh()
    expect(second.workspaces[0].waitingSinceMs).toBe(1_000)
  })

  it('running is unstamped; a fresh wait restamps', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    setAgentStatus('demo', 's1', '%0', 'waiting')
    setAgentStatus('demo', 's1', '%0', 'running')
    const running = await listFresh()
    expect(running.workspaces[0].status).toBe('running')
    expect(running.workspaces[0].waitingSinceMs).toBeUndefined()

    vi.setSystemTime(2_000)
    setAgentStatus('demo', 's1', '%0', 'waiting')
    const waiting = await listFresh()
    expect(waiting.workspaces[0].status).toBe('waiting')
    expect(waiting.workspaces[0].waitingSinceMs).toBe(2_000)
  })

  it('a booting session (no store entry) lists as waiting with no stamp', async () => {
    const result = await listFresh()
    expect(result.workspaces[0].status).toBe('waiting')
    expect(result.workspaces[0].waitingSinceMs).toBeUndefined()
  })
})
