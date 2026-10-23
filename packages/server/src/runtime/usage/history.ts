import { workspaceDriver } from '#drivers/driver'
import { errorText, serverLog } from '#lib/log'
import type { SubstrateUsage } from '#drivers/contract'
import type { ResourceUse, UsagePoint } from '@yaac/shared/types'

/**
 * An hour of CPU and memory history for the server health overlay
 * (docs/server-health.md), sampled every minute whenever the server runs,
 * since history that started when the overlay opened would be of little
 * use. Kept in memory, so it starts over when the server restarts; storing
 * it would cost a table and a write a minute.
 *
 * The sampler takes the driver's cheaper read, without storage figures.
 * Disk is not kept: it moves slowly and the overlay shows it live.
 */

export const SAMPLE_MS = 60_000
/** Points per series: an hour at the sample cadence. */
export const MAX_POINTS = 60
const RETAIN_MS = MAX_POINTS * SAMPLE_MS

/** The series, oldest point first. Keyed series are by node name,
 *  component key and workspace id. */
export interface UsageHistory {
  totals: UsagePoint[]
  nodes: ReadonlyMap<string, UsagePoint[]>
  components: ReadonlyMap<string, UsagePoint[]>
  workspaces: ReadonlyMap<string, UsagePoint[]>
}

const totals: UsagePoint[] = []
const nodes = new Map<string, UsagePoint[]>()
const components = new Map<string, UsagePoint[]>()
const workspaces = new Map<string, UsagePoint[]>()

let timer: NodeJS.Timeout | null = null
/** The last failure logged, so a failing sampler logs once, not every minute. */
let lastError: string | null = null
/** Whether a sample is still running. One that outlasts the minute (a slow
 *  apiserver) makes the next tick skip rather than pile up. */
let sampling = false

/** Test helper: drop every series. */
export function _resetUsageHistoryForTests(): void {
  totals.length = 0
  nodes.clear()
  components.clear()
  workspaces.clear()
  lastError = null
  sampling = false
}

function append(series: UsagePoint[], use: ResourceUse, at: number): void {
  series.push({ at, cpuCores: use.cpuCores, memoryBytes: use.memoryBytes })
  while (series.length > MAX_POINTS || (series.length > 0 && at - series[0].at > RETAIN_MS)) series.shift()
}

/**
 * Add one sample. A keyed series is kept until its newest point is an hour
 * old, so a stopped workspace's last hour stays visible after it is gone.
 *
 * What was not measured gets no point rather than a false zero: a node
 * whose stats are missing, and, while any node is missing, the totals and
 * components, which would then be partial sums. A workspace on that node is
 * absent from the sample, so it gets none either.
 */
export function recordUsageSample(usage: SubstrateUsage, at = Date.now()): void {
  const complete = usage.nodes.every((n) => n.error === undefined)
  if (complete) append(totals, usage.totals, at)
  const keyed: Array<[Map<string, UsagePoint[]>, Array<[string, ResourceUse]>]> = [
    [nodes, usage.nodes.filter((n) => n.error === undefined).map((n) => [n.name, n])],
    [components, complete ? usage.components.map((c) => [c.key, c]) : []],
    [workspaces, Object.entries(usage.workspaces)],
  ]
  for (const [map, entries] of keyed) {
    for (const [key, use] of entries) {
      const series = map.get(key) ?? []
      append(series, use, at)
      map.set(key, series)
    }
    for (const [key, series] of map) {
      const newest = series.at(-1)
      if (!newest || at - newest.at > RETAIN_MS) map.delete(key)
    }
  }
}

export function usageHistory(): UsageHistory {
  return { totals, nodes, components, workspaces }
}

async function sample(): Promise<void> {
  if (sampling) return
  sampling = true
  try {
    recordUsageSample(await workspaceDriver().resourceUsage({ full: false }))
    lastError = null
  } catch (err) {
    const text = errorText(err)
    if (text !== lastError) serverLog(`[server] usage sample failed: ${text}`)
    lastError = text
  } finally {
    sampling = false
  }
}

/** Sample now and then every minute, until `stopUsageSampler`. */
export function startUsageSampler(): void {
  if (timer) return
  void sample()
  timer = setInterval(() => { void sample() }, SAMPLE_MS)
  timer.unref?.()
}

export function stopUsageSampler(): void {
  if (timer) clearInterval(timer)
  timer = null
}
