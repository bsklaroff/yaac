/**
 * netd, the TypeScript half of the per-node `yaac-netd` DaemonSet, keeps
 * the node's memory in hand. It bounds each pod's swap (swap.ts) whenever
 * the node's pods change and every 30s, and on its own timer kills the
 * workspace thrashing the node out of memory (pressure.ts)
 * (docs/cluster-setup.md "Memory pressure"). The relay beside it, a Go
 * program in the mountd image, carries the node's sandbox traffic
 * (docs/workspace-egress.md).
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { inClusterClient, watchNodePods } from 'yaac-netd/k8s-watch'
import { applySwapBounds } from 'yaac-netd/swap'
import { createPressureGuard } from 'yaac-netd/pressure'

const log = (message: string): void => { console.log(message) }

/** How long a swap pass waits to coalesce a burst of watch events. */
const DEBOUNCE_MS = 200
const RESYNC_INTERVAL_MS = 30_000
/** How often the pressure kill reads PSI, which averages over 10s itself. */
const PRESSURE_POLL_MS = 2_000

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`netd: ${name} is required`)
  return value
}

/**
 * Run until signalled. Swap passes run one at a time: watch events and the
 * resync tick mark the state dirty, and the loop coalesces whatever arrived
 * into the next pass.
 */
async function run(): Promise<void> {
  const namespace = required('YAAC_NAMESPACE')
  const nodeName = required('NODE_NAME')
  // Where the host's cgroup2 tree is mounted, outside /sys, where the
  // runtime's AppArmor profile denies writes.
  const cgroupRoot = process.env.NETD_CGROUP_ROOT ?? '/host/cgroup'
  log(`[netd] node=${nodeName} ns=${namespace}`)

  let dirty = true
  let wake = (): void => { /* replaced while the loop waits */ }
  const request = (): void => { dirty = true; wake() }
  const nodePods = watchNodePods(inClusterClient(namespace), nodeName, request)
  setInterval(request, RESYNC_INTERVAL_MS)
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => process.exit(0))

  const cgroupFile = (file: string): string => path.join(cgroupRoot, file)
  const read = (file: string): Promise<string | null> => fs.readFile(cgroupFile(file), 'utf8').catch(() => null)
  const write = (file: string, value: string): Promise<void> => fs.writeFile(cgroupFile(file), value)
  const checkPressure = createPressureGuard({
    pods: nodePods,
    pressure: () => fs.readFile('/proc/pressure/memory', 'utf8').catch(() => null),
    read,
    write,
    now: () => performance.now(),
    log,
  })
  let checking = false
  setInterval(() => {
    if (checking) return
    checking = true
    checkPressure()
      .catch((err: unknown) => { log(`[netd] pressure check failed: ${String(err)}`) })
      .finally(() => { checking = false })
  }, PRESSURE_POLL_MS)

  for (;;) {
    if (!dirty) await new Promise<void>((resolve) => { wake = resolve })
    await sleep(DEBOUNCE_MS)
    dirty = false
    try {
      const bounded = await applySwapBounds({
        pods: nodePods,
        meminfo: () => fs.readFile('/proc/meminfo', 'utf8'),
        read,
        write,
      })
      if (bounded.length > 0) log(`[netd] swap bounds ${bounded.join(' ')}`)
    } catch (err) {
      log(`[netd] swap bounds failed: ${String(err)}`)
    }
  }
}

run().catch((err: unknown) => {
  console.error(`[netd] fatal: ${String(err)}`)
  process.exit(1)
})
