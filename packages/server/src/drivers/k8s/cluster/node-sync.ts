import { applyObject, listObjects } from '#drivers/k8s/substrate'
import type { ProjectRef } from '#drivers/contract'
import { serverLog } from '#log'
import { nodeIpBlocks } from './cluster-cidrs'
import { applyMainRegistryIngress, writeMainRegistryHosts } from './main-registry'
import { syncNpmCacheNodes } from './npm-cache'
import {
  buildProxyEgressNpManifest,
  buildProxyIngressNpManifest,
  buildServerIngressNpManifest,
  buildWorkspaceEgressNpManifest,
} from './policy-manifests'
import { applyProjectRegistryIngress, writeProjectRegistryHosts } from './project-registry'

/**
 * Keeps per-node state current as nodes join, as they do when an autoscaler
 * adds one (docs/cluster-setup.md "Bring your own cluster"). Install and the
 * registries' ensures cover only the nodes that exist when they run, so a
 * later node would lack two things:
 *  - its address in every NetworkPolicy that admits nodes (kubelet probes,
 *    containerd pulls, netd's Envoy). These are re-applied whenever the
 *    address set changes, which takes no pod.
 *  - its containerd hosts.toml for the main and project registries, without
 *    which it cannot pull any yaac image (the gVisor installer's included).
 *    These are written once per node, keyed by name and uid so a replacement
 *    node on a reused address still gets them, and only once the node is
 *    Ready. The writes run in the background, so a node that cannot run a
 *    pod never holds up the reconcile pass; it is retried on later passes.
 */

/** The node address set the policies last rendered. */
let renderedAddresses: string | null = null
/** Nodes (`name/uid`) whose hosts.toml files are written. */
const hostsWritten = new Set<string>()
/** The background hosts.toml run, if one is in flight. */
let hostsRun: Promise<void> | null = null

interface RawNode {
  metadata?: { name?: string; uid?: string }
  status?: { conditions?: Array<{ type?: string; status?: string }> }
}

/**
 * Re-render the node-address policies if the address set changed, and
 * start writing hosts.toml to Ready nodes that do not have it yet.
 */
export async function reconcileNodeSet(projects: ProjectRef[]): Promise<void> {
  const nodeCidrs = await nodeIpBlocks({ fresh: true })
  const addresses = nodeCidrs.join(',')
  if (addresses !== renderedAddresses) {
    for (const manifest of [
      buildServerIngressNpManifest(nodeCidrs),
      buildWorkspaceEgressNpManifest(nodeCidrs),
      buildProxyIngressNpManifest(nodeCidrs),
      buildProxyEgressNpManifest(nodeCidrs),
    ]) await applyObject(manifest)
    await syncNpmCacheNodes(nodeCidrs)
    await applyMainRegistryIngress(nodeCidrs)
    for (const project of projects) await applyProjectRegistryIngress(project, nodeCidrs)
    renderedAddresses = addresses
  }

  if (hostsRun) return
  const pending = (await listObjects<RawNode>('v1', 'Node'))
    .filter((n) => n.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'))
    .map((n) => ({ name: n.metadata?.name ?? '', key: `${n.metadata?.name ?? ''}/${n.metadata?.uid ?? ''}` }))
    .filter((n) => n.name && !hostsWritten.has(n.key))
  if (pending.length === 0) return
  hostsRun = writeHostsTo(pending, projects).finally(() => { hostsRun = null })
}

/** Write every registry's hosts.toml to each node in turn; a failed node is retried on a later pass. */
async function writeHostsTo(nodes: Array<{ name: string; key: string }>, projects: ProjectRef[]): Promise<void> {
  for (const node of nodes) {
    const only = new Set([node.name])
    try {
      await writeMainRegistryHosts(only)
      for (const project of projects) await writeProjectRegistryHosts(project, only)
      hostsWritten.add(node.key)
    } catch (err) {
      serverLog(`[node-sync] registry hosts.toml on ${node.name} failed (retried next pass): ${String(err)}`)
    }
  }
}

/** Settles when the background hosts.toml run does (tests). */
export function _nodeSyncSettledForTests(): Promise<void> {
  return hostsRun ?? Promise.resolve()
}

/** Forget every sync (tests). */
export function _resetNodeSyncForTests(): void {
  renderedAddresses = null
  hostsWritten.clear()
  hostsRun = null
}
