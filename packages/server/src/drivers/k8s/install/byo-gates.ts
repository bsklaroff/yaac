/**
 * Node requirements for a bring-your-own cluster, checked against
 * `kubectl get nodes -o json`. `yaac cluster install --byo` refuses before
 * doing anything if one fails, and `yaac cluster check` repeats them so a
 * node added later is reported (docs/cluster-setup.md "Bring your own
 * cluster").
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
 * yaac builds its images with podman for this machine's architecture, with
 * no cross-build, so every node must share that architecture.
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
 * Node OS images with a read-only or declaratively managed root
 * filesystem, where the gVisor installer cannot edit containerd's config.
 */
const IMMUTABLE_OS = /bottlerocket|container-optimized os|talos|flatcar/i

/**
 * Nodes the gVisor installer cannot handle. It supports only stock
 * containerd with its config at `/etc/containerd/config.toml`, restarted
 * via the node's systemd. Anything else is refused by name.
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
