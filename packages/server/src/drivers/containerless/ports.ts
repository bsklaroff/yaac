import net from 'node:net'
import { MAX_SURFACED_PORTS, isForwardablePort } from '#lib/port-policy'
import { descendantPids, listeningPorts, processTable, type Listener, type ProcessTable } from './host'
import { listWorkspaces, tmuxPidOf } from './registry'
import type { Duplex } from 'node:stream'
import type { PortMapping } from '@yaac/shared/types'

/**
 * Which ports each running workspace is listening on, found by polling (no
 * portable listen event exists). Workspaces bind host ports directly, so
 * each listener is reported as a `forwardedPorts` identity mapping and
 * `unforwardedPorts` is always empty. A client on another machine reaches
 * them through the tunnel (`dialWorkspacePort`).
 *
 * Each sweep takes one `ps` table, which the usage report (`usage.ts`) also
 * reads, so watching usage spawns nothing of its own.
 */

const POLL_MS = 3_000

/**
 * How far back the oldest kept table reaches. Linux `ps` reports CPU time
 * in whole seconds, so a rate over one 3s tick would be mostly rounding.
 */
const CPU_WINDOW_MS = 30_000

const ports = new Map<string, Listener[]>()
/** The sweep's recent `ps` tables, oldest first. */
const tables: ProcessTable[] = []
let timer: NodeJS.Timeout | null = null

/** Test helper: drop all detector state. */
export function _resetPortsForTests(): void {
  ports.clear()
  tables.length = 0
}

/** The oldest and newest `ps` table the sweep holds, or null before its
 *  first table. Empty while no workspace runs. */
export function processWindow(): { first: ProcessTable; last: ProcessTable } | null {
  const first = tables[0]
  const last = tables.at(-1)
  return first && last ? { first, last } : null
}

/** See `WorkspaceDriver.forwardedPorts`: identity mappings from the last
 *  sweep. */
export function workspacePorts(workspaceId: string): PortMapping[] {
  return (ports.get(workspaceId) ?? []).map(({ port }) => ({ containerPort: port, hostPort: port }))
}

/** One sweep over every running workspace; returns whether anything
 *  changed. */
export async function sweepPorts(): Promise<boolean> {
  let changed = false
  const handles = listWorkspaces()
  const table = handles.some((h) => h.running && tmuxPidOf(h.workspaceId) !== undefined)
    ? await processTable()
    : null
  if (table) {
    tables.push(table)
    while (tables.length > 2 && table.at - tables[1].at >= CPU_WINDOW_MS) tables.shift()
  } else {
    tables.length = 0
  }
  for (const handle of handles) {
    if (!handle.running) {
      if (ports.delete(handle.workspaceId)) changed = true
      continue
    }
    const root = tmuxPidOf(handle.workspaceId)
    if (root === undefined) continue
    const found = (await listeningPorts(descendantPids(table, [root])))
      .filter((l) => isForwardablePort(l.port))
      .slice(0, MAX_SURFACED_PORTS)
    const before = ports.get(handle.workspaceId) ?? []
    if (
      before.length !== found.length
      || before.some((l, i) => l.port !== found[i].port || l.host !== found[i].host)
    ) {
      ports.set(handle.workspaceId, found)
      changed = true
    }
  }
  return changed
}

/** Start the sweep. `onChange` fires only when the set changes. */
export function startPortSweep(onChange: () => void): void {
  if (timer) return
  timer = setInterval(() => {
    void sweepPorts().then((changed) => { if (changed) onChange() })
  }, POLL_MS)
  timer.unref?.()
}

export function stopPortSweep(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/** Drop a workspace's ports when it goes away. */
export function forgetPorts(workspaceId: string): void {
  ports.delete(workspaceId)
}

/**
 * See `WorkspaceDriver.dialPort`. Only listeners the last sweep found in the
 * workspace's own process tree may be dialed, at their recorded address, so
 * other services on this host stay unreachable. The list may be up to
 * `POLL_MS` stale; checking per dial would cost an lsof per connection.
 */
export function dialWorkspacePort(workspaceId: string, port: number): Promise<Duplex> {
  const listener = (ports.get(workspaceId) ?? []).find((l) => l.port === port)
  if (!listener) {
    return Promise.reject(new Error(`port ${String(port)} is not one this workspace is listening on`))
  }
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: listener.host, port })
    // Paused, as the contract requires.
    socket.pause()
    socket.once('connect', () => resolve(socket))
    // Stays attached after connect, so an early error is never uncaught.
    socket.once('error', reject)
  })
}
