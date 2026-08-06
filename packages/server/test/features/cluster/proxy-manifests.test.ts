import { describe, it, expect, vi } from 'vitest'

vi.mock('#platform/k8s/kubectl', () => ({
  isKubectlAbsentError: vi.fn(() => false),
  kubectlErrorSummary: vi.fn((e: unknown) => String(e)),
  k8sNamespace: vi.fn(() => 'test-ns'),
  dataDirHash: vi.fn(() => 'ddh0123456789abc'),
}))

import {
  buildBuilderRoleGuardBindingManifest,
  buildBuilderRoleGuardPolicyManifest,
} from '#features/cluster'
import { BUILDER_ROLE_GUARD_NAME } from '#platform/k8s/proxy-constants'

// The builder-role admission guard is the only pair of manifests outside the
// folder needs — the image feature installs it around its runsc builder pods.
// The proxy's own Deployment, Service, ServiceAccount, RBAC and outer-CA
// ConfigMap are internal to the feature and asserted where they are applied,
// through `ensureProxyResources`.

interface Vap {
  apiVersion: string
  kind: string
  metadata: { name: string }
  spec: {
    failurePolicy: string
    matchConstraints: { resourceRules: Array<Record<string, unknown>> }
    matchConditions: Array<{ name: string; expression: string }>
    validations: Array<{ expression: string; message: string }>
  }
}

describe('buildBuilderRoleGuardPolicyManifest', () => {
  it('matches only pods carrying yaac.role=builder, on create AND update', () => {
    const m = buildBuilderRoleGuardPolicyManifest() as unknown as Vap
    expect(m.kind).toBe('ValidatingAdmissionPolicy')
    expect(m.metadata.name).toBe(BUILDER_ROLE_GUARD_NAME)
    expect(m.spec.failurePolicy).toBe('Fail')
    expect(m.spec.matchConstraints.resourceRules).toEqual([{
      apiGroups: [''],
      apiVersions: ['v1'],
      operations: ['CREATE', 'UPDATE'],
      resources: ['pods'],
    }])
    // The label predicate is a matchCondition, so unlabeled pods are
    // entirely untouched by the policy.
    expect(m.spec.matchConditions).toHaveLength(1)
    expect(m.spec.matchConditions[0].expression)
      .toContain("object.metadata.labels['yaac.role'] == 'builder'")
  })

  it('denies ServiceAccount creators and non-gvisor carriers', () => {
    const m = buildBuilderRoleGuardPolicyManifest() as unknown as Vap
    const exprs = m.spec.validations.map((v) => v.expression)
    // A session's only path to pod creation (a vcluster syncer) is an SA;
    // session pods themselves hold no token. The trusted server is a cert
    // user, never an SA.
    expect(exprs).toContain("!request.userInfo.username.startsWith('system:serviceaccount:')")
    // And the label may only describe an actually-sandboxed pod.
    expect(exprs).toContain(
      "has(object.spec.runtimeClassName) && object.spec.runtimeClassName == 'gvisor'",
    )
  })
})

describe('buildBuilderRoleGuardBindingManifest', () => {
  it('binds cluster-wide with Deny — the label is reserved in every namespace', () => {
    const m = buildBuilderRoleGuardBindingManifest() as unknown as {
      kind: string
      metadata: { name: string }
      spec: { policyName: string; validationActions: string[]; matchResources?: unknown }
    }
    expect(m.kind).toBe('ValidatingAdmissionPolicyBinding')
    expect(m.spec.policyName).toBe(BUILDER_ROLE_GUARD_NAME)
    expect(m.spec.validationActions).toEqual(['Deny'])
    // No matchResources: vcluster session namespaces are covered too.
    expect(m.spec.matchResources).toBeUndefined()
  })
})
