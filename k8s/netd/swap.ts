/**
 * Per-pod swap bounds. kubelet's LimitedSwap gives a container swap in
 * proportion to its memory request, but it writes that bound on container
 * cgroups. A gVisor sandbox runs in the pod's pause scope instead, so it
 * gets no bound and could take a node's whole swap. netd writes kubelet's
 * formula on the pod slice of every pod of its install on this node:
 * memory request / node RAM x swap total, which is 0 on a node without
 * swap. The bounds of a node's pods add up to at most its swap, so no pod
 * can crowd the others out of it (docs/cluster-setup.md "Memory
 * pressure").
 */

/** A pod on netd's node, as the swap bound needs it. */
export interface NodePod {
  name: string
  uid: string
  memoryRequestBytes: number
}

const QUANTITY_SUFFIX: Record<string, number> = {
  '': 1,
  k: 1e3, M: 1e6, G: 1e9, T: 1e12,
  Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4,
}

/** A Kubernetes memory quantity in bytes; 0 when it does not parse. */
export function parseQuantity(quantity: string): number {
  const match = /^(\d+(?:\.\d+)?)([kMGT]i?)?$/.exec(quantity.trim())
  if (!match) return 0
  const scale = QUANTITY_SUFFIX[match[2] ?? '']
  return scale === undefined ? 0 : Math.floor(Number(match[1]) * scale)
}

interface RawContainer { resources?: { requests?: { memory?: string } } }

/**
 * A pod's memory request as kubelet sizes it: the larger of its containers'
 * sum and its largest init container.
 */
export function podMemoryRequestBytes(spec: {
  containers?: RawContainer[]
  initContainers?: RawContainer[]
}): number {
  const request = (c: RawContainer): number => parseQuantity(c.resources?.requests?.memory ?? '0')
  const sum = (spec.containers ?? []).reduce((total, c) => total + request(c), 0)
  return Math.max(sum, ...(spec.initContainers ?? []).map(request))
}

/** MemTotal and SwapTotal, in bytes, from /proc/meminfo. */
export function parseMeminfo(text: string): { memTotal: number; swapTotal: number } {
  const field = (name: string): number => {
    const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm').exec(text)
    return match ? Number(match[1]) * 1024 : 0
  }
  return { memTotal: field('MemTotal'), swapTotal: field('SwapTotal') }
}

/** kubelet's LimitedSwap formula, rounded down to a page as the kernel stores it. */
export function swapBoundBytes(requestBytes: number, memTotal: number, swapTotal: number): number {
  if (memTotal <= 0) return 0
  const bytes = Math.floor((requestBytes / memTotal) * swapTotal)
  return bytes - (bytes % 4096)
}

/**
 * Candidate pod cgroups, relative to the cgroup root: the systemd driver's
 * slices as k3s and EKS lay them out, kind's (kubelet nested under
 * kubelet.slice), and the cgroupfs driver's directories.
 */
export function podCgroupCandidates(uid: string): string[] {
  const unit = uid.replaceAll('-', '_')
  const slices = [
    ['kubepods.slice', 'kubepods'],
    ['kubelet.slice/kubelet-kubepods.slice', 'kubelet-kubepods'],
  ].flatMap(([root, prefix]) => [
    `${root}/${prefix}-pod${unit}.slice`,
    ...['burstable', 'besteffort'].map((qos) => `${root}/${prefix}-${qos}.slice/${prefix}-${qos}-pod${unit}.slice`),
  ])
  const dirs = ['', 'burstable/', 'besteffort/'].map((qos) => `kubepods/${qos}pod${uid}`)
  return [...slices, ...dirs]
}

export interface SwapDeps {
  pods: () => NodePod[]
  meminfo: () => Promise<string>
  /** A cgroup file's contents, or null when the cgroup does not exist. */
  read: (file: string) => Promise<string | null>
  write: (file: string, value: string) => Promise<void>
}

/**
 * One pass: write each pod's bound where it differs from the kernel's.
 * Rereading every pass repairs a value anything else reset. A pod whose
 * cgroup is missing (not started yet, or gone) is skipped. Returns what
 * changed, for the caller to log.
 */
export async function applySwapBounds(deps: SwapDeps): Promise<string[]> {
  const { memTotal, swapTotal } = parseMeminfo(await deps.meminfo())
  const changed: string[] = []
  for (const pod of deps.pods()) {
    for (const dir of podCgroupCandidates(pod.uid)) {
      const file = `${dir}/memory.swap.max`
      const current = await deps.read(file)
      if (current === null) continue
      const bound = String(swapBoundBytes(pod.memoryRequestBytes, memTotal, swapTotal))
      if (current.trim() !== bound) {
        await deps.write(file, bound)
        changed.push(`${pod.name}=${bound}`)
      }
      break
    }
  }
  return changed
}
