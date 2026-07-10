import { kubectlGetJson, kubectlWithRetry } from '@/lib/k8s/kubectl'

/**
 * Helpers for reading and deleting Cilium's per-listener TPROXY rules in the
 * agent's `CILIUM_PRE_mangle` chain.
 *
 * Cilium programs one iptables TPROXY rule pair (tcp + udp, same proxy port)
 * per Envoy listener it hosts for a CiliumEnvoyConfig, with the owning config
 * named in the rule comment:
 *
 *   -A CILIUM_PRE_mangle -p tcp -m mark --mark 0x8470200 -m comment
 *     --comment "cilium: TPROXY to host <ns>/<cec>/<listener> proxy"
 *     -j TPROXY --on-port 18184 --on-ip 127.0.0.1 --tproxy-mark 0x200/0xffffffff
 *
 * (`<ns>` is empty for a cluster-scoped CiliumClusterwideEnvoyConfig, giving a
 * leading `/`; non-CEC proxies like `cilium-dns-egress` have no slashes.)
 *
 * Cilium does NOT garbage-collect these rules when the CEC goes away — every
 * destroyed vcluster's inner-redirect CEC leaves its six rules behind, and
 * they accumulate without bound under session churn (observed: ~30 stale
 * unbound rules on a long-lived cluster). The server sweeps them via
 * `reconcileStaleTproxyRules` (src/lib/session/tproxy-gc-reconcile.ts).
 */

export const CILIUM_TPROXY_CHAIN = 'CILIUM_PRE_mangle'

/** One parsed TPROXY rule from `iptables -t mangle -S CILIUM_PRE_mangle`. */
export interface CiliumTproxyRule {
  protocol: 'tcp' | 'udp'
  /** The BPF fwmark match (encodes the proxy port), e.g. `0x8470200`. */
  mark: string
  /** The proxy name from the comment, e.g. `<ns>/<cec>/<listener>`. */
  name: string
  /**
   * Slash-split name parts when the proxy is CEC-backed (exactly
   * `<ns>/<cec>/<listener>`); undefined for other proxies (DNS). An empty
   * `namespace` means the config is a cluster-scoped CCEC.
   */
  ref?: { namespace: string; cecName: string; listener: string }
  onPort: string
  onIp: string
  tproxyMark: string
}

/**
 * Strict shape of one TPROXY rule line. Anything that doesn't match exactly
 * (different matchers, extra flags, unexpected comment) is skipped rather
 * than guessed at — the GC must never delete a rule it can't fully rebuild.
 */
const TPROXY_RULE_RE = new RegExp(
  `^-A ${CILIUM_TPROXY_CHAIN} -p (tcp|udp) -m mark --mark (0x[0-9a-fA-F]+)`
  + ' -m comment --comment "cilium: TPROXY to host ([^"]+) proxy"'
  + ' -j TPROXY --on-port (\\d+) --on-ip ([0-9a-fA-F.:]+)'
  + ' --tproxy-mark (0x[0-9a-fA-F]+(?:/0x[0-9a-fA-F]+)?)$',
)

/**
 * Parse `iptables -t mangle -S CILIUM_PRE_mangle` output into the TPROXY
 * rules. Non-TPROXY lines (chain header, the socket MARK rule) and any
 * TPROXY line that doesn't match the strict shape are ignored.
 */
export function parseCiliumTproxyRules(rulesOutput: string): CiliumTproxyRule[] {
  const rules: CiliumTproxyRule[] = []
  for (const line of rulesOutput.split('\n')) {
    const m = TPROXY_RULE_RE.exec(line.trim())
    if (!m) continue
    const [, protocol, mark, name, onPort, onIp, tproxyMark] = m
    const parts = name.split('/')
    rules.push({
      protocol: protocol as 'tcp' | 'udp',
      mark,
      name,
      ...(parts.length === 3
        ? { ref: { namespace: parts[0], cecName: parts[1], listener: parts[2] } }
        : {}),
      onPort,
      onIp,
      tproxyMark,
    })
  }
  return rules
}

/**
 * Rebuild the exact iptables argv that deletes one parsed rule. Rebuilt from
 * the parsed fields (not the raw `-S` line) so every argument — including the
 * comment — travels as its own argv element through `kubectl exec`, with no
 * shell in the path to re-interpret quoting.
 */
export function tproxyRuleDeleteArgs(rule: CiliumTproxyRule): string[] {
  return [
    '-t', 'mangle', '-D', CILIUM_TPROXY_CHAIN,
    '-p', rule.protocol,
    '-m', 'mark', '--mark', rule.mark,
    '-m', 'comment', '--comment', `cilium: TPROXY to host ${rule.name} proxy`,
    '-j', 'TPROXY',
    '--on-port', rule.onPort,
    '--on-ip', rule.onIp,
    '--tproxy-mark', rule.tproxyMark,
  ]
}

interface RawPodList {
  items: Array<{ metadata: { name: string }; status?: { phase?: string } }>
}

/**
 * Name of the running cilium-agent pod, or null when there is none — a
 * vcluster's API (nested server), a cluster mid-setup, or an agent restart.
 * Single-node cluster: the first Running agent is THE agent.
 */
export async function findCiliumAgentPod(): Promise<string | null> {
  const list = await kubectlGetJson<RawPodList>([
    'get', 'pods', '-n', 'kube-system', '-l', 'k8s-app=cilium',
  ])
  for (const pod of list?.items ?? []) {
    if (pod.status?.phase === 'Running') return pod.metadata.name
  }
  return null
}

function ciliumExecArgs(agentPod: string, command: string[]): string[] {
  return ['exec', '-n', 'kube-system', agentPod, '-c', 'cilium-agent', '--', ...command]
}

/**
 * The agent's current TPROXY rules. Returns [] when the chain doesn't exist
 * (cilium not managing this node's netfilter) rather than throwing.
 */
export async function listCiliumTproxyRules(agentPod: string): Promise<CiliumTproxyRule[]> {
  try {
    const { stdout } = await kubectlWithRetry(
      ciliumExecArgs(agentPod, ['iptables', '-t', 'mangle', '-S', CILIUM_TPROXY_CHAIN]),
      { timeout: 30_000 },
    )
    return parseCiliumTproxyRules(stdout)
  } catch (err) {
    const stderr = (err as { stderr?: string })?.stderr ?? ''
    if (stderr.includes('No chain/target/match by that name')) return []
    throw err
  }
}

/**
 * Delete one rule in the agent's netns. Exact-spec delete: if the rule is
 * already gone (cilium restarted, another install's GC won) iptables exits
 * non-zero with "Bad rule" — surfaced to the caller, which tolerates it.
 */
export async function deleteCiliumTproxyRule(
  agentPod: string,
  rule: CiliumTproxyRule,
): Promise<void> {
  await kubectlWithRetry(
    ciliumExecArgs(agentPod, ['iptables', ...tproxyRuleDeleteArgs(rule)]),
    { timeout: 30_000, maxAttempts: 2 },
  )
}
