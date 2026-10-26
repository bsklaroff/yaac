/**
 * The memory-pressure kill. A node whose workspaces together outgrow its
 * RAM thrashes long before the kernel's OOM killer or the kubelet's
 * eviction acts: a gVisor sandbox's memory is shmem, which only swap can
 * free, so the kubelet counts gigabytes as available that the kernel
 * cannot reclaim, and the node stalls with every pod under its limit.
 * netd watches the stall itself, the host-wide PSI `full` average in
 * /proc/pressure/memory, and once it stays high kills the workspace of its
 * install furthest over its memory request, the pod the kubelet's own
 * eviction would rank first (docs/cluster-setup.md "Memory pressure").
 * Host-wide rather than the pods' cgroup, because what makes a thrashing
 * node unusable is the kubelet, containerd and the rest of the host
 * stalling too, and one pod still making progress holds the pods' own
 * `full` reading down. The pods' cgroup must still show some stall, which
 * keeps pressure from outside Kubernetes (a build on a kind host, another
 * cluster) from costing workspaces once it is under way; in its first
 * minute or so, while it swaps idle pods' pages out, it can still cost one
 * or two.
 *
 * The kill writes the pod cgroup's `cgroup.kill`, which takes the whole
 * sandbox at once, so its memory is free as soon as the kernel reaps it.
 * netd never writes to the API; the workspace shows as crashed (reason
 * `Error`, exit code 128 under gVisor), and netd's log names the kill.
 */

import { KUBEPODS_CGROUPS, podCgroupCandidates, type NodePod } from 'yaac-netd/swap'

/**
 * `full avg10` at or above this, in percent, counts as thrashing. A healthy
 * node reads 0 even with swap in use; on a node driven into swap, workloads
 * run ~200x slower with the host reading 15-30%, and readings past 50% come
 * only in short spikes.
 */
export const PRESSURE_LIMIT = 10
/**
 * The pods' cgroup `some avg10` below this, in percent, means the host's
 * pressure is not the pods' doing. A healthy node reads 0; a thrashing one
 * reads its pods' cgroup at 1-10% even when the host reads 15-30%. A node
 * where no pods' cgroup is found skips the check rather than never killing.
 */
export const POD_PRESSURE_FLOOR = 1
/**
 * How long thrashing must last before netd kills. It also keeps a lagging
 * average from causing a second kill: after one, `avg10` falls from even
 * 100% to under the limit in about 23s, inside the cooldown plus the hold.
 */
export const PRESSURE_HOLD_MS = 20_000
/** After a kill, time for the kernel to reclaim the sandbox and for the
 *  other pods to swap their pages back in. */
export const KILL_COOLDOWN_MS = 10_000

export interface PressureDeps {
  pods: () => NodePod[]
  /** /proc/pressure/memory, or null on a kernel without PSI. */
  pressure: () => Promise<string | null>
  /** A cgroup file's contents, or null when the cgroup does not exist. */
  read: (file: string) => Promise<string | null>
  write: (file: string, value: string) => Promise<void>
  /** Milliseconds on a monotonic clock, so a wall-clock step or a resume
   *  from suspend never skips the hold or stretches the cooldown. */
  now: () => number
  log: (message: string) => void
}

const avg10 = (text: string, line: 'some' | 'full'): number | null => {
  const match = new RegExp(`^${line} avg10=(\\d+(?:\\.\\d+)?)`, 'm').exec(text)
  return match ? Number(match[1]) : null
}

/** memory.current less inactive_file, the kubelet's working set. */
const workingSet = (current: string, stat: string | null): number => {
  const inactive = /^inactive_file (\d+)$/m.exec(stat ?? '')
  return Math.max(0, Number(current) - Number(inactive?.[1] ?? 0))
}

/**
 * The pressure check, to be called every couple of seconds; it keeps how
 * long pressure has been high between calls. A node without PSI (a kernel
 * built without it, or booted with it off) logs that once and never kills.
 */
export function createPressureGuard(deps: PressureDeps): () => Promise<void> {
  let highSince: number | null = null
  let quietUntil = 0
  let reportedMissing = false
  let reportedOutside = false

  /** The pods' cgroup `some avg10`, or null where no layout matches. */
  const podPressure = async (): Promise<number | null> => {
    for (const dir of KUBEPODS_CGROUPS) {
      const text = await deps.read(`${dir}/memory.pressure`)
      if (text !== null) return avg10(text, 'some')
    }
    return null
  }

  const victim = async (): Promise<{ name: string; dir: string; over: number } | null> => {
    let worst: { name: string; dir: string; over: number } | null = null
    for (const pod of deps.pods()) {
      if (!pod.workspace) continue
      for (const dir of podCgroupCandidates(pod.uid)) {
        const current = await deps.read(`${dir}/memory.current`)
        if (current === null) continue
        const over = workingSet(current, await deps.read(`${dir}/memory.stat`)) - pod.memoryRequestBytes
        if (!worst || over > worst.over) worst = { name: pod.name, dir, over }
        break
      }
    }
    return worst
  }

  return async () => {
    const now = deps.now()
    if (now < quietUntil) return
    const text = await deps.pressure()
    const full = text === null ? null : avg10(text, 'full')
    if (full === null) {
      if (!reportedMissing) deps.log('[netd] no /proc/pressure/memory; the pressure kill is off')
      reportedMissing = true
      return
    }
    if (full < PRESSURE_LIMIT) {
      highSince = null
      reportedOutside = false
      return
    }
    highSince ??= now
    if (now - highSince < PRESSURE_HOLD_MS) return
    const pods = await podPressure()
    if (pods !== null && pods < POD_PRESSURE_FLOOR) {
      if (!reportedOutside) {
        deps.log(`[netd] host memory pressure (full avg10 ${full}%) with the pods' cgroup at ${pods}%; not killing`)
      }
      reportedOutside = true
      return
    }
    const pick = await victim()
    if (!pick) return
    await deps.write(`${pick.dir}/cgroup.kill`, '1')
    highSince = null
    quietUntil = now + KILL_COOLDOWN_MS
    const overMiB = Math.round(pick.over / 1024 ** 2)
    deps.log(`[netd] memory pressure (full avg10 ${full}%): killed ${pick.name}, ${overMiB}MiB over its request`)
  }
}
