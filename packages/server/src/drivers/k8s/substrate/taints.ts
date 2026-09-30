/**
 * Taint/toleration matching, following kubernetes'
 * `v1helper.TolerationsTolerateTaint`.
 *
 * Asking "does the node have no taints?" is wrong for a dedicated workspace
 * pool, which is tainted so other pods stay off and tolerated by workspace
 * pods. Each taint must be checked against the pod's tolerations.
 *
 * Workspace pods get their tolerations from `RuntimeClass.scheduling
 * .tolerations`: the RuntimeClass admission controller merges them into
 * every pod naming the `gvisor` class, so declaring the pool's toleration
 * there covers workspace pods, builder pods and cluster check's pinned
 * probes. (Pinned pods bypass the scheduler, but kubelet still admits them
 * and a `NoExecute` taint evicts what it does not tolerate.)
 *
 * Two easy-to-miss rules: an empty toleration `effect` matches every
 * effect, and an empty `operator` means `Equal`.
 *
 * `tolerationSeconds` is not modelled. A time-bounded toleration still lets
 * the pod land, so it counts as tolerated here, but workspaces are evicted
 * when it expires. Declare a pool's toleration without `tolerationSeconds`.
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
 * Effects that keep a pod off a node (or evict it). `PreferNoSchedule` is
 * absent: it is only a scheduler preference, and a pod that does not
 * tolerate it still lands when nothing better exists.
 */
const BLOCKING_EFFECTS = new Set(['NoSchedule', 'NoExecute'])

function tolerates(toleration: PodToleration, taint: NodeTaint): boolean {
  // An empty effect matches every effect.
  if (toleration.effect && toleration.effect !== taint.effect) return false
  // An unknown operator tolerates nothing, as upstream does. (The
  // apiserver rejects them, so this is only a safety floor.)
  if (toleration.operator && toleration.operator !== 'Equal'
    && toleration.operator !== 'Exists') {
    return false
  }
  // An empty key matches every taint and is only legal with Exists (netd
  // and the gVisor installer tolerate everything this way).
  if (!toleration.key) return toleration.operator === 'Exists'
  if (toleration.key !== taint.key) return false
  if (toleration.operator === 'Exists') return true
  // A valueless taint (`key:NoSchedule`) matches a toleration with no value.
  return (toleration.value ?? '') === (taint.value ?? '')
}

/**
 * The blocking taints on a node that none of the pod's tolerations match.
 * Empty means taints do not keep the pod off. Cordoning
 * (`spec.unschedulable`) is not considered; callers check it separately.
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
