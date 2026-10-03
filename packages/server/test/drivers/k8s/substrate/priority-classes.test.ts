import { describe, it, expect } from 'vitest'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'

import {
  PRIORITY_CLASS_BUILDER,
  PRIORITY_CLASS_INFRA,
  buildPriorityClassManifests,
  ensurePriorityClasses,
} from '#drivers/k8s/substrate'
// Internal, for the name only.
import { PRIORITY_CLASS_WORKSPACE } from '#drivers/k8s/substrate/priority-classes'

interface PriorityClass {
  apiVersion: string
  kind: string
  metadata: { name: string }
  value: number
  globalDefault: boolean
  preemptionPolicy?: string
  description: string
}

function classes(): PriorityClass[] {
  return buildPriorityClassManifests() as unknown as PriorityClass[]
}

function byName(name: string): PriorityClass {
  const found = classes().find((c) => c.metadata.name === name)
  if (!found) throw new Error(`no PriorityClass ${name}`)
  return found
}

describe('buildPriorityClassManifests', () => {
  it('emits scheduling.k8s.io/v1 PriorityClasses, none of them the global default', () => {
    const all = classes()
    expect(all.map((c) => c.metadata.name))
      .toEqual([PRIORITY_CLASS_INFRA, PRIORITY_CLASS_BUILDER, PRIORITY_CLASS_WORKSPACE])
    for (const c of all) {
      expect(c.apiVersion).toBe('scheduling.k8s.io/v1')
      expect(c.kind).toBe('PriorityClass')
      // A global default would re-rank every other pod in the cluster.
      expect(c.globalDefault).toBe(false)
      expect(c.description).not.toBe('')
    }
  })

  it('ranks infra > builders > sessions, all below the reserved system range', () => {
    expect(byName(PRIORITY_CLASS_INFRA).value)
      .toBeGreaterThan(byName(PRIORITY_CLASS_BUILDER).value)
    expect(byName(PRIORITY_CLASS_BUILDER).value)
      .toBeGreaterThan(byName(PRIORITY_CLASS_WORKSPACE).value)
    // Values above 1e9 are reserved for system classes.
    expect(byName(PRIORITY_CLASS_INFRA).value).toBeLessThanOrEqual(1_000_000_000)
    // Above the default so workspaces outrank other pods.
    expect(byName(PRIORITY_CLASS_WORKSPACE).value).toBeGreaterThan(0)
  })

  it('lets infra preempt, and nothing below it', () => {
    // A preempted workspace pod is never replaced, so only infra may
    // preempt. Builders outrank workspaces but wait for room.
    expect(byName(PRIORITY_CLASS_WORKSPACE).preemptionPolicy).toBe('Never')
    expect(byName(PRIORITY_CLASS_BUILDER).preemptionPolicy).toBe('Never')
    // Infra must leave it unset: in nested installs the syncer copies
    // preemptionPolicy to the host without the class, and the host would
    // reject the pod.
    expect(byName(PRIORITY_CLASS_INFRA).preemptionPolicy).toBeUndefined()
  })
})

describe('ensurePriorityClasses', () => {
  it('applies every class', async () => {
    await ensurePriorityClasses()
    expect(fakeCluster.callsOf('apply').map((c) => c.body)).toEqual(classes())
  })
})
