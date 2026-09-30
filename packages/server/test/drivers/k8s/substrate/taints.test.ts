import { describe, it, expect } from 'vitest'
import { formatTaint, untoleratedTaints } from '#drivers/k8s/substrate'
import type { NodeTaint, PodToleration } from '#drivers/k8s/substrate'

/**
 * Real-world taints: kubeadm's control-plane taint, kubelet's node-pressure
 * taints, a cloud node's `uninitialized` taint, and a dedicated workspace
 * pool's taint.
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
  { key: 'yaac.dev/workspaces', value: 'true', effect: 'NoSchedule' },
  { key: 'yaac.dev/workspaces', value: 'true', effect: 'NoExecute' },
]

/** What the gvisor RuntimeClass declares for a tainted sessions pool. */
const POOL_TOLERATIONS: PodToleration[] = [
  { key: 'yaac.dev/workspaces', operator: 'Equal', value: 'true', effect: 'NoSchedule' },
  { key: 'yaac.dev/workspaces', operator: 'Equal', value: 'true', effect: 'NoExecute' },
]

describe('untoleratedTaints', () => {
  it('rejects every blocking taint for a pod that tolerates nothing', () => {
    // As for trusted infra such as the project registry.
    expect(untoleratedTaints([CONTROL_PLANE], [])).toEqual([CONTROL_PLANE])
    expect(untoleratedTaints(SESSIONS_POOL, [])).toEqual(SESSIONS_POOL)
    expect(untoleratedTaints(undefined, undefined)).toEqual([])
    expect(untoleratedTaints([], [])).toEqual([])
  })

  it('admits a deliberately tainted sessions pool, and only that pool', () => {
    expect(untoleratedTaints(SESSIONS_POOL, POOL_TOLERATIONS)).toEqual([])
    // The pool toleration does not cover control-plane or pressure taints.
    expect(untoleratedTaints([...SESSIONS_POOL, MEMORY_PRESSURE], POOL_TOLERATIONS))
      .toEqual([MEMORY_PRESSURE])
    expect(untoleratedTaints([CONTROL_PLANE], POOL_TOLERATIONS)).toEqual([CONTROL_PLANE])
  })

  it('matches keys, values and effects the way kubernetes does', () => {
    // A toleration with an effect covers only that effect.
    const noScheduleOnly = [POOL_TOLERATIONS[0]]
    expect(untoleratedTaints(SESSIONS_POOL, noScheduleOnly)).toEqual([SESSIONS_POOL[1]])
    // An empty effect matches every effect.
    expect(untoleratedTaints(SESSIONS_POOL, [
      { key: 'yaac.dev/workspaces', operator: 'Equal', value: 'true' },
    ])).toEqual([])

    // The operator defaults to Equal, so the value must match.
    expect(untoleratedTaints(
      [{ key: 'yaac.dev/workspaces', value: 'gpu', effect: 'NoSchedule' }],
      [{ key: 'yaac.dev/workspaces', value: 'true', effect: 'NoSchedule' }],
    )).toEqual([{ key: 'yaac.dev/workspaces', value: 'gpu', effect: 'NoSchedule' }])
    // Exists ignores the value.
    expect(untoleratedTaints(
      [{ key: 'yaac.dev/workspaces', value: 'gpu', effect: 'NoSchedule' }],
      [{ key: 'yaac.dev/workspaces', operator: 'Exists' }],
    )).toEqual([])
    // A valueless taint matches an Equal toleration with no value.
    expect(untoleratedTaints([MEMORY_PRESSURE], [
      { key: 'node.kubernetes.io/memory-pressure', effect: 'NoSchedule' },
    ])).toEqual([])

    // An unknown operator tolerates nothing (the apiserver rejects it anyway).
    expect(untoleratedTaints(
      [{ key: 'yaac.dev/workspaces', value: 'true', effect: 'NoSchedule' }],
      [{ key: 'yaac.dev/workspaces', operator: 'Equals', value: 'true', effect: 'NoSchedule' }],
    )).toEqual([{ key: 'yaac.dev/workspaces', value: 'true', effect: 'NoSchedule' }])

    // An empty key with Exists tolerates everything (as netd uses).
    expect(untoleratedTaints(
      [CONTROL_PLANE, ...SESSIONS_POOL, UNINITIALIZED],
      [{ operator: 'Exists' }],
    )).toEqual([])
    // An empty key without Exists tolerates nothing.
    expect(untoleratedTaints([CONTROL_PLANE], [{ value: 'true' }])).toEqual([CONTROL_PLANE])
  })

  it('ignores PreferNoSchedule, which never keeps a pod off a node', () => {
    // PreferNoSchedule is only a scheduler preference.
    expect(untoleratedTaints([
      { key: 'yaac.dev/drain-soon', effect: 'PreferNoSchedule' },
    ], [])).toEqual([])
    // A hard taint alongside it still blocks.
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
    expect(formatTaint(SESSIONS_POOL[1])).toBe('yaac.dev/workspaces=true:NoExecute')
  })
})
