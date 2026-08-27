import { describe, it, expect, vi } from 'vitest'

vi.mock('#drivers/k8s/substrate/kubectl', () => ({
  isKubectlAbsentError: vi.fn(() => false),
  kubectlErrorSummary: vi.fn((e: unknown) => String(e)),
  k8sNamespace: vi.fn(() => 'test-ns'),
  dataDirHash: vi.fn(() => 'ddh0123456789abc'),
}))

import {
  buildBuilderRoleGuardBindingManifest,
  buildBuilderRoleGuardPolicyManifest,
} from '#drivers/k8s/cluster'
import {
  BUILDER_ROLE_GUARD_NAME,
  SERVER_SA_NAME,
} from '#drivers/k8s/substrate/proxy-constants'

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

  it('admits only the server ServiceAccount, and only gvisor carriers', () => {
    const m = buildBuilderRoleGuardPolicyManifest() as unknown as Vap
    const exprs = m.spec.validations.map((v) => v.expression)
    // The server creates every builder pod and runs in-cluster as its own
    // ServiceAccount, so the guard names that one identity: any other SA
    // (the identity class untrusted code can hold) and any cert user are
    // both denied.
    expect(exprs).toContain(
      "request.userInfo.username == 'system:serviceaccount:test-ns:yaac-server'",
    )
    // And the label may only describe an actually-sandboxed pod.
    expect(exprs).toContain(
      "has(object.spec.runtimeClassName) && object.spec.runtimeClassName == 'gvisor'",
    )
  })

  it('names the server SA in the install namespace, not a literal', () => {
    // k8sNamespace() is mocked to 'test-ns' above, standing in for the
    // per-file YAAC_K8S_NAMESPACE the e2e tiers install under: a hardcoded
    // 'yaac' here would deny that install's own server.
    const m = buildBuilderRoleGuardPolicyManifest() as unknown as Vap
    const expr = m.spec.validations[0].expression
    expect(expr).toContain(`:test-ns:${SERVER_SA_NAME}'`)
    expect(expr).not.toContain(':yaac:')
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
    // No matchResources: every namespace is covered.
    expect(m.spec.matchResources).toBeUndefined()
  })
})
