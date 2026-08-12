import { describe, it, expect } from 'vitest'
import { formatTaint, untoleratedTaints } from '#runtime/k8s/substrate'
import type { NodeTaint, PodToleration } from '#runtime/k8s/substrate'

/**
 * The taints a real cluster puts on nodes yaac has to reason about — the
 * kubeadm control-plane taint, the two node-pressure taints kubelet adds and
 * removes on its own, the `uninitialized` taint a cloud provider's node
 * carries while it joins, and a dedicated sessions pool's own taint.
 */
const CONTROL_PLANE: NodeTaint = {
  key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule',
}
const MEMORY_PRESSURE: NodeTaint = {
  key: 'node.kubernetes.io/memory-pressure', effect: 'NoSchedule',
}
const DISK_PRESSURE: NodeTaint = {
  key: 'node.kubernetes.io/disk-pressure', effect: 'NoSchedule',
}
const UNINITIALIZED: NodeTaint = {
  key: 'node.cloudprovider.kubernetes.io/uninitialized', value: 'true', effect: 'NoSchedule',
}
const SESSIONS_POOL: NodeTaint[] = [
  { key: 'yaac.dev/worktrees', value: 'true', effect: 'NoSchedule' },
  { key: 'yaac.dev/worktrees', value: 'true', effect: 'NoExecute' },
]

/** What the gvisor RuntimeClass declares for a tainted sessions pool. */
const POOL_TOLERATIONS: PodToleration[] = [
  { key: 'yaac.dev/worktrees', operator: 'Equal', value: 'true', effect: 'NoSchedule' },
  { key: 'yaac.dev/worktrees', operator: 'Equal', value: 'true', effect: 'NoExecute' },
]

describe('untoleratedTaints', () => {
  it('rejects every blocking taint for a pod that tolerates nothing', () => {
    // The pre-pool world, and still the answer for trusted infra (the
    // project registry's node pick): no tolerations means every
    // NoSchedule/NoExecute taint really does rule the node out.
    expect(untoleratedTaints([CONTROL_PLANE], [])).toEqual([CONTROL_PLANE])
    expect(untoleratedTaints(SESSIONS_POOL, [])).toEqual(SESSIONS_POOL)
    expect(untoleratedTaints(undefined, undefined)).toEqual([])
    expect(untoleratedTaints([], [])).toEqual([])
  })

  it('admits a deliberately tainted sessions pool, and only that pool', () => {
    // The whole point: a pool tainted so nothing else drifts onto it must
    // read as usable once the RuntimeClass declares its toleration — not as
    // "zero nodes can schedule a session".
    expect(untoleratedTaints(SESSIONS_POOL, POOL_TOLERATIONS)).toEqual([])
    // ...without turning into a blanket pass. The pool toleration says
    // nothing about a control plane, or about the pressure taints kubelet
    // adds to a pool node that is filling up — a session genuinely cannot
    // land there, and reporting otherwise would hide a node going bad.
    expect(untoleratedTaints([...SESSIONS_POOL, MEMORY_PRESSURE], POOL_TOLERATIONS))
      .toEqual([MEMORY_PRESSURE])
    expect(untoleratedTaints([CONTROL_PLANE], POOL_TOLERATIONS)).toEqual([CONTROL_PLANE])
  })

  it('matches keys, values and effects the way kubernetes does', () => {
    // Effect: a toleration with an effect covers only that effect, so a
    // NoSchedule-only toleration does NOT stop a NoExecute eviction.
    const noScheduleOnly = [POOL_TOLERATIONS[0]]
    expect(untoleratedTaints(SESSIONS_POOL, noScheduleOnly)).toEqual([SESSIONS_POOL[1]])
    // An EMPTY effect is the wildcard, not "no effect" — it covers both.
    expect(untoleratedTaints(SESSIONS_POOL, [
      { key: 'yaac.dev/worktrees', operator: 'Equal', value: 'true' },
    ])).toEqual([])

    // Operator: empty defaults to Equal, so the value must match — a pool
    // relabelled `value: gpu` is not tolerated by the `true` toleration.
    expect(untoleratedTaints(
      [{ key: 'yaac.dev/worktrees', value: 'gpu', effect: 'NoSchedule' }],
      [{ key: 'yaac.dev/worktrees', value: 'true', effect: 'NoSchedule' }],
    )).toEqual([{ key: 'yaac.dev/worktrees', value: 'gpu', effect: 'NoSchedule' }])
    // Exists ignores the value: the usual spelling for a valueless taint.
    expect(untoleratedTaints(
      [{ key: 'yaac.dev/worktrees', value: 'gpu', effect: 'NoSchedule' }],
      [{ key: 'yaac.dev/worktrees', operator: 'Exists' }],
    )).toEqual([])
    // A valueless taint matches an Equal toleration with no value.
    expect(untoleratedTaints([MEMORY_PRESSURE], [
      { key: 'node.kubernetes.io/memory-pressure', effect: 'NoSchedule' },
    ])).toEqual([])

    // An operator that is neither tolerates nothing, rather than falling
    // through to a value comparison — the apiserver rejects these, so the
    // only question is which way an impossible input fails, and granting a
    // node on a typo'd operator is the wrong one.
    expect(untoleratedTaints(
      [{ key: 'yaac.dev/worktrees', value: 'true', effect: 'NoSchedule' }],
      [{ key: 'yaac.dev/worktrees', operator: 'Equals', value: 'true', effect: 'NoSchedule' }],
    )).toEqual([{ key: 'yaac.dev/worktrees', value: 'true', effect: 'NoSchedule' }])

    // Empty key is the wildcard only with Exists — netd's and the gVisor
    // installer's `{operator: Exists}`, which tolerates the whole cluster.
    expect(untoleratedTaints(
      [CONTROL_PLANE, ...SESSIONS_POOL, UNINITIALIZED],
      [{ operator: 'Exists' }],
    )).toEqual([])
    // ...and an empty key without it tolerates nothing (kubernetes rejects
    // the toleration outright; treating it as a wildcard would silently
    // grant a pod the run of the cluster).
    expect(untoleratedTaints([CONTROL_PLANE], [{ value: 'true' }])).toEqual([CONTROL_PLANE])
  })

  it('ignores PreferNoSchedule, which never keeps a pod off a node', () => {
    // A scheduler preference, not a gate: an untolerated PreferNoSchedule
    // node still takes the pod when nothing better exists, so counting it as
    // blocking would report a usable node as unusable.
    expect(untoleratedTaints([
      { key: 'yaac.dev/drain-soon', effect: 'PreferNoSchedule' },
    ], [])).toEqual([])
    // ...but a node carrying both is still blocked by the hard one.
    expect(untoleratedTaints([
      { key: 'yaac.dev/drain-soon', effect: 'PreferNoSchedule' },
      DISK_PRESSURE,
    ], [])).toEqual([DISK_PRESSURE])
  })
})

describe('formatTaint', () => {
  it('renders a taint the way kubectl taint spells it', () => {
    expect(formatTaint(CONTROL_PLANE)).toBe('node-role.kubernetes.io/control-plane:NoSchedule')
    expect(formatTaint(UNINITIALIZED))
      .toBe('node.cloudprovider.kubernetes.io/uninitialized=true:NoSchedule')
    expect(formatTaint(SESSIONS_POOL[1])).toBe('yaac.dev/worktrees=true:NoExecute')
  })
})
