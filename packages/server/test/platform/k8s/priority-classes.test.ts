import { describe, it, expect, vi, beforeEach } from 'vitest'

// The process boundary: the kubectl child the ensure shells out to. The
// whole module is stubbed (not just kubectlApply) because the barrel's other
// modules import its rest at link time.
vi.mock('#platform/k8s/kubectl', () => ({
  isKubectlAbsentError: vi.fn(() => false),
  kubectlErrorSummary: vi.fn((e: unknown) => String(e)),
  execFileAsync: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  k8sNamespace: vi.fn(() => 'test-ns'),
  dataDirHash: vi.fn(() => 'ddh0123456789abc'),
  isTransientKubectlError: vi.fn(() => false),
  isNotFoundKubectlError: vi.fn(() => false),
  retryTransient: vi.fn(),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  shellKubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  kubectlGetJson: vi.fn().mockResolvedValue(null),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  ensureKubernetes: vi.fn().mockResolvedValue(undefined),
}))

import {
  PRIORITY_CLASS_BUILDER,
  PRIORITY_CLASS_INFRA,
  buildPriorityClassManifests,
  ensurePriorityClasses,
} from '#platform/k8s'
// Internal, for the name only: the session tier is stamped inside
// pod-spec (priorityClassSpec) and covered through the Job manifest.
import { PRIORITY_CLASS_SESSION } from '#platform/k8s/priority-classes'
import { kubectlApply } from '#platform/k8s/kubectl'

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
      .toEqual([PRIORITY_CLASS_INFRA, PRIORITY_CLASS_BUILDER, PRIORITY_CLASS_SESSION])
    for (const c of all) {
      expect(c.apiVersion).toBe('scheduling.k8s.io/v1')
      expect(c.kind).toBe('PriorityClass')
      // A globalDefault class would silently re-rank every unstamped pod in
      // the cluster, including workloads that are not ours.
      expect(c.globalDefault).toBe(false)
      expect(c.description).not.toBe('')
    }
  })

  it('ranks infra > builders > sessions, all below the reserved system range', () => {
    expect(byName(PRIORITY_CLASS_INFRA).value)
      .toBeGreaterThan(byName(PRIORITY_CLASS_BUILDER).value)
    expect(byName(PRIORITY_CLASS_BUILDER).value)
      .toBeGreaterThan(byName(PRIORITY_CLASS_SESSION).value)
    // Kubernetes reserves values above 1e9 for its own system-* classes;
    // exceeding it makes the apiserver reject the object.
    expect(byName(PRIORITY_CLASS_INFRA).value).toBeLessThanOrEqual(1_000_000_000)
    // Above the unstamped default so a live session outranks whatever else
    // shares the cluster.
    expect(byName(PRIORITY_CLASS_SESSION).value).toBeGreaterThan(0)
  })

  it('lets infra preempt, and nothing below it', () => {
    // A preempted pod is deleted, and a session Job (backoffLimit 0,
    // restartPolicy Never) does not replace it. So nothing under the infra
    // tier may buy its own scheduling with a session's life — a builder
    // outranks sessions for eviction while still waiting for room.
    expect(byName(PRIORITY_CLASS_SESSION).preemptionPolicy).toBe('Never')
    expect(byName(PRIORITY_CLASS_BUILDER).preemptionPolicy).toBe('Never')
    // Infra keeps the default. Nested installs depend on that: the syncer
    // copies preemptionPolicy to the host while dropping the class name, and
    // an explicit value there would make every synced infra pod rejected.
    expect(byName(PRIORITY_CLASS_INFRA).preemptionPolicy).toBeUndefined()
  })
})

describe('ensurePriorityClasses', () => {
  beforeEach(() => {
    vi.mocked(kubectlApply).mockClear()
  })

  it('applies every class, and stays idempotent on a re-run', async () => {
    await ensurePriorityClasses()
    expect(vi.mocked(kubectlApply).mock.calls.map(([m]) => m)).toEqual(classes())

    // `apply` is the idempotence: a second run sends the same bytes, so a
    // server boot against an already-installed cluster changes nothing.
    await ensurePriorityClasses()
    expect(vi.mocked(kubectlApply)).toHaveBeenCalledTimes(classes().length * 2)
  })
})
