import { describe, it, expect, vi, beforeEach } from 'vitest'

// Manifests are rendered for a known namespace.
beforeEach(() => { vi.stubEnv('YAAC_K8S_NAMESPACE', 'test-ns') })


import {
  buildBuilderRoleGuardBindingManifest,
  buildBuilderRoleGuardPolicyManifest,
  buildRegistrationConfigMapManifest,
  proxyRegistrationName,
} from '#drivers/k8s/cluster'
import {
  BUILDER_ROLE_GUARD_NAME,
  SERVER_SA_NAME,
} from '#drivers/k8s/substrate/proxy-constants'

// The exported manifests: the builder-role admission guard (for gVisor
// builder pods) and the per-workspace registration ConfigMap. The proxy's own
// objects are internal and asserted through `ensureProxyResources`.

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
    // A matchCondition, so pods without the label skip the policy entirely.
    expect(m.spec.matchConditions).toHaveLength(1)
    expect(m.spec.matchConditions[0].expression)
      .toContain("object.metadata.labels['yaac.role'] == 'builder'")
  })

  it('admits only the server ServiceAccount shape, and only gvisor carriers', () => {
    const m = buildBuilderRoleGuardPolicyManifest() as unknown as Vap
    const exprs = m.spec.validations.map((v) => v.expression)
    // Only a yaac server creates builder pods, running as the `yaac-server`
    // ServiceAccount of its namespace. SA usernames are
    // `system:serviceaccount:<ns>:<name>` with no ':' inside a segment, so
    // this prefix+suffix matches exactly that SA name in any namespace.
    expect(exprs).toContain(
      "request.userInfo.username.startsWith('system:serviceaccount:') "
      + `&& request.userInfo.username.endsWith(':${SERVER_SA_NAME}')`,
    )
    // The label is allowed only on a gVisor-sandboxed pod.
    expect(exprs).toContain(
      "has(object.spec.runtimeClassName) && object.spec.runtimeClassName == 'gvisor'",
    )
  })

  it('keeps the policy text install-agnostic', () => {
    // The policy is cluster-scoped with a fixed name, and every install
    // (including each e2e namespace) re-applies it. A namespace in the text
    // would lock every other install's server out of builder pods.
    const m = buildBuilderRoleGuardPolicyManifest() as unknown as Vap
    expect(JSON.stringify(m)).not.toContain('test-ns')
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

describe('proxyRegistrationName', () => {
  it('names a workspace’s registration by its id — a UUID fits without hashing', () => {
    expect(proxyRegistrationName('3f0c9b8e-1d2a-4c5b-9e7f-8a6b5c4d3e2f'))
      .toBe('yaac-proxy-reg-3f0c9b8e-1d2a-4c5b-9e7f-8a6b5c4d3e2f')
  })
})

describe('buildRegistrationConfigMapManifest', () => {
  it('labels the object for the proxy’s informer, its workspace and its project', () => {
    const cm = buildRegistrationConfigMapManifest('w1', 'demo', { rules: [], allowedHosts: ['h'] }) as {
      kind: string
      metadata: { name: string; namespace: string; labels: Record<string, string> }
      data: Record<string, string>
    }
    expect(cm.kind).toBe('ConfigMap')
    expect(cm.metadata).toEqual({
      name: proxyRegistrationName('w1'),
      namespace: 'test-ns',
      labels: {
        'app': 'yaac-proxy',
        'yaac.proxy-input': 'registration',
        'yaac.workspace-id': 'w1',
        'yaac.project-id': 'demo',
      },
    })
    expect(JSON.parse(cm.data['registration.json'])).toEqual({ rules: [], allowedHosts: ['h'] })
  })
})
