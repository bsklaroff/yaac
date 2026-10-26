import { describe, expect, it } from 'vitest'
import {
  KILL_COOLDOWN_MS,
  PRESSURE_HOLD_MS,
  PRESSURE_LIMIT,
  createPressureGuard,
} from 'yaac-netd/pressure'
import type { NodePod } from 'yaac-netd/swap'

const GiB = 1024 ** 3
const HOST_PSI = '/proc/pressure/memory'
const psi = (full: number) => `some avg10=${full + 5}.00 avg60=1.00 avg300=0.50 total=1\n`
  + `full avg10=${full}.00 avg60=1.00 avg300=0.50 total=1\n`

/** A fake host: cgroup files and /proc/pressure/memory, a clock, writes and logs recorded. */
function node(files: Record<string, string>, pods: NodePod[]) {
  const writes: Array<[string, string]> = []
  const logs: string[] = []
  let clock = 0
  const check = createPressureGuard({
    pods: () => pods,
    pressure: () => Promise.resolve(files[HOST_PSI] ?? null),
    read: (file) => Promise.resolve(file in files ? files[file] : null),
    write: (file, value) => { writes.push([file, value]); return Promise.resolve() },
    now: () => clock,
    log: (message) => { logs.push(message) },
  })
  return {
    files,
    writes,
    logs,
    /** Advance the clock, then run one check. */
    at: (ms: number) => { clock = ms; return check() },
  }
}

const pod = (name: string, uid: string, requestGiB: number, workspace = true): NodePod =>
  ({ name, uid, memoryRequestBytes: requestGiB * GiB, workspace })
const slice = (uid: string) => `kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod${uid}.slice`

describe('createPressureGuard', () => {
  it('kills the workspace furthest over its request once pressure holds, then waits out a cooldown', async () => {
    const n = node({
      [HOST_PSI]: psi(PRESSURE_LIMIT - 5),
      // Over its request by 5GiB of working set; its page cache does not count.
      [`${slice('a1')}/memory.current`]: String(9 * GiB),
      [`${slice('a1')}/memory.stat`]: `anon 1\ninactive_file ${2 * GiB}\nactive_file 5\n`,
      // Larger in total, but only 4GiB over its request.
      [`${slice('b2')}/memory.current`]: String(8 * GiB),
      [`${slice('b2')}/memory.stat`]: 'inactive_file 0\n',
      // Furthest over of all, but infrastructure.
      [`${slice('c3')}/memory.current`]: String(20 * GiB),
    }, [pod('ws-a', 'a1', 2), pod('ws-b', 'b2', 4), pod('registry', 'c3', 1, false), pod('ws-gone', 'ff', 2)])

    await n.at(0)
    n.files[HOST_PSI] = psi(PRESSURE_LIMIT + 10)
    await n.at(2_000)
    // A dip under the limit restarts the hold.
    n.files[HOST_PSI] = psi(PRESSURE_LIMIT - 1)
    await n.at(2_000 + PRESSURE_HOLD_MS)
    n.files[HOST_PSI] = psi(PRESSURE_LIMIT + 10)
    await n.at(30_000)
    await n.at(30_000 + PRESSURE_HOLD_MS - 1)
    expect(n.writes).toEqual([])

    await n.at(30_000 + PRESSURE_HOLD_MS)
    expect(n.writes).toEqual([[`${slice('a1')}/cgroup.kill`, '1']])
    expect(n.logs).toEqual([
      `[netd] memory pressure (full avg10 ${PRESSURE_LIMIT + 10}%): killed ws-a, 5120MiB over its request`,
    ])

    // Still high while the average catches up: no second kill until the
    // cooldown ends and the pressure has held again.
    const killedAt = 30_000 + PRESSURE_HOLD_MS
    await n.at(killedAt + KILL_COOLDOWN_MS - 1)
    await n.at(killedAt + KILL_COOLDOWN_MS)
    expect(n.writes).toHaveLength(1)
    await n.at(killedAt + KILL_COOLDOWN_MS + PRESSURE_HOLD_MS)
    expect(n.writes).toHaveLength(2)
  })

  it('finds the workspace in kind\'s layout, and kills nothing where no workspace of its install runs', async () => {
    const kindSlice = (uid: string) =>
      `kubelet.slice/kubelet-kubepods.slice/kubelet-kubepods-burstable.slice/kubelet-kubepods-burstable-pod${uid}.slice`
    const n = node({
      [HOST_PSI]: psi(90),
      [`${kindSlice('a1')}/memory.current`]: String(3 * GiB),
      [`${kindSlice('b2')}/memory.current`]: String(8 * GiB),
    }, [pod('proxy', 'b2', 1, false)])
    await n.at(0)
    await n.at(PRESSURE_HOLD_MS)
    expect(n.writes).toEqual([])

    const kind = node({ ...n.files }, [pod('ws-a', 'a1', 2), pod('proxy', 'b2', 1, false)])
    await kind.at(0)
    await kind.at(PRESSURE_HOLD_MS)
    expect(kind.writes).toEqual([[`${kindSlice('a1')}/cgroup.kill`, '1']])
  })

  it('leaves the workspaces alone while the pods\' cgroup is calm, and kills once it is not', async () => {
    const pods = 'kubepods.slice/memory.pressure'
    const calm = 'some avg10=0.40 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n'
    const n = node({
      [HOST_PSI]: psi(40),
      [pods]: calm,
      [`${slice('a1')}/memory.current`]: String(9 * GiB),
    }, [pod('ws-a', 'a1', 2)])
    await n.at(0)
    await n.at(PRESSURE_HOLD_MS)
    await n.at(PRESSURE_HOLD_MS + 2_000)
    expect(n.writes).toEqual([])
    expect(n.logs).toEqual(['[netd] host memory pressure (full avg10 40%) with the pods\' cgroup at 0.4%; not killing'])

    n.files[pods] = psi(1)
    await n.at(PRESSURE_HOLD_MS + 4_000)
    expect(n.writes).toEqual([[`${slice('a1')}/cgroup.kill`, '1']])
  })

  it('stands down on a node without PSI, saying so once', async () => {
    const n = node({ [`${slice('a1')}/memory.current`]: String(9 * GiB) }, [pod('ws-a', 'a1', 2)])
    await n.at(0)
    await n.at(PRESSURE_HOLD_MS)
    expect(n.writes).toEqual([])
    expect(n.logs).toEqual(['[netd] no /proc/pressure/memory; the pressure kill is off'])
  })
})
