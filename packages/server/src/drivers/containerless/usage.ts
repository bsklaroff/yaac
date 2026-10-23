import { globalRoot } from '@yaac/shared/paths'
import { descendantPids, diskUsage, hostCpuTimes, hostMemory, type ProcessTable } from './host'
import { processWindow } from './ports'
import { listWorkspaces, sshAgentPidOf, tmuxPidOf } from './registry'
import type { SubstrateUsage } from '#drivers/contract'
import type { ComponentUsage, ResourceUse, VolumeUsage, WorkspaceResourceUse } from '@yaac/shared/types'

/**
 * `WorkspaceDriver.resourceUsage` for the host (docs/server-health.md). A
 * workspace's usage is its process tree under tmux, read from the port
 * sweep's `ps` tables. Memory is RSS, which counts a page shared by several
 * processes once per process, so it is an approximation. `ps` has no swap
 * figure per process, so only the host total has one.
 */

/** The previous read's CPU counters: rates are averaged since then. */
let previous: { host: ReturnType<typeof hostCpuTimes>; server: NodeJS.CpuUsage; at: number } | null = null

/** The shortest span a CPU rate is measured over. */
const MIN_CPU_SPAN_MS = 250

/** Test helper: forget the previous CPU reading. */
export function _resetUsageForTests(): void {
  previous = null
}

/** Host and server CPU in use, in cores, since the previous read. */
async function cpuRates(): Promise<{ host: number; server: number; cores: number }> {
  if (!previous || Date.now() - previous.at < MIN_CPU_SPAN_MS) {
    previous = { host: hostCpuTimes(), server: process.cpuUsage(), at: Date.now() }
    await new Promise((r) => setTimeout(r, MIN_CPU_SPAN_MS))
  }
  const host = hostCpuTimes()
  const server = process.cpuUsage()
  const spanMs = Date.now() - previous.at
  const busyMs = (host.totalMs - previous.host.totalMs) - (host.idleMs - previous.host.idleMs)
  const totalMs = host.totalMs - previous.host.totalMs
  const serverMs = (server.user + server.system - previous.server.user - previous.server.system) / 1000
  previous = { host, server, at: Date.now() }
  return {
    host: totalMs > 0 ? Math.max(0, (busyMs / totalMs) * host.cores) : 0,
    server: Math.max(0, serverMs / spanMs),
    cores: host.cores,
  }
}

/** The memory and CPU rate of a set of processes across the sweep's
 *  window. A process absent from the first table counts all of its CPU
 *  time, since it started within the window. */
function processUse(window: { first: ProcessTable; last: ProcessTable }, pids: number[]): ResourceUse {
  const span = (window.last.at - window.first.at) / 1000
  let memoryBytes = 0
  let cpuSeconds = 0
  for (const pid of pids) {
    const now = window.last.rows.get(pid)
    if (!now) continue
    memoryBytes += now.rssBytes
    cpuSeconds += Math.max(0, now.cpuSeconds - (window.first.rows.get(pid)?.cpuSeconds ?? 0))
  }
  return { cpuCores: span > 0 ? cpuSeconds / span : 0, memoryBytes }
}

/** See `WorkspaceDriver.resourceUsage`. */
export async function containerlessUsage(opts: { full: boolean }): Promise<SubstrateUsage> {
  const [cpu, memory, disk] = await Promise.all([
    cpuRates(),
    hostMemory(),
    opts.full ? diskUsage(globalRoot()).catch(() => null) : null,
  ])
  const window = processWindow()
  const handles = listWorkspaces()

  const workspaces: Record<string, WorkspaceResourceUse> = {}
  for (const handle of handles) {
    const root = tmuxPidOf(handle.workspaceId)
    if (!handle.running || root === undefined || !window) continue
    workspaces[handle.workspaceId] = {
      ...processUse(window, descendantPids(window.last, [root])),
      memoryLimitBytes: null,
      ephemeralStorageBytes: null,
    }
  }
  const agentPids = handles
    .map((h) => sshAgentPidOf(h.workspaceId))
    .filter((pid): pid is number => pid !== undefined && window?.last.rows.has(pid) === true)
  const agents = window ? processUse(window, agentPids) : { cpuCores: 0, memoryBytes: 0 }
  const server = { cpuCores: cpu.server, memoryBytes: process.memoryUsage().rss }

  const disks: VolumeUsage[] = disk ? [{ name: 'data dir', ...disk }] : []
  const ours = [server, agents, ...Object.values(workspaces)]
  const components: ComponentUsage[] = [
    { key: 'server', label: 'yaac server', ...server, volumes: disks },
    { key: 'ssh-agents', label: 'ssh-agents', ...agents, count: agentPids.length, volumes: [] },
    {
      key: 'other',
      label: 'other host processes',
      cpuCores: Math.max(0, cpu.host - ours.reduce((sum, u) => sum + u.cpuCores, 0)),
      memoryBytes: Math.max(0, memory.usedBytes - ours.reduce((sum, u) => sum + u.memoryBytes, 0)),
      volumes: [],
    },
  ]
  return {
    totals: {
      cpuCores: cpu.host,
      cpuCapacityCores: cpu.cores,
      memoryBytes: memory.usedBytes,
      memoryCapacityBytes: memory.totalBytes,
      swapBytes: memory.swapUsedBytes,
      swapCapacityBytes: memory.swapTotalBytes,
      disks,
    },
    nodes: [],
    components,
    workspaces,
  }
}
