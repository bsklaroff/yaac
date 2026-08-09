/**
 * Taint/toleration matching, as kubernetes itself defines it.
 *
 * "Can this pod land on that node?" is a per-taint question, and answering
 * it with "the node carries no taint at all" is only right for a pod that
 * tolerates nothing. That used to describe every yaac pod bar netd, so the
 * blanket answer was indistinguishable from the real one — until a
 * dedicated worktree pool, which is built the conventional way: taint the
 * pool so nothing else drifts onto it, and tolerate that taint from the
 * workload that belongs there. Under the blanket rule such a pool reads as
 * *zero* nodes a worktree can use, and the only repair it can suggest is
 * removing the taint — dismantling the isolation the pool exists for.
 *
 * Where a worktree pod's tolerations come from is the other half: nothing
 * stamps them per-pod. `RuntimeClass.scheduling.tolerations` is merged by
 * the RuntimeClass admission controller into every pod naming the class, so
 * declaring the pool's toleration once on `gvisor` reaches worktree pods,
 * builder pods, vcluster-synced pods and cluster check's own pinned probes
 * alike (those bypass the scheduler, but kubelet still admits them, and a
 * `NoExecute` taint evicts what it does not tolerate).
 *
 * The rules below are `v1helper.TolerationsTolerateTaint`'s, and are worth
 * spelling out because two of them are easy to get subtly wrong: an empty
 * toleration `effect` matches EVERY effect (not "no effect"), and an empty
 * `operator` means `Equal` (not `Exists`).
 *
 * One rule is deliberately NOT modelled: `tolerationSeconds`, which bounds
 * how long a `NoExecute` taint is tolerated before the taint manager evicts
 * the pod. This answers the scheduler's question — may the pod land here —
 * and a time-bounded toleration lands the pod, so it counts as tolerated.
 * That makes a time-bounded pool toleration a configuration yaac cannot warn
 * about: every gate passes, and worktrees are evicted when the clock runs
 * out. Declare a pool's toleration without `tolerationSeconds`; there is no
 * reason to bound it, since the taint is the pool's identity rather than a
 * condition expected to clear.
 */

/** A node taint as the apiserver serves it (`spec.taints[]`). */
export interface NodeTaint {
  key?: string
  value?: string
  effect?: string
}

/** A pod toleration as a manifest declares it (`spec.tolerations[]`). */
export interface PodToleration {
  key?: string
  operator?: string
  value?: string
  effect?: string
}

/**
 * Effects that keep a pod off a node (or throw it off). `PreferNoSchedule`
 * is deliberately absent: it is a scheduler preference, so a pod that does
 * not tolerate it still lands when nothing better exists, and treating it
 * as blocking would report a perfectly usable node as unusable.
 */
const BLOCKING_EFFECTS = new Set(['NoSchedule', 'NoExecute'])

function tolerates(toleration: PodToleration, taint: NodeTaint): boolean {
  // Empty effect is the wildcard: this toleration covers every effect of
  // the key it names.
  if (toleration.effect && toleration.effect !== taint.effect) return false
  // Only these two operators exist; empty means Equal. Unknown ones tolerate
  // NOTHING, which is upstream's verdict and the safe direction — falling
  // through to a value comparison would let a typo'd operator quietly grant
  // a node. The apiserver rejects them anyway, so this is a floor, not a
  // path anything reaches.
  if (toleration.operator && toleration.operator !== 'Equal'
    && toleration.operator !== 'Exists') {
    return false
  }
  // Empty key is the wildcard, and is only legal with Exists — which is
  // what netd and the gVisor installer's `{operator: Exists}` says: tolerate
  // everything, this is node infrastructure.
  if (!toleration.key) return toleration.operator === 'Exists'
  if (toleration.key !== taint.key) return false
  if (toleration.operator === 'Exists') return true
  // Equal compares values — a valueless taint (`key:NoSchedule`) matches a
  // toleration with no value.
  return (toleration.value ?? '') === (taint.value ?? '')
}

/**
 * The taints on a node that would actually keep the pod off it: the
 * scheduling-blocking ones no toleration matches. Empty means the pod can
 * land there as far as taints are concerned (cordoning — `spec.unschedulable`
 * — is a separate question, and one the caller asks separately because it
 * has its own repair).
 */
export function untoleratedTaints(
  taints: NodeTaint[] | undefined,
  tolerations: PodToleration[] | undefined,
): NodeTaint[] {
  const tols = tolerations ?? []
  return (taints ?? [])
    .filter((t) => BLOCKING_EFFECTS.has(t.effect ?? ''))
    .filter((t) => !tols.some((tol) => tolerates(tol, t)))
}

/** A taint in kubectl's own `key=value:Effect` spelling, for check output. */
export function formatTaint(taint: NodeTaint): string {
  const key = taint.key ?? ''
  const value = taint.value ? `=${taint.value}` : ''
  return `${key}${value}:${taint.effect ?? ''}`
}
