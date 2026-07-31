import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('#platform/k8s/kubectl', () => ({
  k8sNamespace: vi.fn(() => 'test-ns'),
  dataDirHash: vi.fn(() => 'hash1'),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))
vi.mock('#features/cluster/cluster-cidrs', () => ({
  clusterPodCidrs: vi.fn().mockResolvedValue(['10.244.0.0/16', '10.244.0.0/24']),
}))
vi.mock('#features/cluster/registry', () => ({
  pushImageToRegistry: vi.fn((tag: string) => Promise.resolve(`localhost:5001/${tag}`)),
  registryHasTag: vi.fn().mockResolvedValue(false),
  registryRef: vi.fn((tag: string) => `localhost:5001/${tag}`),
}))
vi.mock('#platform/container/runtime', () => ({ imageExists: vi.fn().mockResolvedValue(true) }))
vi.mock('#features/images/image-builder', () => ({
  buildImage: vi.fn().mockResolvedValue(undefined),
  contextHash: vi.fn().mockResolvedValue('deadbeefcafe'),
}))

import { kubectlApply, kubectlWithRetry } from '#platform/k8s/kubectl'
import { clusterPodCidrs } from '#features/cluster/cluster-cidrs'
import { imageExists } from '#platform/container/runtime'
import { registryHasTag } from '#features/cluster/registry'
import { buildImage } from '#features/images/image-builder'
import {
  ENVOY_MIRROR_TAG,
  ENVOY_UPSTREAM_IMAGE,
  assertMirrorArch,
  hostImageArch,
  buildNetdClaimDaemonSetManifest,
  buildNetdClaimRoleManifest,
  buildNetdClusterRoleBindingManifest,
  buildNetdClusterRoleManifest,
  buildNetdDaemonSetManifest,
  buildNetdRoleBindingManifest,
  buildNetdRoleManifest,
  buildNetdServiceAccountManifest,
  ensureClaimNetd,
  ensureEnvoyImage,
  ensureNetd,
  ensureNetdImage,
  netdClusterScopedLabels,
  netdClusterScopedName,
  resolveNetdImageTag,
} from '#features/cluster/netd'
import {
  NETD_APP_NAME,
  NETD_LISTENER_PORT_BASE,
  NETD_LISTENER_PORT_END,
  NETD_LISTENER_SLOTS,
  NETD_SA_NAME,
  TRANSPARENT_HTTPS_PORT,
} from '#features/cluster/proxy-constants'

const DS_OPTS = {
  netdImage: 'localhost:5001/yaac-netd:hash',
  envoyImage: 'localhost:5001/envoyproxy/envoy:v1.34.0',
  podCidrs: ['10.244.0.0/16', '192.168.0.0/16'],
}

interface Container {
  name: string
  image: string
  env?: Array<{ name: string; value?: string; valueFrom?: unknown }>
  securityContext?: { runAsUser?: number; capabilities?: { add?: string[]; drop?: string[] } }
  readinessProbe?: { exec?: { command: string[] } }
  command?: string[]
  volumeMounts?: Array<{ name: string; mountPath: string }>
}

function containers(ds: Record<string, unknown> = buildNetdDaemonSetManifest(DS_OPTS)): Container[] {
  const spec = ds.spec as { template: { spec: { containers: Container[] } } }
  return spec.template.spec.containers
}

function podSpec(): Record<string, unknown> {
  const ds = buildNetdDaemonSetManifest(DS_OPTS)
  return (ds.spec as { template: { spec: Record<string, unknown> } }).template.spec
}

function envOf(name: string): Record<string, string> {
  const container = containers().find((c) => c.name === name)!
  return Object.fromEntries((container.env ?? []).filter((e) => e.value !== undefined)
    .map((e) => [e.name, e.value!]))
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('buildNetdServiceAccountManifest', () => {
  it('lands in the install namespace under the app label', () => {
    const sa = buildNetdServiceAccountManifest()
    expect(sa.kind).toBe('ServiceAccount')
    expect(sa.metadata).toEqual({
      name: NETD_SA_NAME, namespace: 'test-ns', labels: { app: NETD_APP_NAME },
    })
  })
})

describe('buildNetdClusterRoleManifest', () => {
  it('grants read-only get/list/watch on PODS and nothing else', () => {
    // netd never writes to the API, so a compromised netd cannot mutate
    // cluster state; its privilege is on the node's netfilter. Pods are the
    // only kind it needs cluster-wide — a pod's veth is what it programs.
    const role = buildNetdClusterRoleManifest()
    expect(role.rules).toEqual([
      { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'watch'] },
    ])
  })

  it('is cluster-scoped: netd must see every vcluster namespace', () => {
    expect(buildNetdClusterRoleManifest().kind).toBe('ClusterRole')
  })
})

describe('buildNetdRoleManifest / buildNetdRoleBindingManifest', () => {
  it('reads the selection\'s two namespaced inputs, read-only', () => {
    // The proxy Service (the outer target) and the claims ConfigMap, both
    // yaac-authored in the install namespace — which is what makes netd's
    // rule-2 input trusted rather than tenant-writable.
    const role = buildNetdRoleManifest()
    expect(role.kind).toBe('Role')
    expect(role.rules).toEqual([
      { apiGroups: [''], resources: ['services', 'configmaps'], verbs: ['get', 'list', 'watch'] },
    ])
  })

  it('binds the namespaced role to netd\'s SA', () => {
    const binding = buildNetdRoleBindingManifest()
    expect(binding.roleRef).toMatchObject({ kind: 'Role', name: NETD_SA_NAME })
    expect(binding.subjects).toEqual([
      { kind: 'ServiceAccount', name: NETD_SA_NAME, namespace: 'test-ns' },
    ])
  })
})

describe('buildNetdClaimRoleManifest', () => {
  it('reads its own namespace\'s pods and owns the claim ConfigMap', () => {
    const role = buildNetdClaimRoleManifest()
    expect(role.kind).toBe('Role')
    expect(role.rules).toEqual([
      { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'watch'] },
      {
        apiGroups: [''],
        resources: ['configmaps'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch'],
      },
    ])
  })
})

describe('buildNetdClaimDaemonSetManifest', () => {
  const claimDs = () => buildNetdClaimDaemonSetManifest({
    netdImage: 'localhost:5001/yaac-netd:hash',
    installHash: 'hash1',
  })
  const claimSpec = () => {
    const spec = (claimDs().spec as { template: { spec: Record<string, unknown> } }).template.spec
    return spec
  }

  it('asks for nothing the vcluster pod guard would have to except', () => {
    // A synced pod requesting hostNetwork or added capabilities is denied by
    // the VAP guard — and should be: a netd with real host authority driven
    // by a tenant-controlled API could DNAT a sibling session's veth.
    const spec = claimSpec()
    expect(spec.hostNetwork).toBeUndefined()
    expect(spec.hostPID).toBeUndefined()
    const containers = spec.containers as Array<Record<string, unknown>>
    expect(containers).toHaveLength(1)
    const security = containers[0].securityContext as Record<string, unknown>
    expect(security.capabilities).toEqual({ drop: ['ALL'] })
    expect(security.allowPrivilegeEscalation).toBe(false)
    expect(security.privileged).toBeUndefined()
    expect(JSON.stringify(claimDs())).not.toContain('NET_ADMIN')
  })

  it('runs no Envoy and programs no netfilter', () => {
    const containers = claimSpec().containers as Array<{ name: string }>
    expect(containers.map((c) => c.name)).toEqual(['netd'])
    expect(JSON.stringify(claimDs())).not.toContain('CLUSTER_POD_CIDRS')
  })

  it('runs in claim mode, stamped with this install\'s hash', () => {
    const containers = claimSpec().containers as Array<{ env: Array<{ name: string, value: string }> }>
    const env = Object.fromEntries(containers[0].env.map((e) => [e.name, e.value]))
    expect(env.NETD_MODE).toBe('claim')
    expect(env.YAAC_DATA_DIR_HASH).toBe('hash1')
    expect(env.YAAC_NAMESPACE).toBe('test-ns')
  })

  it('references the claim ConfigMap as a volume, which is what makes the syncer copy it', () => {
    const volumes = claimSpec().volumes as Array<Record<string, unknown>>
    const claim = volumes.find((v) => v.name === 'claim')!
    expect(claim.configMap).toEqual({ name: 'yaac-redirect-claim', optional: true })
  })

  it('reports Ready only once a claim has been published', () => {
    const containers = claimSpec().containers as Array<{ readinessProbe: { exec: { command: string[] } } }>
    expect(containers[0].readinessProbe.exec.command).toEqual([
      'test', '-f', '/var/run/yaac-netd/.ready',
    ])
  })
})

describe('buildNetdClusterRoleBindingManifest', () => {
  it('binds the install-scoped role to this install\'s SA only', () => {
    const binding = buildNetdClusterRoleBindingManifest()
    expect(binding.roleRef).toMatchObject({ kind: 'ClusterRole', name: netdClusterScopedName() })
    expect(binding.subjects).toEqual([
      { kind: 'ServiceAccount', name: NETD_SA_NAME, namespace: 'test-ns' },
    ])
  })
})

describe('netdClusterScopedName / netdClusterScopedLabels', () => {
  it('carries the install namespace, since these names are global', () => {
    // The real install and an e2e run's coexist on one cluster.
    expect(netdClusterScopedName()).toBe(`${NETD_APP_NAME}-test-ns`)
  })

  it('labels the objects so an interrupted run\'s leftovers can be swept', () => {
    // They do NOT cascade when the namespace is deleted, and the sweep
    // must not match the real install's.
    expect(netdClusterScopedLabels()).toEqual({
      app: NETD_APP_NAME, 'yaac.install-namespace': 'test-ns',
    })
  })
})

describe('buildNetdDaemonSetManifest', () => {
  it('runs hostNetwork on every node, including a control-plane-only one', () => {
    const spec = podSpec()
    expect(spec.hostNetwork).toBe(true)
    expect(spec.dnsPolicy).toBe('ClusterFirstWithHostNet')
    expect(spec.tolerations).toEqual([{ operator: 'Exists' }])
    expect(spec.priorityClassName).toBe('system-node-critical')
  })

  it('takes NET_ADMIN/NET_RAW rather than privileged', () => {
    // netd writes the node's nat table and reads its routes; a privileged
    // container would hand it far more than the redirect requires.
    const netd = containers().find((c) => c.name === 'netd')!
    expect(netd.securityContext?.capabilities?.add).toEqual(['NET_ADMIN', 'NET_RAW'])
    expect(JSON.stringify(netd.securityContext)).not.toContain('privileged')
  })

  it('gives Envoy no capabilities at all', () => {
    const envoy = containers().find((c) => c.name === 'envoy')!
    expect(envoy.securityContext?.capabilities).toEqual({ drop: ['ALL'] })
  })

  it('passes every pod CIDR, so multi-CIDR clusters keep pod-to-pod direct', () => {
    expect(envOf('netd').CLUSTER_POD_CIDRS).toBe('10.244.0.0/16,192.168.0.0/16')
  })

  it('passes the listener range, so netd and the NetworkPolicy cannot drift', () => {
    // The session policy admits exactly this range; a netd binding
    // outside it would be unreachable by the pods it serves.
    expect(envOf('netd').NETD_LISTENER_PORT_BASE).toBe(String(NETD_LISTENER_PORT_BASE))
    expect(envOf('netd').NETD_LISTENER_SLOTS).toBe(String(NETD_LISTENER_SLOTS))
    expect(NETD_LISTENER_PORT_BASE + NETD_LISTENER_SLOTS * 3 - 1)
      .toBeLessThanOrEqual(NETD_LISTENER_PORT_END)
  })

  it('shares the proxy-side port definitions rather than restating them', () => {
    expect(envOf('netd').TRANSPARENT_HTTPS_PORT).toBe(String(TRANSPARENT_HTTPS_PORT))
  })

  it('reads its node identity from the downward API', () => {
    const fromField = (containers().find((c) => c.name === 'netd')!.env ?? [])
      .filter((e) => e.valueFrom).map((e) => e.name)
    expect(fromField).toEqual(['NODE_NAME', 'NODE_IP'])
  })

  it('probes readiness on the marker netd writes after reaching the dataplane', () => {
    // Ready must mean "the redirect is programmed and Envoy serves it",
    // not "the process started" — the cluster-check datapath gate reads it.
    const netd = containers().find((c) => c.name === 'netd')!
    expect(netd.readinessProbe?.exec?.command).toEqual(['test', '-f', '/etc/yaac-envoy/.ready'])
  })

  it('leaves Envoy unprobed — netd\'s readiness already covers it', () => {
    expect(containers().find((c) => c.name === 'envoy')!.readinessProbe).toBeUndefined()
  })

  it('has Envoy wait for the bootstrap and take a dynamic base id', () => {
    // Its file xDS sources must resolve at boot, and hostNetwork siblings
    // cannot all claim base-id 0.
    const command = containers().find((c) => c.name === 'envoy')!.command!.join(' ')
    expect(command).toContain('while [ ! -f /etc/yaac-envoy/bootstrap.yaml ]')
    expect(command).toContain('--use-dynamic-base-id')
  })

  it('shares one emptyDir between the two containers', () => {
    // It carries the xDS documents, the admin socket the gate reads, the
    // persisted trio slot, and the readiness marker.
    const spec = podSpec()
    expect(spec.volumes).toEqual([{ name: 'envoy-config', emptyDir: {} }])
    for (const container of containers()) {
      expect(container.volumeMounts).toEqual([{ name: 'envoy-config', mountPath: '/etc/yaac-envoy' }])
    }
  })
})

describe('resolveNetdImageTag', () => {
  it('tags the image with a hash of its build context', async () => {
    expect(await resolveNetdImageTag()).toBe('yaac-netd:deadbeefcafe')
    expect(await resolveNetdImageTag('yaac-test-netd')).toBe('yaac-test-netd:deadbeefcafe')
  })
})

describe('ensureNetdImage', () => {
  it('is a registry lookup when the tag is already pushed', async () => {
    vi.mocked(registryHasTag).mockResolvedValueOnce(true)
    expect(await ensureNetdImage()).toBe('localhost:5001/yaac-netd:deadbeefcafe')
    expect(buildImage).not.toHaveBeenCalled()
  })

  it('pushes a locally-built image without rebuilding it', async () => {
    expect(await ensureNetdImage(false)).toBe('localhost:5001/yaac-netd:deadbeefcafe')
    expect(buildImage).not.toHaveBeenCalled()
  })

  it('builds when the image is missing', async () => {
    vi.mocked(imageExists).mockResolvedValueOnce(false)
    await ensureNetdImage(false)
    expect(buildImage).toHaveBeenCalledOnce()
  })

  it('fails fast under requirePrebuilt rather than racing a test worker', async () => {
    vi.mocked(imageExists).mockResolvedValueOnce(false)
    await expect(ensureNetdImage(true)).rejects.toThrow(/missing or stale/)
  })
})

describe('ENVOY image pin', () => {
  it('is digest-pinned upstream and mirrored under a readable tag', () => {
    expect(ENVOY_UPSTREAM_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/)
    expect(ENVOY_MIRROR_TAG).toMatch(/^envoyproxy\/envoy:v\d+\.\d+\.\d+-[0-9a-f]{12}$/)
  })

  it('carries the pin in the mirror tag, so a re-pin re-mirrors', () => {
    // ensureEnvoyImage short-circuits on a tag the registry already holds;
    // a version-only tag would freeze an existing install on the old bytes.
    const digest = ENVOY_UPSTREAM_IMAGE.split('@sha256:')[1]
    expect(ENVOY_MIRROR_TAG.endsWith(`-${digest.slice(0, 12)}`)).toBe(true)
  })
})

describe('hostImageArch', () => {
  it('maps node arch names onto podman GOARCH names', () => {
    expect(hostImageArch('x64')).toBe('amd64')
    expect(hostImageArch('arm64')).toBe('arm64')
  })
})

describe('assertMirrorArch', () => {
  it('accepts a matching arch and an unknown one', () => {
    expect(() => assertMirrorArch('img', 'amd64', 'amd64')).not.toThrow()
    expect(() => assertMirrorArch('img', '', 'amd64')).not.toThrow()
  })

  it('rejects a mismatch, naming the child-manifest pin as the cause', () => {
    // The failure this catches: pinning one platform's child manifest
    // mirrors arm64 bytes onto an x86 node, where the sidecar dies on
    // `exec format error` and netd simply never goes ready.
    expect(() => assertMirrorArch('envoy', 'arm64', 'amd64'))
      .toThrow(/arm64 image but this host is amd64.*index digest/s)
  })
})

describe('ensureNetd', () => {
  it('applies RBAC before the DaemonSet, then waits for the rollout', async () => {
    vi.mocked(registryHasTag).mockResolvedValue(true)
    await ensureNetd()
    const kinds = vi.mocked(kubectlApply).mock.calls
      .map((call) => (call[0] as { kind: string }).kind)
    expect(kinds).toEqual([
      'ServiceAccount', 'ClusterRole', 'ClusterRoleBinding', 'Role', 'RoleBinding', 'DaemonSet',
    ])
    expect(kubectlWithRetry).toHaveBeenCalledWith(
      expect.arrayContaining(['rollout', 'status', `daemonset/${NETD_APP_NAME}`]),
      expect.anything(),
    )
  })

  it('resolves the pod CIDRs into the DaemonSet it applies', async () => {
    vi.mocked(registryHasTag).mockResolvedValue(true)
    await ensureNetd()
    expect(clusterPodCidrs).toHaveBeenCalledOnce()
    const ds = vi.mocked(kubectlApply).mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((manifest) => manifest.kind === 'DaemonSet')!
    expect(JSON.stringify(ds)).toContain('10.244.0.0/16,10.244.0.0/24')
  })

  it('nested: applies claim-mode RBAC, the claim ConfigMap, then the DaemonSet', async () => {
    vi.mocked(registryHasTag).mockResolvedValue(true)
    await ensureNetd({ nested: true })
    const kinds = vi.mocked(kubectlApply).mock.calls
      .map((call) => (call[0] as { kind: string }).kind)
    // No cluster-scoped object of any kind: an inner install has no business
    // outside its own namespace. The ConfigMap precedes the DaemonSet so its
    // volume reference resolves on first schedule.
    expect(kinds).toEqual(['ServiceAccount', 'Role', 'RoleBinding', 'ConfigMap', 'DaemonSet'])
  })

  it('nested: mirrors no Envoy image and reads no pod CIDRs', async () => {
    vi.mocked(registryHasTag).mockResolvedValue(true)
    await ensureNetd({ nested: true })
    expect(clusterPodCidrs).not.toHaveBeenCalled()
    const ds = vi.mocked(kubectlApply).mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((manifest) => manifest.kind === 'DaemonSet')!
    expect(JSON.stringify(ds)).not.toContain('envoy')
  })
})

describe('ensureEnvoyImage', () => {
  // clearAllMocks keeps implementations, and earlier suites pin
  // registryHasTag to true — re-arm the "not pushed yet" default here.
  beforeEach(() => {
    vi.mocked(registryHasTag).mockResolvedValue(false)
    vi.mocked(imageExists).mockResolvedValue(true)
  })

  it('is a registry lookup when the mirror tag is already pushed', async () => {
    vi.mocked(registryHasTag).mockResolvedValueOnce(true)
    expect(await ensureEnvoyImage()).toBe(`localhost:5001/${ENVOY_MIRROR_TAG}`)
    expect(imageExists).not.toHaveBeenCalled()
  })

  it('pushes an already-pulled image without touching the network', async () => {
    expect(await ensureEnvoyImage(false)).toBe(`localhost:5001/${ENVOY_MIRROR_TAG}`)
  })

  it('fails fast under requirePrebuilt rather than pulling inside a worker', async () => {
    // The mirror is a global-setup job; a worker pulling ~50MB mid-suite
    // would race every other worker for the same tag.
    vi.mocked(imageExists).mockResolvedValueOnce(false)
    await expect(ensureEnvoyImage(true)).rejects.toThrow(/is missing/)
  })
})

describe('ensureClaimNetd', () => {
  it('applies namespaced RBAC and the claim ConfigMap before the DaemonSet', async () => {
    vi.mocked(registryHasTag).mockResolvedValue(true)
    await ensureClaimNetd()
    const kinds = vi.mocked(kubectlApply).mock.calls
      .map((call) => (call[0] as { kind: string }).kind)
    expect(kinds).toEqual(['ServiceAccount', 'Role', 'RoleBinding', 'ConfigMap', 'DaemonSet'])
  })

  it('seeds the claim ConfigMap with no data, so a re-apply cannot clobber a claim', async () => {
    // netd publishes into this object; setup only guarantees it exists so
    // the DaemonSet's volume reference resolves on first schedule.
    vi.mocked(registryHasTag).mockResolvedValue(true)
    await ensureClaimNetd()
    const cm = vi.mocked(kubectlApply).mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((manifest) => manifest.kind === 'ConfigMap')!
    expect(cm.data).toBeUndefined()
  })

  it('mirrors no Envoy image — claim mode programs nothing', async () => {
    vi.mocked(registryHasTag).mockResolvedValue(true)
    await ensureClaimNetd()
    expect(clusterPodCidrs).not.toHaveBeenCalled()
    const applied = JSON.stringify(vi.mocked(kubectlApply).mock.calls)
    expect(applied).not.toContain('envoy')
  })

  it('waits for the rollout so a caller cannot proceed past a stuck claim netd', async () => {
    vi.mocked(registryHasTag).mockResolvedValue(true)
    await ensureClaimNetd()
    expect(kubectlWithRetry).toHaveBeenCalledWith(
      expect.arrayContaining(['rollout', 'status', `daemonset/${NETD_APP_NAME}`]),
      expect.anything(),
    )
  })
})
