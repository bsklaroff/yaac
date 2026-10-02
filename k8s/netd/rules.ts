/**
 * Renders the nat redirect rules netd programs in the node root netns;
 * iptables.ts applies them. See docs/workspace-egress.md ("Why DNAT and
 * not TPROXY") for the design.
 *
 * - nat PREROUTING, appended: Felix keeps its own jumps first in the
 *   chains it manages, and nat PREROUTING is the one where running after
 *   Calico is harmless.
 * - One chain per install (redirectChainName), jumped to once from
 *   PREROUTING and fully rewritten each time it changes.
 * - Rules match the arrival interface (`-i <veth>`), never the source IP,
 *   which a workload could forge.
 * - The chain starts with a `-d <podCIDR> -j RETURN` per pod CIDR so
 *   pod-to-pod traffic is never redirected. (iptables allows one `-d` per
 *   rule, so these can't be folded into each DNAT rule.) ClusterIP traffic
 *   is already DNAT'd by kube-proxy before reaching this chain.
 */

import { createHash } from 'node:crypto'
import type { ListenerTrio } from 'yaac-netd/ports'
import type { NetdPod } from 'yaac-netd/k8s-watch'

/**
 * The install's own nat chain name. Each install (e.g. `yaac` and an e2e
 * `yaac-test-<run-id>`) needs its own chain, since each netd flushes and
 * refills its chain. The namespace is hashed because iptables limits chain
 * names to 28 characters; netd logs the name at startup.
 */
export function redirectChainName(installNamespace: string): string {
  const hash = createHash('sha256').update(installNamespace).digest('hex').slice(0, 8)
  return `YAAC_RDR_${hash}`
}

/**
 * iptables rejects comments of 256+ characters, and one bad rule makes
 * `iptables-restore` reject the whole document. A namespace plus pod name
 * can exceed that, so comments are truncated.
 */
const MAX_COMMENT_LEN = 255

function ruleComment(namespace: string, name: string): string {
  return `yaac:${namespace}/${name}`.slice(0, MAX_COMMENT_LEN)
}

export interface RuleRenderInput {
  pods: NetdPod[]
  /** podIP → host veth, from the Calico per-workload routes. */
  vethByPodIp: Map<string, string>
  /** This install's listener trio, shared by every pod (see ports.ts). */
  trio: ListenerTrio
  /** Address the DNAT aims at — this node, where Envoy listens. */
  nodeIp: string
  /** Every cluster pod CIDR, excluded so pod-to-pod is never redirected. */
  podCidrs: string[]
  /** Sentinel address git's ssh ProxyCommand dials (never a real host).
   *  Must sit outside every pod CIDR, or the pod-CIDR RETURN rules skip it
   *  and git-over-SSH silently stops working. */
  sshSentinelIp: string
  /** Port dialed on the sentinel. */
  sshSentinelPort: number
}

/**
 * The redirect chain's rules, in order, as iptables argv fragments without
 * the `-A <chain>` prefix. Output is deterministic so unchanged passes can
 * be skipped. Every pod goes to the same trio.
 */
export function renderRedirectRules(input: RuleRenderInput): string[][] {
  const rules: string[][] = []
  // Leading exclusions: anything bound for a pod leaves the chain here.
  for (const cidr of input.podCidrs) {
    rules.push(['-d', cidr, '-j', 'RETURN'])
  }
  for (const pod of input.pods) {
    const iface = input.vethByPodIp.get(pod.podIp)
    // No veth yet, or the pod is on another node. Without a rule its
    // egress is denied by NetworkPolicy.
    if (!iface) continue
    const comment = ruleComment(pod.namespace, pod.name)
    const base = (extra: string[]): string[] => [
      '-i', iface, '-p', 'tcp', ...extra,
      '-m', 'comment', '--comment', comment,
    ]
    rules.push([
      ...base(['--dport', '443']),
      '-j', 'DNAT', '--to-destination', `${input.nodeIp}:${input.trio.https}`,
    ])
    rules.push([
      ...base(['--dport', '80']),
      '-j', 'DNAT', '--to-destination', `${input.nodeIp}:${input.trio.http}`,
    ])
    rules.push([
      ...base(['-d', input.sshSentinelIp, '--dport', String(input.sshSentinelPort)]),
      '-j', 'DNAT', '--to-destination', `${input.nodeIp}:${input.trio.tunnel}`,
    ])
  }
  return rules
}

/**
 * The `iptables-restore --noflush` document that replaces this install's
 * chain with the rendered rules. A restore is atomic and avoids diffing
 * against iptables' normalized `-S` output; `--noflush` leaves other
 * chains alone.
 */
export function renderNatRestore(chain: string, rules: string[][]): string {
  const quote = (token: string): string => (/[\s"]/.test(token) ? `"${token}"` : token)
  return [
    '*nat',
    `:${chain} - [0:0]`,
    `-F ${chain}`,
    ...rules.map((rule) => `-A ${chain} ${rule.map(quote).join(' ')}`),
    'COMMIT',
    '',
  ].join('\n')
}
