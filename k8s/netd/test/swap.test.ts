import { describe, expect, it } from 'vitest'
import {
  applySwapBounds,
  parseMeminfo,
  parseQuantity,
  podMemoryRequestBytes,
  swapBoundBytes,
  type NodePod,
} from 'yaac-netd/swap'

const GiB = 1024 ** 3
const MEMINFO_32G = 'MemTotal:       33554432 kB\nMemFree:        1000 kB\nSwapTotal:      33554432 kB\n'

describe('parseQuantity', () => {
  it('reads plain bytes and both suffix families', () => {
    expect(parseQuantity('2147483648')).toBe(2 * GiB)
    expect(parseQuantity('2Gi')).toBe(2 * GiB)
    expect(parseQuantity('64Mi')).toBe(64 * 1024 ** 2)
    expect(parseQuantity('1.5Gi')).toBe(1.5 * GiB)
    expect(parseQuantity('500M')).toBe(500e6)
    expect(parseQuantity('128k')).toBe(128e3)
  })

  it('reads anything it does not understand as no request', () => {
    expect(parseQuantity('')).toBe(0)
    expect(parseQuantity('lots')).toBe(0)
    expect(parseQuantity('1e3')).toBe(0)
  })
})

describe('podMemoryRequestBytes', () => {
  it('sums the containers and takes the larger of that and the largest init container', () => {
    const mem = (memory: string) => ({ resources: { requests: { memory } } })
    expect(podMemoryRequestBytes({ containers: [mem('2Gi'), mem('512Mi')] })).toBe(2.5 * GiB)
    expect(podMemoryRequestBytes({
      containers: [mem('1Gi')], initContainers: [mem('3Gi'), mem('16Mi')],
    })).toBe(3 * GiB)
    expect(podMemoryRequestBytes({ containers: [{}], initContainers: [mem('16Mi')] })).toBe(16 * 1024 ** 2)
    expect(podMemoryRequestBytes({})).toBe(0)
  })
})

describe('parseMeminfo', () => {
  it('reads RAM and swap totals, and no swap as 0', () => {
    expect(parseMeminfo(MEMINFO_32G)).toEqual({ memTotal: 32 * GiB, swapTotal: 32 * GiB })
    expect(parseMeminfo('MemTotal:       1024 kB\n')).toEqual({ memTotal: 1024 ** 2, swapTotal: 0 })
  })
})

describe('swapBoundBytes', () => {
  it('gives a pod its request\'s share of swap, page-aligned, and none without swap', () => {
    expect(swapBoundBytes(2 * GiB, 32 * GiB, 32 * GiB)).toBe(2 * GiB)
    expect(swapBoundBytes(2 * GiB, 32 * GiB, 64 * GiB)).toBe(4 * GiB)
    expect(swapBoundBytes(1000, 32 * GiB, 32 * GiB)).toBe(0)
    expect(swapBoundBytes(2 * GiB, 32 * GiB, 0)).toBe(0)
    expect(swapBoundBytes(2 * GiB, 0, 32 * GiB)).toBe(0)
    expect(swapBoundBytes(3 * GiB, 31 * GiB, 31 * GiB + 12345) % 4096).toBe(0)
  })
})

describe('applySwapBounds', () => {
  /** A fake cgroup tree: file path to contents, with every write recorded. */
  function cgroups(files: Record<string, string>) {
    const writes: Array<[string, string]> = []
    return {
      writes,
      read: (file: string) => Promise.resolve(file in files ? files[file] : null),
      write: (file: string, value: string) => {
        writes.push([file, value])
        files[file] = `${value}\n`
        return Promise.resolve()
      },
    }
  }
  const pod = (name: string, uid: string, gib: number): NodePod => ({ name, uid, memoryRequestBytes: gib * GiB })

  it('bounds each pod on whichever cgroup layout the node uses, then leaves a correct value alone', async () => {
    const fs = cgroups({
      // k3s/EKS: systemd driver under kubepods.slice.
      'kubepods.slice/kubepods-burstable.slice/kubepods-burstable-poda1_b2.slice/memory.swap.max': 'max\n',
      // kind: kubelet nested under kubelet.slice.
      'kubelet.slice/kubelet-kubepods.slice/kubelet-kubepods-besteffort.slice/kubelet-kubepods-besteffort-podc3_d4.slice/memory.swap.max': 'max\n',
      // cgroupfs driver.
      'kubepods/burstable/pode5-f6/memory.swap.max': 'max\n',
    })
    const deps = {
      ...fs,
      pods: () => [pod('ws', 'a1-b2', 2), pod('idle', 'c3-d4', 0), pod('builder', 'e5-f6', 4), pod('gone', 'ff-ff', 2)],
      meminfo: () => Promise.resolve(MEMINFO_32G),
    }
    expect(await applySwapBounds(deps)).toEqual([`ws=${2 * GiB}`, 'idle=0', `builder=${4 * GiB}`])
    expect(fs.writes.map(([file]) => file)).toEqual([
      'kubepods.slice/kubepods-burstable.slice/kubepods-burstable-poda1_b2.slice/memory.swap.max',
      'kubelet.slice/kubelet-kubepods.slice/kubelet-kubepods-besteffort.slice/kubelet-kubepods-besteffort-podc3_d4.slice/memory.swap.max',
      'kubepods/burstable/pode5-f6/memory.swap.max',
    ])
    // The next pass rereads the kernel's values and finds nothing to do.
    expect(await applySwapBounds(deps)).toEqual([])
    expect(fs.writes).toHaveLength(3)
  })

  it('zeroes the bound on a node with no swap, as kubelet does for runc pods', async () => {
    const file = 'kubepods.slice/kubepods-pod11_22.slice/memory.swap.max'
    const fs = cgroups({ [file]: 'max\n' })
    const pods = () => [pod('ws', '11-22', 2)]
    await applySwapBounds({ ...fs, pods, meminfo: () => Promise.resolve('MemTotal:       33554432 kB\nSwapTotal:      0 kB\n') })
    expect(fs.writes).toEqual([[file, '0']])
  })
})
