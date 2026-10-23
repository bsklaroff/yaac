import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { globalRoot, setDataDir } from '@yaac/shared/paths'

import type * as hostModule from '#drivers/containerless/host'

const mockTable = vi.hoisted(() => vi.fn())
const mockMemory = vi.hoisted(() => vi.fn())
const mockCpuTimes = vi.hoisted(() => vi.fn())
const mockDisk = vi.hoisted(() => vi.fn())
vi.mock('#drivers/containerless/host', async (importOriginal) => ({
  ...(await importOriginal<typeof hostModule>()),
  processTable: mockTable,
  hostMemory: mockMemory,
  hostCpuTimes: mockCpuTimes,
  diskUsage: mockDisk,
  // No listeners: this file is about usage, not ports.
  listeningPorts: () => Promise.resolve([]),
}))
import { containerlessUsage, _resetUsageForTests } from '#drivers/containerless/usage'
// The sweep takes the `ps` tables usage reads; state-reset hooks.
import { _resetPortsForTests, sweepPorts } from '#drivers/containerless/ports'
import { _resetRegistryForTests, observeLiveness, rememberWorkspace } from '#drivers/containerless/registry'
import type { ProcessRow, ProcessTable } from '#drivers/containerless/host'

const LIVE = '4bfc59c6-1e83-4dd0-80f1-735294d5d2bb'
const DEAD = '5c0d6ad7-2f94-4ee1-91a2-846305e6e3cc'
const MIB = 2 ** 20
const GIB = 2 ** 30

/** `rows` as a `ps` table taken at `at`. */
function table(at: number, rows: Record<number, [ppid: number, rssMib: number, cpuSeconds: number]>): ProcessTable {
  return {
    at,
    rows: new Map(Object.entries(rows).map(([pid, [ppid, rss, cpu]]): [number, ProcessRow] =>
      [Number(pid), { ppid, rssBytes: rss * MIB, cpuSeconds: cpu }])),
  }
}

let dataDir: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-cl-usage-'))
  setDataDir(dataDir)
  _resetRegistryForTests()
  _resetPortsForTests()
  _resetUsageForTests()
  // Half of 4 cores busy between the two reads.
  mockCpuTimes.mockReset()
    .mockReturnValueOnce({ idleMs: 1_000, totalMs: 2_000, cores: 4 })
    .mockReturnValue({ idleMs: 1_500, totalMs: 3_000, cores: 4 })
  mockMemory.mockReset().mockResolvedValue({
    totalBytes: 16 * GIB, usedBytes: 6 * GIB, swapTotalBytes: 2 * GIB, swapUsedBytes: GIB,
  })
  mockDisk.mockReset().mockResolvedValue({ usedBytes: 40 * GIB, capacityBytes: 100 * GIB })
  // A workspace (tmux 4242 with a child), its ssh-agent (9000), and a
  // process of nobody's.
  mockTable.mockReset()
    .mockResolvedValueOnce(table(0, {
      4242: [1, 10, 1], 5150: [4242, 100, 10], 9000: [1, 5, 0], 7777: [1, 500, 50],
    }))
    .mockResolvedValue(table(30_000, {
      4242: [1, 10, 1], 5150: [4242, 200, 25], 5151: [5150, 50, 3], 9000: [1, 5, 0], 7777: [1, 500, 80],
    }))
  rememberWorkspace({
    projectId: 'demo', workspaceId: LIVE, tool: 'claude', mode: 'tui',
    createdAtMs: 1_000, launchEnv: {}, tmuxPid: 4242, sshAgentPid: 9000,
  })
  rememberWorkspace({
    projectId: 'demo', workspaceId: DEAD, tool: 'claude', mode: 'tui',
    createdAtMs: 1_000, launchEnv: {}, tmuxPid: 7777,
  })
  observeLiveness(DEAD, false, { reason: 'agent-exited' })
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('containerlessUsage', () => {
  it('splits the host into the server, ssh-agents, workspaces and the rest, from the port sweep\'s ps tables', async () => {
    await sweepPorts()
    await sweepPorts()
    const usage = await containerlessUsage({ full: true })

    expect(usage.totals).toEqual({
      cpuCores: 2,
      cpuCapacityCores: 4,
      memoryBytes: 6 * GIB,
      memoryCapacityBytes: 16 * GIB,
      swapBytes: GIB,
      swapCapacityBytes: 2 * GIB,
      disks: [{ name: 'data dir', usedBytes: 40 * GIB, capacityBytes: 100 * GIB }],
    })
    expect(mockDisk).toHaveBeenCalledWith(globalRoot())
    expect(usage.nodes).toEqual([])

    // The tree under tmux, including a process forked within the window,
    // whose CPU time all counts: (0 + 15 + 3) s over 30 s.
    expect(Object.keys(usage.workspaces)).toEqual([LIVE])
    expect(usage.workspaces[LIVE]).toEqual({
      cpuCores: 0.6,
      memoryBytes: 260 * MIB,
      memoryLimitBytes: null,
      ephemeralStorageBytes: null,
    })

    const byKey = Object.fromEntries(usage.components.map((c) => [c.key, c]))
    expect(byKey['ssh-agents']).toMatchObject({ count: 1, memoryBytes: 5 * MIB, cpuCores: 0 })
    expect(byKey.server.memoryBytes).toBeGreaterThan(0)
    expect(byKey.server.volumes).toEqual(usage.totals.disks)
    // Whatever yaac does not account for.
    expect(byKey.other.memoryBytes).toBe(6 * GIB - byKey.server.memoryBytes - 5 * MIB - 260 * MIB)
    expect(byKey.other.cpuCores).toBeCloseTo(2 - byKey.server.cpuCores - 0.6)
  })

  it('reads no disk for the sampler, and reports no workspace before the first sweep', async () => {
    const usage = await containerlessUsage({ full: false })
    expect(usage.totals.disks).toEqual([])
    expect(mockDisk).not.toHaveBeenCalled()
    expect(usage.workspaces).toEqual({})
    expect(usage.components.find((c) => c.key === 'ssh-agents')).toMatchObject({ count: 0, memoryBytes: 0 })
  })
})
