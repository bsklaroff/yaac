/**
 * The redirect rules netd programs in the node root netns.
 * See docs/session-egress.md for the whole datapath.
 *
 * Shape, and why it is this shape:
 *
 * - **nat, not mangle/TPROXY.** Calico's Felix re-inserts its own jump at
 *   the top of every base chain it manages on each reprogram, so any yaac
 *   rule that has to run *before* `cali-*` is guaranteed to be demoted the
 *   next time Felix resyncs. Measured: after a `calico-node` restart, a
 *   mangle-PREROUTING TPROXY divert and a filter-INPUT accept both landed
 *   below the Calico jumps and every session lost egress. `nat`
 *   PREROUTING is uncontended — Calico's `cali-PREROUTING` there is an
 *   empty floating-IP DNAT chain that terminates nothing — so netd
 *   APPENDS and never competes for position. (See docs/plans spike
 *   results.) Because NAT applies only to a flow's first packet and
 *   conntrack replays it, this also removes the whole TPROXY plumbing:
 *   no fwmark, no `-m socket` divert, no policy route, no `accept_local`,
 *   no `src_valid_mark` node fixup.
 *
 * - **One owned chain.** All per-pod rules live in `YAAC_REDIRECT`, jumped
 *   from nat PREROUTING exactly once. Per-pod churn never touches a base
 *   chain, and GC is a flush-and-refill rather than a diff — netd renders
 *   the whole desired chain each pass and only writes when it changed, so
 *   a rule deleted out from under it heals on the next reconcile.
 *
 * - **Interface-keyed.** Each rule matches `-i cali<veth>`, the one
 *   identity a workload cannot forge. Source IP is deliberately NOT the
 *   key.
 *
 * - **World-scoped.** The chain opens with a `-d <podCIDR> -j RETURN` per
 *   cluster pod CIDR, so in-cluster pod-to-pod traffic leaves the chain
 *   before any DNAT rule can see it; ClusterIP traffic is already excluded
 *   because kube-proxy's KUBE-SERVICES DNAT runs earlier and terminates.
 *   Together these scope the redirect to world traffic only. The
 *   exclusions lead the chain rather than riding each DNAT rule as
 *   `! -d`, because iptables allows only ONE destination per rule and a
 *   cluster can allocate pods from several CIDRs.
 *
 * Pure rendering here — the applier executes what these produce.
 */

import { createHash } from 'node:crypto'
import type { ListenerTrio } from 'yaac-netd/ports'
import type { PodTarget } from 'yaac-netd/targets'

/**
 * netd's own nat chain, scoped to the install it serves.
 *
 * Per-install, NOT shared: several yaac installs coexist on one node (the
 * real `yaac` one plus an ephemeral `yaac-test-<run-id>` per e2e run),
 * each running its own netd. They render their chain by flush-and-refill,
 * so a shared chain would have each netd continually delete the other's
 * rules — every install's egress would flap. Each gets its own chain and
 * its own appended PREROUTING jump; both jumps run, and neither
 * terminates unless one of its own rules matches.
 *
 * Hashed rather than spelled out because iptables caps a chain name at 28
 * characters and an install namespace can be arbitrarily long. netd logs
 * the mapping at startup so triage can find its chain.
 */
export function redirectChainName(installNamespace: string): string {
  const hash = createHash('sha256').update(installNamespace).digest('hex').slice(0, 8)
  return `YAAC_RDR_${hash}`
}

/**
 * xt_comment's match struct is a fixed `char[256]` that must be
 * NUL-terminated, so iptables rejects any comment of 256 characters or
 * more — and `iptables-restore` rejects the WHOLE document when one rule
 * is bad, which would stall every redirect update on the node. A synced
 * pod's name can reach that on its own (63-byte namespace + a 253-byte
 * name), so the identity is truncated rather than trusted. The head is
 * kept: it carries the namespace, which is what triage greps for.
 */
const MAX_COMMENT_LEN = 255

function ruleComment(namespace: string, name: string): string {
  return `yaac:${namespace}/${name}`.slice(0, MAX_COMMENT_LEN)
}

export interface RuleRenderInput {
  selected: PodTarget[]
  /** podIP → host veth, from the Calico per-workload routes. */
  vethByPodIp: Map<string, string>
  /** This install's listener trio — one for every pod (see ports.ts). */
  trio: ListenerTrio
  /** Address the DNAT aims at — this node, where Envoy listens. */
  nodeIp: string
  /** Every cluster pod CIDR, excluded so pod-to-pod is never redirected. */
  podCidrs: string[]
  /** Sentinel address git's ssh ProxyCommand dials (never a real host). */
  sshSentinelIp: string
  /** Port dialed on the sentinel. */
  sshSentinelPort: number
}

/**
 * The rules of the redirect chain, in order, as iptables argv fragments
 * (without the `-A <chain>` prefix, which the applier adds). Deterministic
 * given the same inputs — that is what lets the applier compare against
 * the live chain and skip identical passes.
 *
 * Every pod's traffic goes to the SAME trio; which egress target it
 * reaches is decided by Envoy from the source pod IP. So this renders no
 * per-target port lookup, and a pod's target changing does not rewrite its
 * rules.
 */
export function renderRedirectRules(input: RuleRenderInput): string[][] {
  const rules: string[][] = []
  // Leading exclusions: anything bound for a pod leaves the chain here.
  for (const cidr of input.podCidrs) {
    rules.push(['-d', cidr, '-j', 'RETURN'])
  }
  for (const { pod } of input.selected) {
    const iface = input.vethByPodIp.get(pod.podIp)
    // No veth yet (Calico has not finished programming the workload, or
    // the pod is on another node) — emit nothing. The pod then has no
    // redirect and its NetworkPolicy denies world egress, which is the
    // fail-closed direction.
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
    // The ssh tunnel sentinel is a fixed unroutable address outside every
    // pod CIDR, so the leading exclusions never take it out of the chain.
    rules.push([
      ...base(['-d', input.sshSentinelIp, '--dport', String(input.sshSentinelPort)]),
      '-j', 'DNAT', '--to-destination', `${input.nodeIp}:${input.trio.tunnel}`,
    ])
  }
  return rules
}

/**
 * The `iptables-restore --noflush` document that makes this install's
 * chain exactly the rendered rule set.
 *
 * restore rather than per-rule `-A`/`-D` diffing for two reasons: it is
 * atomic (the whole chain swaps under one kernel transaction, so no pod is
 * ever briefly unredirected mid-update), and it sidesteps iptables' argv
 * normalization — the kernel reports rules back with matches reordered and
 * `-m tcp` inserted, so a textual diff against `-S` output would report
 * spurious drift forever. Declaring the chain and flushing it inside the
 * same document makes this idempotent and self-healing: a rule deleted out
 * from under netd is restored on the next pass, and `--noflush` leaves
 * every other chain (Calico's, kube-proxy's) untouched.
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
