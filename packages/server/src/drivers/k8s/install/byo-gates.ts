/**
 * The node gates a bring-your-own cluster is held to, as pure assessments
 * of the node list: `yaac cluster install --byo` refuses on any of them
 * before it applies or builds anything, and `yaac cluster check` repeats
 * them on every run, so a pool that later gains a foreign node is reported
 * instead of failing to pull without explanation
 * (docs/cluster-setup.md "Bring your own cluster").
 *
 * Both halves read the same `kubectl get nodes -o json`; neither decides
 * anything here but what the nodes say.
 */

export interface PlatformNode {
  metadata?: { name?: string; labels?: Record<string, string> }
  status?: {
    nodeInfo?: {
      architecture?: string
      osImage?: string
      containerRuntimeVersion?: string
      kubeletVersion?: string
    }
  }
}

/** Kubernetes' spelling of this machine's architecture (`x64` → `amd64`). */
export function hostNodeArchitecture(arch: string = process.arch): string {
  return arch === 'x64' ? 'amd64' : arch
}

/**
 * Every image yaac ships is built here, by podman, for THIS machine's
 * architecture — so the pool must be one architecture, and that one. A
 * mixed pool and a foreign one are both refusals, naming both sides: there
 * is no cross-build and no emulation (docs/cluster-setup.md "Bring your
 * own cluster").
 */
export function nodeArchitectureProblems(nodes: PlatformNode[], hostArch: string): string[] {
  const byArch = new Map<string, string[]>()
  for (const node of nodes) {
    const arch = node.status?.nodeInfo?.architecture || 'unknown'
    byArch.set(arch, [...(byArch.get(arch) ?? []), node.metadata?.name ?? '?'])
  }
  const archs = [...byArch.keys()].sort()
  if (archs.length > 1) {
    return [
      `the node pool mixes architectures (${archs.map((a) => `${a}: ${byArch.get(a)!.join(', ')}`).join('; ')}). `
      + `yaac builds its images on the machine running install, for that machine's architecture `
      + `(${hostArch}), so a pool must be one architecture, and that one.`,
    ]
  }
  if (archs.length === 1 && archs[0] !== hostArch) {
    return [
      `every node is ${archs[0]}, and this machine is ${hostArch}: the images install builds here `
      + `would not run on them. Run \`yaac cluster install\` from a ${archs[0]} machine.`,
    ]
  }
  return []
}

/**
 * Node OS images whose root filesystem is read-only or declaratively
 * managed, so the gVisor installer cannot drop a runtime into containerd's
 * config — they fail silently otherwise, a node labelled for sandboxes
 * that has no sandbox runtime.
 */
const IMMUTABLE_OS = /bottlerocket|container-optimized os|talos|flatcar/i

/**
 * What the gVisor installer needs from a node, as a flavor table with one
 * row: stock containerd, whose config lives at `/etc/containerd/config.toml`,
 * restarted through the node's systemd, reading registry hosts from
 * `certs.d` (the installer ensures `config_path` itself). Every other
 * shape is refused by name rather than half-installed.
 */
export function nodeOsProblems(nodes: PlatformNode[]): string[] {
  const problems: string[] = []
  for (const node of nodes) {
    const name = node.metadata?.name ?? '?'
    const labels = node.metadata?.labels ?? {}
    const info = node.status?.nodeInfo ?? {}
    const runtime = info.containerRuntimeVersion ?? ''
    const os = info.osImage ?? ''
    const kubelet = info.kubeletVersion ?? ''
    if (labels['eks.amazonaws.com/compute-type'] === 'fargate') {
      problems.push(`${name} is an EKS Fargate node: there is no node to install the gVisor runtime on.`)
    } else if (name.startsWith('gk3-') || labels['cloud.google.com/gke-autopilot'] !== undefined) {
      problems.push(`${name} is a GKE Autopilot node, which admits no privileged node installer.`)
    } else if (/\+k3s/.test(kubelet) || /\+rke2/.test(kubelet)) {
      problems.push(`${name} runs ${/\+rke2/.test(kubelet) ? 'RKE2' : 'k3s'} (kubelet ${kubelet}), whose `
        + 'embedded containerd keeps its config in a template the gVisor installer does not write yet.')
    } else if (!runtime.startsWith('containerd://')) {
      problems.push(`${name} runs ${runtime || 'an unreported runtime'}, not containerd — the gVisor `
        + 'installer registers its runtime in containerd\'s config.')
    } else if (IMMUTABLE_OS.test(os)) {
      problems.push(`${name} runs ${os}, an immutable OS: the gVisor installer cannot change its `
        + 'containerd config. Use a node pool on a mutable OS image.')
    }
  }
  return problems
}
