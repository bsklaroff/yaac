import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'
import { recordWorkspaceCreated, recordWorkspaceStopped, setWorkspaceTitle } from '#db/workspace-store'
import { recordAgentSessions } from '#db/agent-session-store'
import { closeDb } from '#db/client'
import { listUsers } from '#db'
import { serverUsageReport } from '#domain/workspaces/usage-report'
import { startUsageSampler, stopUsageSampler } from '#runtime/usage'
// State-reset hook.
import { _resetUsageHistoryForTests } from '#runtime/usage/history'
import { DEMO_PROJECT_ID, recordTestProject } from '@yaac/test-utils/project-fixture'
import type { SubstrateUsage } from '#drivers/contract'

const LIVE = 'a1a1a1a1-0000-4000-8000-000000000001'
const DEAD = 'b2b2b2b2-0000-4000-8000-000000000002'
const NO_ROW = 'c3c3c3c3-0000-4000-8000-000000000003'
const GIB = 2 ** 30

function usage(workspaces: SubstrateUsage['workspaces']): SubstrateUsage {
  return {
    totals: {
      cpuCores: 1, cpuCapacityCores: 8, memoryBytes: 4 * GIB, memoryCapacityBytes: 16 * GIB,
      swapBytes: 0, swapCapacityBytes: 0, disks: [{ name: 'node-a root', usedBytes: 1, capacityBytes: 2 }],
    },
    nodes: [],
    components: [{
      key: 'project-registries', label: 'project registries', cpuCores: 0, memoryBytes: GIB, swapBytes: 0,
      count: 1, volumes: [],
      children: [{
        key: `project-registry:${DEMO_PROJECT_ID}`, label: DEMO_PROJECT_ID, projectId: DEMO_PROJECT_ID,
        cpuCores: 0, memoryBytes: GIB, swapBytes: 0, volumes: [],
      }],
    }],
    workspaces,
  }
}

const use = (memoryBytes: number) => ({
  cpuCores: 0.5, memoryBytes, swapBytes: 0, memoryLimitBytes: 8 * GIB, ephemeralStorageBytes: null, node: 'node-a',
})

describe('serverUsageReport', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    _resetUsageHistoryForTests()
    await recordTestProject(DEMO_PROJECT_ID, { name: 'demo-project' })
    for (const id of [LIVE, DEAD]) {
      await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: id })
    }
    await setWorkspaceTitle(DEMO_PROJECT_ID, LIVE, 'the live one')
    await recordAgentSessions(DEMO_PROJECT_ID, DEAD, [{ tool: 'claude', agentSessionId: DEAD }])
  })

  afterEach(async () => {
    stopUsageSampler()
    vi.useRealTimers()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('joins live usage and the hour of history with titles, projects, owners and death reasons', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    // A minute ago both were running; the dead one has since been OOM killed.
    const resourceUsage = vi.fn((opts: { full: boolean }) => Promise.resolve(opts.full
      ? usage({ [LIVE]: use(2 * GIB), [NO_ROW]: use(GIB) })
      : usage({ [LIVE]: use(3 * GIB), [DEAD]: use(7 * GIB) })))
    installFakeWorkspaceDriver({ kind: 'k8s', resourceUsage })
    startUsageSampler()
    await vi.waitFor(() => expect(resourceUsage).toHaveBeenCalledWith({ full: false }))
    await vi.advanceTimersByTimeAsync(60_000)
    await recordWorkspaceStopped(DEMO_PROJECT_ID, DEAD, { reason: 'oom', detail: 'exit 137' })

    const report = await serverUsageReport()
    const owner = (await listUsers())[0].name

    expect(report.driver).toBe('k8s')
    expect(report.totals.history).toHaveLength(2)
    expect(report.totals.disks).toEqual([{ name: 'node-a root', usedBytes: 1, capacityBytes: 2 }])
    // Per-project registry rows are named for the project.
    expect(report.components[0].children?.[0].label).toBe('demo-project')
    expect(report.components[0].history).toHaveLength(2)

    // Sorted by memory now; the stopped one keeps its last hour.
    expect(report.workspaces.map((w) => w.workspaceId)).toEqual([LIVE, NO_ROW, DEAD])
    expect(report.workspaces[0]).toMatchObject({
      running: true,
      title: 'the live one',
      projectName: 'demo-project',
      owner,
      node: 'node-a',
      memoryBytes: 2 * GIB,
      memoryLimitBytes: 8 * GIB,
      // The peak is over the history, not just now.
      peakMemoryBytes: 3 * GIB,
    })
    expect(report.workspaces[0].history.map((p) => p.memoryBytes)).toEqual([3 * GIB, 3 * GIB])
    // A workspace with no row is listed by its id alone.
    expect(report.workspaces[1]).toMatchObject({ running: true, memoryBytes: GIB })
    expect(report.workspaces[1].projectId).toBeUndefined()
    expect(report.workspaces[2]).toMatchObject({
      running: false,
      memoryBytes: 0,
      peakMemoryBytes: 7 * GIB,
      deathReason: 'oom',
      deathDetail: 'exit 137',
      projectName: 'demo-project',
    })
  })
})
