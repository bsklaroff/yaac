import {
  type CiliumTproxyRule,
  deleteCiliumTproxyRule,
  findCiliumAgentPod,
  listCiliumTproxyRules,
  tproxyRuleDeleteArgs,
} from '#platform/k8s/cilium-tproxy'
import { kubectlGetJson } from '#platform/k8s/kubectl'
import { serverLog } from '#log'

/**
 * Background-loop tick step: garbage-collect the TPROXY rules Cilium leaks
 * when a CiliumEnvoyConfig is deleted (it never removes the per-listener
 * rules from CILIUM_PRE_mangle). Every vcluster teardown leaks its
 * inner-redirect CEC's six rules this way, so they accumulate without bound
 * under session churn — the same CEC-churn residue that has wedged egress
 * before (docs/nested-containers.md).
 *
 * This lives in the reconcile loop, NOT the vcluster teardown path, because
 * teardown is the wrong moment: namespace deletion runs `--wait=false`, and
 * the rules only become stale once the CEC actually terminates, seconds
 * later. The loop also covers every other teardown route (orphan GC, e2e
 * namespace sweeps, out-of-band deletes) and other installs' leftovers.
 *
 * Staleness is purely existence-driven: a rule is stale iff the config named
 * in its comment (`<ns>/<cec>/<listener>`, ns empty for a cluster-scoped
 * CCEC) no longer exists. No bound-port heuristics — an existing config's
 * rules are never touched, so a listener mid-(re)bind can't be broken.
 *
 * Two-pass confirmation: a rule is deleted only when it was already stale on
 * the PREVIOUS sweep. A CEC deleted and re-created under the same name (the
 * server re-projecting an inner redirect after proxy churn) can leave a
 * freshly-programmed rule that briefly looks stale; by the next sweep its
 * config exists again and the candidate is dropped. Only rules whose config
 * stayed gone for a full sweep interval are removed.
 *
 * Scoped to yaac-owned configs (`yaac-`-prefixed CEC/CCEC names) across ALL
 * installs — existence is a cluster-wide truth, so the ambient server safely
 * sweeps residue from destroyed e2e installs too. Cilium's own proxies (the
 * DNS proxy) don't parse as CEC refs and are never candidates.
 */

/** Min interval between sweeps — hygiene work, not per-tick reconciliation. */
export const TPROXY_GC_INTERVAL_MS = 5 * 60 * 1000

let lastSweepMs = 0
/** Delete-spec keys of rules seen stale on the previous sweep. */
let pendingStale = new Set<string>()

/** Reset the throttle + two-pass state (tests only). */
export function resetTproxyGcState(): void {
  lastSweepMs = 0
  pendingStale = new Set()
}

interface RawObjectList {
  items: Array<{ metadata: { name: string; namespace?: string } }>
}

/**
 * `<ns>/<name>` keys of every live CiliumEnvoyConfig, plus `/<name>` for
 * cluster-scoped CCECs — matching the namespace-slash-name prefix of the
 * proxy names in Cilium's rule comments. Throws on listing failure so a
 * flaky API read can never make everything look stale.
 */
async function listLiveEnvoyConfigKeys(): Promise<Set<string>> {
  const [cecs, ccecs] = await Promise.all([
    kubectlGetJson<RawObjectList>(['get', 'ciliumenvoyconfig', '-A']),
    kubectlGetJson<RawObjectList>(['get', 'ciliumclusterwideenvoyconfig']),
  ])
  const keys = new Set<string>()
  for (const item of cecs?.items ?? []) {
    keys.add(`${item.metadata.namespace ?? ''}/${item.metadata.name}`)
  }
  for (const item of ccecs?.items ?? []) {
    keys.add(`/${item.metadata.name}`)
  }
  return keys
}

function isYaacCecRule(rule: CiliumTproxyRule): boolean {
  return rule.ref !== undefined && rule.ref.cecName.startsWith('yaac-')
}

export async function reconcileStaleTproxyRules(nowMs: number = Date.now()): Promise<void> {
  if (nowMs - lastSweepMs < TPROXY_GC_INTERVAL_MS) return
  lastSweepMs = nowMs

  const agentPod = await findCiliumAgentPod()
  if (!agentPod) return // nested server (vcluster API) or agent mid-restart

  // Rules BEFORE live configs: a config deleted in between reads as live for
  // one sweep (caught next time); a config created in between reads as live.
  // Both races bias toward keeping the rule.
  const rules = await listCiliumTproxyRules(agentPod)
  const candidates = rules.filter(isYaacCecRule)
  if (candidates.length === 0) {
    pendingStale = new Set()
    return
  }
  const liveKeys = await listLiveEnvoyConfigKeys()

  const stale = candidates.filter(
    (r) => !liveKeys.has(`${r.ref!.namespace}/${r.ref!.cecName}`),
  )
  const staleKeys = new Set<string>()
  let deleted = 0
  const deletedNames = new Set<string>()
  for (const rule of stale) {
    const key = tproxyRuleDeleteArgs(rule).join(' ')
    if (!pendingStale.has(key)) {
      staleKeys.add(key) // first sighting — confirm on the next sweep
      continue
    }
    try {
      await deleteCiliumTproxyRule(agentPod, rule)
      deleted++
      deletedNames.add(rule.name)
    } catch (err) {
      // Exact-spec delete lost a race (agent restart, another install's GC)
      // or a transient exec failure — keep it a candidate and retry next sweep.
      staleKeys.add(key)
      serverLog(`[tproxy-gc] delete failed for ${rule.name} (${rule.protocol}): ${String(err)}`)
    }
  }
  pendingStale = staleKeys

  if (deleted > 0) {
    serverLog(
      `[tproxy-gc] deleted ${deleted} stale cilium TPROXY rule(s): `
      + [...deletedNames].sort().join(', '),
    )
  }
}
