import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'

vi.mock('#platform/k8s/kubectl', () => ({
  dataDirHash: vi.fn(() => 'ddh0123456789abc'),
  k8sNamespace: vi.fn(() => 'test-ns'),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

// ensureProxyResources(nested) registers the Cilium CRDs into the vcluster;
// no test here exercises the real CRD apply, so stub it out.
vi.mock('#platform/k8s/cilium-crds', () => ({
  ensureCiliumCrds: vi.fn().mockResolvedValue(undefined),
}))

import {
  DNS_STUB_PORT,
  EGRESS_REDIRECT_CEC_NAME,
  PROXY_APP_NAME,
  PROXY_AUTH_SECRET_NAME,
  PROXY_INGRESS_CNP_NAME,
  PROXY_PORT,
  PROXY_SA_NAME,
  SESSION_EGRESS_REDIRECT_CNP_NAME,
  SSH_TUNNEL_SENTINEL,
  TRANSPARENT_HTTP_PORT,
  TRANSPARENT_HTTPS_PORT,
  TRANSPARENT_TUNNEL_PORT,
  TUNNEL_INGRESS_PORT,
  buildEgressRedirectCecManifest,
  buildInnerEgressRedirectCecManifest,
  buildInnerSessionEgressRedirectCnpManifest,
  buildInnerProxyIngressCnpManifest,
  INNER_EGRESS_REDIRECT_CEC_NAME,
  INNER_SESSION_EGRESS_REDIRECT_CNP_NAME,
  INNER_PROXY_INGRESS_CNP_NAME,
  innerRedirectObjectName,
  LABEL_PROJECTION,
  PROJECTION_INNER_REDIRECT,
  buildVclusterFallbackRedirectCcecManifest,
  vclusterFallbackCcecName,
  buildVclusterFallbackRedirectCnpManifest,
  LABEL_ROLE,
  ROLE_INNER_PROXY,
  VCLUSTER_FALLBACK_REDIRECT_NAME,
  SESSION_REDIRECT_PRIORITY,
  VCLUSTER_FALLBACK_PRIORITY,
  buildOuterProxyCaConfigMapManifest,
  OUTER_CA_CONFIGMAP_NAME,
  buildProxyDeploymentManifest,
  buildProxyIngressCnpManifest,
  buildProxyRoleBindingManifest,
  buildProxyRoleManifest,
  buildProxyServiceAccountManifest,
  buildProxyServiceManifest,
  buildSessionEgressRedirectCnpManifest,
  buildEgressWorldDenyCiliumPolicyManifest,
  buildBuilderRoleGuardPolicyManifest,
  buildBuilderRoleGuardBindingManifest,
  BUILDER_ROLE_GUARD_NAME,
  EGRESS_WORLD_DENY_NAME,
  ensureCaConfigMap,
  ensureNamespace,
  ensureProxyAuthSecret,
  ensureProxyResources,
  proxyServiceClusterIp,
  proxyDataHostDir,
  sshAgentHostDir,
} from '#features/cluster/bootstrap'
import { kubectlApply, kubectlGetJson, kubectlWithRetry } from '#platform/k8s/kubectl'
import { CA_CERT_PATH } from '#platform/k8s/pod-spec'
import { LABEL_DATA_DIR_HASH, LABEL_VCLUSTER_MANAGED_BY } from '#platform/k8s/pods'
import { credentialsDir } from '@yaac/shared/project-paths'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

const mockApply = vi.mocked(kubectlApply)
const mockGetJson = vi.mocked(kubectlGetJson)
const mockRetry = vi.mocked(kubectlWithRetry)

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  mockApply.mockReset()
  mockApply.mockResolvedValue(undefined)
  mockGetJson.mockReset()
  mockRetry.mockReset()
  mockRetry.mockResolvedValue({ stdout: '', stderr: '' })
  vi.stubEnv('YAAC_USE_TOR', '')
})

afterEach(async () => {
  await cleanupTempDir(tmpDir)
  vi.unstubAllEnvs()
})

describe('constants', () => {
  it('expose the proxy app/secret names and in-cluster ports', () => {
    expect(PROXY_APP_NAME).toBe('yaac-proxy')
    expect(PROXY_AUTH_SECRET_NAME).toBe('yaac-proxy-auth')
    expect(PROXY_PORT).toBe(10255)
    expect(TRANSPARENT_HTTPS_PORT).toBe(10256)
    expect(TRANSPARENT_HTTP_PORT).toBe(10257)
    expect(TRANSPARENT_TUNNEL_PORT).toBe(10258)
  })
})

describe('sshAgentHostDir / proxyDataHostDir', () => {
  it('live under <dataDir>/run', () => {
    expect(sshAgentHostDir()).toBe(path.join(tmpDir, 'run', 'ssh-agent'))
    expect(proxyDataHostDir()).toBe(path.join(tmpDir, 'run', 'proxy-data'))
  })
})

describe('ensureNamespace', () => {
  it('applies a Namespace manifest for the active namespace', async () => {
    await ensureNamespace()
    expect(mockApply).toHaveBeenCalledWith({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: 'test-ns' },
    })
  })
})

describe('ensureProxyAuthSecret', () => {
  it('returns the decoded existing secret without re-applying', async () => {
    mockGetJson.mockResolvedValue({
      data: { secret: Buffer.from('existing-secret').toString('base64') },
    })
    await expect(ensureProxyAuthSecret()).resolves.toBe('existing-secret')
    expect(mockApply).not.toHaveBeenCalled()
  })

  it('generates, applies, and returns a fresh secret when none exists', async () => {
    mockGetJson.mockResolvedValue(null)
    const secret = await ensureProxyAuthSecret()
    // 32 random bytes hex-encoded.
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    expect(mockApply).toHaveBeenCalledTimes(1)
    const manifest = mockApply.mock.calls[0][0] as {
      kind: string
      metadata: { name: string; namespace: string }
      data: { secret: string }
    }
    expect(manifest.kind).toBe('Secret')
    expect(manifest.metadata).toEqual({ name: PROXY_AUTH_SECRET_NAME, namespace: 'test-ns' })
    expect(Buffer.from(manifest.data.secret, 'base64').toString('utf8')).toBe(secret)
  })
})

interface DeploymentManifest {
  kind: string
  metadata: { name: string; namespace: string; labels: Record<string, string> }
  spec: {
    replicas: number
    strategy: { type: string }
    selector: { matchLabels: Record<string, string> }
    template: {
      metadata: { labels: Record<string, string> }
      spec: {
        serviceAccountName?: string
        automountServiceAccountToken: boolean
        enableServiceLinks: boolean
        securityContext?: { runAsUser?: number; runAsGroup?: number; fsGroup?: number }
        containers: Array<{
          image: string
          securityContext?: { capabilities?: { add?: string[] } }
          ports: Array<{ containerPort: number; protocol?: string }>
          env: Array<Record<string, unknown>>
          readinessProbe: { httpGet: { path: string; port: number } }
          volumeMounts: Array<{ name: string; mountPath: string }>
        }>
        volumes: Array<{ name: string; hostPath?: { path: string; type: string }; emptyDir?: object }>
      }
    }
  }
}

describe('buildProxyDeploymentManifest', () => {
  function build(): DeploymentManifest {
    return buildProxyDeploymentManifest('localhost:5000/yaac-proxy:abc') as unknown as DeploymentManifest
  }

  it('runs one replica with the Recreate strategy (no socket-sharing overlap)', () => {
    const m = build()
    expect(m.kind).toBe('Deployment')
    expect(m.metadata.name).toBe(PROXY_APP_NAME)
    expect(m.metadata.namespace).toBe('test-ns')
    expect(m.spec.replicas).toBe(1)
    expect(m.spec.strategy).toEqual({ type: 'Recreate' })
    expect(m.spec.selector.matchLabels).toEqual({ app: PROXY_APP_NAME })
  })

  it('stamps the install identity on every proxy pod; nested adds yaac.role=inner-proxy (loop-free exclusion)', () => {
    const plain = buildProxyDeploymentManifest('img') as unknown as {
      spec: { template: { metadata: { labels: Record<string, string> } } }
    }
    expect(plain.spec.template.metadata.labels).toEqual({
      app: PROXY_APP_NAME, [LABEL_DATA_DIR_HASH]: 'ddh0123456789abc',
    })
    const nested = buildProxyDeploymentManifest('img', { nested: true }) as unknown as {
      spec: { template: { metadata: { labels: Record<string, string> } } }
    }
    expect(nested.spec.template.metadata.labels).toEqual({
      app: PROXY_APP_NAME,
      [LABEL_DATA_DIR_HASH]: 'ddh0123456789abc',
      [LABEL_ROLE]: ROLE_INNER_PROXY,
    })
  })

  it('stamps no RuntimeClass — trusted infra runs on runc (host and inner alike)', () => {
    const plain = build() as unknown as {
      spec: { template: { spec: { runtimeClassName?: string } } }
    }
    expect(plain.spec.template.spec.runtimeClassName).toBeUndefined()
    const nested = buildProxyDeploymentManifest('img', { nested: true }) as unknown as {
      spec: { template: { spec: { runtimeClassName?: string } } }
    }
    expect(nested.spec.template.spec.runtimeClassName).toBeUndefined()
  })

  it('nested (inner) proxy: resolves DNS via its own loopback stub, not vcluster CoreDNS', () => {
    const plain = build() as unknown as {
      spec: { template: { spec: { dnsPolicy?: string; dnsConfig?: unknown } } }
    }
    expect(plain.spec.template.spec.dnsPolicy).toBeUndefined()
    expect(plain.spec.template.spec.dnsConfig).toBeUndefined()
    const nested = buildProxyDeploymentManifest('img', { nested: true }) as unknown as {
      spec: { template: { spec: { dnsPolicy?: string; dnsConfig?: { nameservers: string[] } } } }
    }
    expect(nested.spec.template.spec.dnsPolicy).toBe('None')
    expect(nested.spec.template.spec.dnsConfig).toEqual({ nameservers: ['127.0.0.1'] })
  })

  it('nested (inner) proxy: trusts the outer CA via NODE_EXTRA_CA_CERTS + a projected ConfigMap mount', () => {
    // Top-level proxy reaches the world directly — no outer CA, no mount.
    const plain = build().spec.template.spec
    expect(plain.containers[0].env)
      .not.toContainEqual(expect.objectContaining({ name: 'NODE_EXTRA_CA_CERTS' }))
    expect(plain.volumes).not.toContainEqual(expect.objectContaining({ name: 'outer-ca' }))
    expect(plain.containers[0].volumeMounts)
      .not.toContainEqual(expect.objectContaining({ name: 'outer-ca' }))

    const nested = buildProxyDeploymentManifest('img', { nested: true }) as unknown as DeploymentManifest
    const nspec = nested.spec.template.spec
    expect(nspec.containers[0].env)
      .toContainEqual({ name: 'NODE_EXTRA_CA_CERTS', value: '/etc/yaac/outer-ca/proxy-ca.pem' })
    expect(nspec.volumes)
      .toContainEqual({ name: 'outer-ca', configMap: { name: OUTER_CA_CONFIGMAP_NAME } })
    expect(nspec.containers[0].volumeMounts)
      .toContainEqual({ name: 'outer-ca', mountPath: '/etc/yaac/outer-ca', readOnly: true })
  })

  it('wires the image, ports, auth secret env, and readiness probe', () => {
    const c = build().spec.template.spec.containers[0]
    expect(c.image).toBe('localhost:5000/yaac-proxy:abc')
    expect(c.ports).toEqual([
      { containerPort: PROXY_PORT },
      { containerPort: TRANSPARENT_HTTPS_PORT },
      { containerPort: TRANSPARENT_HTTP_PORT },
      { containerPort: TRANSPARENT_TUNNEL_PORT },
      { containerPort: DNS_STUB_PORT, protocol: 'UDP' },
    ])
    // NET_BIND_SERVICE lets the non-root proxy bind udp/53 for the DNS stub.
    expect(c.securityContext?.capabilities?.add).toEqual(['NET_BIND_SERVICE'])
    expect(c.env).toContainEqual({ name: 'DNS_STUB_PORT', value: String(DNS_STUB_PORT) })
    expect(c.env).toContainEqual({ name: 'API_PORT', value: String(PROXY_PORT) })
    expect(c.env).toContainEqual({ name: 'TRANSPARENT_HTTPS_PORT', value: String(TRANSPARENT_HTTPS_PORT) })
    expect(c.env).toContainEqual({ name: 'TRANSPARENT_HTTP_PORT', value: String(TRANSPARENT_HTTP_PORT) })
    expect(c.env).toContainEqual({ name: 'TRANSPARENT_TUNNEL_PORT', value: String(TRANSPARENT_TUNNEL_PORT) })
    expect(c.env).toContainEqual({
      name: 'PROXY_AUTH_SECRET',
      valueFrom: { secretKeyRef: { name: PROXY_AUTH_SECRET_NAME, key: 'secret' } },
    })
    // HOME points at the emptyDir mount so the proxy's known_hosts writer
    // works when it runs as the server uid (not the image's node user);
    // ssh-add itself gets the known_hosts path via -H, never from HOME.
    expect(c.env).toContainEqual({ name: 'HOME', value: '/home/proxy' })
    expect(c.readinessProbe.httpGet).toEqual({ path: '/healthz', port: PROXY_PORT })
  })

  it('mounts credentials, ssh-agent, and proxy-data hostPaths (DirectoryOrCreate)', () => {
    const spec = build().spec.template.spec
    // The proxy now mounts its SA token to watch pods (source-IP → session).
    expect(spec.serviceAccountName).toBe(PROXY_SA_NAME)
    expect(spec.automountServiceAccountToken).toBe(true)
    expect(spec.enableServiceLinks).toBe(false)
    expect(spec.volumes).toEqual([
      { name: 'credentials', hostPath: { path: credentialsDir(), type: 'DirectoryOrCreate' } },
      { name: 'ssh-agent', hostPath: { path: sshAgentHostDir(), type: 'DirectoryOrCreate' } },
      { name: 'proxy-data', hostPath: { path: proxyDataHostDir(), type: 'DirectoryOrCreate' } },
      { name: 'home', emptyDir: {} },
    ])
    expect(spec.containers[0].volumeMounts).toEqual([
      { name: 'credentials', mountPath: '/yaac-credentials' },
      { name: 'ssh-agent', mountPath: '/ssh-agent' },
      { name: 'proxy-data', mountPath: '/data' },
      { name: 'home', mountPath: '/home/proxy' },
    ])
  })

  it('runs as the server host uid with fsGroup for the emptyDir HOME', () => {
    const sc = build().spec.template.spec.securityContext
    expect(sc?.runAsUser).toBe(process.getuid?.())
    expect(sc?.runAsGroup).toBe(process.getgid?.())
    expect(sc?.fsGroup).toBe(process.getgid?.())
  })

  it('adds USE_TOR only when tor is enabled', () => {
    expect(build().spec.template.spec.containers[0].env)
      .not.toContainEqual({ name: 'USE_TOR', value: '1' })
    vi.stubEnv('YAAC_USE_TOR', '1')
    expect(build().spec.template.spec.containers[0].env)
      .toContainEqual({ name: 'USE_TOR', value: '1' })
  })
})

describe('buildEgressWorldDenyCiliumPolicyManifest', () => {
  interface Cnp {
    apiVersion: string
    kind: string
    metadata: { name: string; namespace: string; labels: Record<string, string> }
    spec: {
      endpointSelector: { matchExpressions: Array<{ key: string; operator: string; values?: string[] }> }
      egressDeny: Array<{ toEntities: string[] }>
    }
  }

  it('denies world for the whole install namespace except the proxy', () => {
    const m = buildEgressWorldDenyCiliumPolicyManifest() as unknown as Cnp
    expect(m.apiVersion).toBe('cilium.io/v2')
    expect(m.kind).toBe('CiliumNetworkPolicy')
    expect(m.metadata.name).toBe(EGRESS_WORLD_DENY_NAME)
    expect(m.metadata.namespace).toBe('test-ns')
    // Everything except the proxy (NotIn also matches no-app pods, so it
    // catches session pods, registries, mocks). The exemption label is
    // only settable by the trusted server on its own pods. Synced pods
    // live in their own per-session namespaces, denied there.
    // Excludes the proxy AND session pods — the latter are governed by the
    // redirect CNP, whose world:443/80 allow a world-deny here would beat.
    expect(m.spec.endpointSelector.matchExpressions)
      .toEqual([
        { key: 'app', operator: 'NotIn', values: ['yaac-proxy'] },
        { key: 'yaac.session-id', operator: 'DoesNotExist' },
        // Trust-split builder pods need direct egress (registry DNATs to a
        // kind-network IP = world; RUN steps fetch upstreams) and a Cilium
        // deny beats any allow — so they are carved out of the selector.
        { key: 'yaac.role', operator: 'NotIn', values: ['builder'] },
      ])
    expect(m.spec.egressDeny).toEqual([{ toEntities: ['world'] }])
  })

  it('exempts only the proxy, by an unforgeable trusted-server label', () => {
    const m = buildEgressWorldDenyCiliumPolicyManifest() as unknown as Cnp
    expect(m.spec.endpointSelector.matchExpressions[0].values).toEqual(['yaac-proxy'])
  })
})

describe('builder role guard (ValidatingAdmissionPolicy)', () => {
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

describe('buildProxyServiceManifest', () => {
  it('exposes a ClusterIP service on the proxy + transparent ports (port == targetPort)', () => {
    expect(buildProxyServiceManifest()).toEqual({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: PROXY_APP_NAME,
        namespace: 'test-ns',
        // The install identity rides the vcluster sync so the outer
        // projection can attribute a synced inner-proxy Service to its
        // inner install (findInnerProxyServices).
        labels: { app: PROXY_APP_NAME, [LABEL_DATA_DIR_HASH]: 'ddh0123456789abc' },
      },
      spec: {
        type: 'ClusterIP',
        // No pinned clusterIP: allocator-assigned, read live at pod-create.
        selector: { app: PROXY_APP_NAME },
        ports: [
          { name: 'proxy', port: PROXY_PORT, targetPort: PROXY_PORT },
          { name: 'transparent-https', port: TRANSPARENT_HTTPS_PORT, targetPort: TRANSPARENT_HTTPS_PORT },
          { name: 'transparent-http', port: TRANSPARENT_HTTP_PORT, targetPort: TRANSPARENT_HTTP_PORT },
          { name: 'transparent-tunnel', port: TRANSPARENT_TUNNEL_PORT, targetPort: TRANSPARENT_TUNNEL_PORT },
          { name: 'dns', port: DNS_STUB_PORT, targetPort: DNS_STUB_PORT, protocol: 'UDP' },
        ],
      },
    })
  })

  it('never pins the ClusterIP (the allocator assigns it)', () => {
    const m = buildProxyServiceManifest() as unknown as {
      spec: { clusterIP?: string; type: string }
    }
    expect(m.spec.type).toBe('ClusterIP')
    expect(m.spec.clusterIP).toBeUndefined()
  })
})

describe('proxyServiceClusterIp', () => {
  it('returns the live (vcluster-allocated) ClusterIP of the proxy Service', async () => {
    mockGetJson.mockResolvedValue({ spec: { clusterIP: '10.96.92.236' } })
    expect(await proxyServiceClusterIp()).toBe('10.96.92.236')
  })

  it('throws if the Service has no ClusterIP yet', async () => {
    mockGetJson.mockResolvedValue({ spec: {} })
    await expect(proxyServiceClusterIp()).rejects.toThrow(/ClusterIP/)
  })
})

describe('buildEgressRedirectCecManifest', () => {
  interface Cec {
    apiVersion: string
    kind: string
    metadata: { name: string; namespace: string; annotations: Record<string, string> }
    spec: {
      backendServices: Array<{ name: string; namespace: string; number: string[] }>
      resources: Array<Record<string, unknown>>
    }
  }
  it('is an annotated CEC with three listener+cluster pairs to the proxy', () => {
    const m = buildEgressRedirectCecManifest() as unknown as Cec
    expect(m.apiVersion).toBe('cilium.io/v2')
    expect(m.kind).toBe('CiliumEnvoyConfig')
    expect(m.metadata.name).toBe(EGRESS_REDIRECT_CEC_NAME)
    // The load-bearing annotation: without it Cilium binds the upstream to
    // the client pod IP and forwarding to a fixed proxy dead-ends.
    expect(m.metadata.annotations['cec.cilium.io/use-original-source-address']).toBe('false')
    const listeners = m.spec.resources.filter(
      (r) => String(r['@type']).endsWith('v3.Listener'),
    )
    const clusters = m.spec.resources.filter(
      (r) => String(r['@type']).endsWith('v3.Cluster'),
    )
    expect(listeners).toHaveLength(3)
    expect(clusters).toHaveLength(3)
  })

  it('resolves each upstream via an EDS cluster backed by the proxy Service port, with proxy-protocol v2', () => {
    const m = buildEgressRedirectCecManifest() as unknown as Cec
    const ns = 'test-ns'
    // backendServices is what makes EDS resolve: Cilium syncs the proxy
    // Service's endpoints (for these port numbers) into the clusters.
    expect(m.spec.backendServices).toEqual([{
      name: 'yaac-proxy',
      namespace: ns,
      number: [
        String(TRANSPARENT_HTTPS_PORT),
        String(TRANSPARENT_HTTP_PORT),
        String(TRANSPARENT_TUNNEL_PORT),
      ],
    }])
    const clusters = m.spec.resources.filter(
      (r) => String(r['@type']).endsWith('v3.Cluster'),
    ) as Array<{
      name: string
      type: string
      transportSocket: { name: string; typedConfig: { config: { version: string } } }
    }>
    // EDS (not a static ClusterIP endpoint): the node-local Envoy makes
    // upstream connections from the host netns, which do not traverse
    // kube-proxy ClusterIP DNAT — a static ClusterIP dead-ends on connect.
    // Cluster names must match `<ns>/<service>:<port>` for backendServices.
    expect(clusters.map((c) => ({ name: c.name, type: c.type }))).toEqual([
      { name: `${ns}/yaac-proxy:${TRANSPARENT_HTTPS_PORT}`, type: 'EDS' },
      { name: `${ns}/yaac-proxy:${TRANSPARENT_HTTP_PORT}`, type: 'EDS' },
      { name: `${ns}/yaac-proxy:${TRANSPARENT_TUNNEL_PORT}`, type: 'EDS' },
    ])
    for (const c of clusters) {
      expect(c.transportSocket.name).toBe('envoy.transport_sockets.upstream_proxy_protocol')
      expect(c.transportSocket.typedConfig.config.version).toBe('V2')
    }
  })
})

describe('buildSessionEgressRedirectCnpManifest', () => {
  interface Cnp {
    metadata: { name: string }
    spec: {
      endpointSelector: { matchExpressions: Array<{ key: string; operator: string }> }
      egress: Array<{
        toEntities?: string[]
        toCIDRSet?: Array<{ cidr: string }>
        toEndpoints?: Array<{ matchLabels: Record<string, string> }>
        toPorts: Array<{ ports: Array<{ port: string; protocol: string }>; listener?: { envoyConfig: { name: string }; name: string } }>
      }>
    }
  }
  it('default-denies session egress except 443/80→Envoy, the SSH sentinel, and DNS', () => {
    const m = buildSessionEgressRedirectCnpManifest() as unknown as Cnp
    expect(m.metadata.name).toBe(SESSION_EGRESS_REDIRECT_CNP_NAME)
    expect(m.spec.endpointSelector.matchExpressions)
      .toEqual([{ key: 'yaac.session-id', operator: 'Exists' }])

    const [https, http, ssh, dns] = m.spec.egress
    expect(https.toEntities).toEqual(['world'])
    expect(https.toPorts[0].ports[0]).toEqual({ port: '443', protocol: 'TCP' })
    expect(https.toPorts[0].listener?.name).toBe('yaac-egress-https')
    expect(https.toPorts[0].listener?.envoyConfig.name).toBe(EGRESS_REDIRECT_CEC_NAME)

    expect(http.toPorts[0].ports[0]).toEqual({ port: '80', protocol: 'TCP' })
    expect(http.toPorts[0].listener?.name).toBe('yaac-egress-http')

    expect(ssh.toCIDRSet).toEqual([{ cidr: `${SSH_TUNNEL_SENTINEL}/32` }])
    expect(ssh.toPorts[0].ports[0]).toEqual({ port: String(TUNNEL_INGRESS_PORT), protocol: 'TCP' })
    expect(ssh.toPorts[0].listener?.name).toBe('yaac-egress-tunnel')

    // DNS goes straight to the proxy stub (no Envoy listener).
    expect(dns.toEndpoints).toEqual([{ matchLabels: { app: PROXY_APP_NAME } }])
    expect(dns.toPorts[0].ports[0]).toEqual({ port: String(DNS_STUB_PORT), protocol: 'UDP' })
    expect(dns.toPorts[0].listener).toBeUndefined()
  })

  it('has NO blanket in-cluster allowance — registry/vcluster flows come from scoped NetworkPolicies', () => {
    const m = buildSessionEgressRedirectCnpManifest() as unknown as Cnp
    // Exactly the four redirect/DNS rules. The old install-wide 5000/8443
    // carve-out (toEndpoints [{}]) let any session reach any project's
    // registry and any session's vcluster API (issue #17); those flows are
    // now admitted only by the per-project registry NetworkPolicy and the
    // per-session vcluster NetworkPolicy, unioned over this default-deny.
    expect(m.spec.egress).toHaveLength(4)
    for (const rule of m.spec.egress) {
      expect(rule.toEndpoints ?? []).not.toContainEqual({})
    }
  })
})

describe('buildProxyIngressCnpManifest', () => {
  interface Cnp {
    metadata: { name: string }
    spec: {
      endpointSelector: { matchLabels: Record<string, string> }
      ingress: Array<{
        fromEntities?: string[]
        fromEndpoints?: Array<{ matchExpressions: Array<{ key: string; operator: string }> }>
        toPorts: Array<{ ports: Array<{ port: string; protocol: string }> }>
      }>
    }
  }
  it('keeps the control API host-only and opens transparent+DNS to session pods', () => {
    const m = buildProxyIngressCnpManifest() as unknown as Cnp
    expect(m.metadata.name).toBe(PROXY_INGRESS_CNP_NAME)
    expect(m.spec.endpointSelector.matchLabels).toEqual({ app: PROXY_APP_NAME })

    const [host, session] = m.spec.ingress
    // Control API (session registration + readiness probe): host only.
    expect(host.fromEntities).toEqual(['host'])
    expect(host.toPorts[0].ports).toEqual([{ port: String(PROXY_PORT), protocol: 'TCP' }])

    // The redirected egress arrives with the session pod's identity (Cilium
    // preserves it through the Envoy proxy), so the transparent listeners +
    // DNS stub open to the session-id selector. The forgery lock is on the
    // egress side (a direct dial never leaves the pod), not here.
    expect(session.fromEndpoints?.[0].matchExpressions)
      .toEqual([{ key: 'yaac.session-id', operator: 'Exists' }])
    expect(session.toPorts[0].ports).toEqual([
      { port: String(TRANSPARENT_HTTPS_PORT), protocol: 'TCP' },
      { port: String(TRANSPARENT_HTTP_PORT), protocol: 'TCP' },
      { port: String(TRANSPARENT_TUNNEL_PORT), protocol: 'TCP' },
      { port: String(DNS_STUB_PORT), protocol: 'UDP' },
    ])
  })

  it('admits a vcluster chained hop on the transparent ports cross-namespace (no DNS)', () => {
    const m = buildProxyIngressCnpManifest() as unknown as Cnp
    // yaac-in-yaac: an inner proxy's upstream dials (and pre-opt-in synced pods)
    // chain to THIS proxy via the fallback redirect, arriving with the syncer's
    // `managed-by` label from another namespace — admit them cross-namespace.
    const chain = m.spec.ingress[2]
    expect(chain.fromEndpoints?.[0].matchExpressions).toEqual([
      { key: 'vcluster.loft.sh/managed-by', operator: 'Exists' },
      { key: 'k8s:io.kubernetes.pod.namespace', operator: 'Exists' },
    ])
    // Transparent TCP only — the inner proxy sinkholes DNS via its own stub, so
    // no 53 reaches the outer proxy from a vcluster pod.
    expect(chain.toPorts[0].ports).toEqual([
      { port: String(TRANSPARENT_HTTPS_PORT), protocol: 'TCP' },
      { port: String(TRANSPARENT_HTTP_PORT), protocol: 'TCP' },
      { port: String(TRANSPARENT_TUNNEL_PORT), protocol: 'TCP' },
    ])
  })
})

describe('proxy ServiceAccount + RBAC', () => {
  it('creates a SA and a read-only pods Role bound to it', () => {
    expect(buildProxyServiceAccountManifest()).toEqual({
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name: PROXY_SA_NAME, namespace: 'test-ns', labels: { app: PROXY_APP_NAME } },
    })
    const role = buildProxyRoleManifest() as { rules: Array<{ apiGroups: string[]; resources: string[]; verbs: string[] }> }
    expect(role.rules).toEqual([{ apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'watch'] }])
    const rb = buildProxyRoleBindingManifest() as {
      roleRef: { kind: string; name: string }
      subjects: Array<{ kind: string; name: string; namespace: string }>
    }
    expect(rb.roleRef).toEqual({ apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: PROXY_SA_NAME })
    expect(rb.subjects).toEqual([{ kind: 'ServiceAccount', name: PROXY_SA_NAME, namespace: 'test-ns' }])
  })
})

describe('ensureProxyResources', () => {
  it('pre-creates host dirs, applies both manifests, and waits for the rollout', async () => {
    mockGetJson.mockResolvedValue(null) // no live Service yet
    await ensureProxyResources('localhost:5000/yaac-proxy:abc')

    // Host dirs exist (DirectoryOrCreate would have made them root-owned).
    await expect(fs.stat(credentialsDir())).resolves.toBeDefined()
    await expect(fs.stat(sshAgentHostDir())).resolves.toBeDefined()
    await expect(fs.stat(proxyDataHostDir())).resolves.toBeDefined()

    const kinds = mockApply.mock.calls.map((c) => (c[0] as { kind: string }).kind)
    expect(kinds).toEqual([
      'ServiceAccount', 'Role', 'RoleBinding', 'Deployment', 'Service',
      'CiliumEnvoyConfig', 'CiliumNetworkPolicy', 'CiliumClusterwideEnvoyConfig',
      'CiliumNetworkPolicy', 'CiliumNetworkPolicy',
    ])
    // The proxy Service ClusterIP is allocator-assigned and never deleted —
    // no pin migration, so ensureProxyResources issues no `delete service`.
    expect(mockRetry).not.toHaveBeenCalledWith(
      expect.arrayContaining(['delete', 'service']),
    )
    expect(mockRetry).toHaveBeenCalledWith(
      [
        'rollout', 'status', `deployment/${PROXY_APP_NAME}`,
        '-n', 'test-ns',
        '--timeout=180s',
      ],
      expect.objectContaining({ maxAttempts: 2 }),
    )
  })

  it('nested: projects the outer CA ConfigMap (read from CA_CERT_PATH) before the Deployment', async () => {
    mockGetJson.mockResolvedValue(null)
    // mockRestore() also clears the call record, so assert before restoring.
    const readSpy = vi.spyOn(fs, 'readFile').mockResolvedValue('OUTER-CA-PEM')
    await ensureProxyResources('img', { nested: true })
    // The outer CA is read from the inner yaac's own session-pod trust mount.
    expect(readSpy).toHaveBeenCalledWith(CA_CERT_PATH, 'utf8')
    const cmCall = mockApply.mock.calls.find(
      (c) => (c[0] as { kind: string }).kind === 'ConfigMap',
    )
    expect(cmCall?.[0]).toEqual({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: OUTER_CA_CONFIGMAP_NAME, namespace: 'test-ns' },
      data: { 'proxy-ca.pem': 'OUTER-CA-PEM' },
    })
    // Applied before the Deployment so the configMap mount resolves on first
    // schedule (a missing source would keep the pod ContainerCreating).
    const kinds = mockApply.mock.calls.map((c) => (c[0] as { kind: string }).kind)
    expect(kinds.indexOf('ConfigMap')).toBeLessThan(kinds.indexOf('Deployment'))
    // The cluster-scoped fallback CCEC is HOST-ONLY: the nested vcluster has no
    // CiliumClusterwideEnvoyConfig CRD (ensureCiliumCrds installs only CEC/CNP),
    // and a nested yaac creates no vcluster sessions to reference it.
    expect(kinds).not.toContain('CiliumClusterwideEnvoyConfig')
    readSpy.mockRestore()
  })
})

describe('buildOuterProxyCaConfigMapManifest', () => {
  it('wraps the outer CA PEM under proxy-ca.pem in the install namespace', () => {
    expect(buildOuterProxyCaConfigMapManifest('OUTER-PEM')).toEqual({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: OUTER_CA_CONFIGMAP_NAME, namespace: 'test-ns' },
      data: { 'proxy-ca.pem': 'OUTER-PEM' },
    })
  })
})

describe('ensureCaConfigMap', () => {
  it('skips the apply only when both the CA and the bundle already match', async () => {
    mockGetJson.mockResolvedValue({
      data: { 'proxy-ca.pem': 'PEM-CONTENT', 'ca-bundle.pem': 'BUNDLE' },
    })
    await ensureCaConfigMap('PEM-CONTENT', 'BUNDLE')
    expect(mockApply).not.toHaveBeenCalled()
  })

  it('applies the ConfigMap with both keys when absent or stale', async () => {
    mockGetJson.mockResolvedValue(null)
    await ensureCaConfigMap('NEW-PEM', 'NEW-BUNDLE')
    expect(mockApply).toHaveBeenCalledWith({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'yaac-proxy-ca', namespace: 'test-ns' },
      data: { 'proxy-ca.pem': 'NEW-PEM', 'ca-bundle.pem': 'NEW-BUNDLE' },
    })

    mockApply.mockClear()
    mockGetJson.mockResolvedValue({ data: { 'proxy-ca.pem': 'OLD-PEM' } })
    await ensureCaConfigMap('NEW-PEM', 'NEW-BUNDLE')
    expect(mockApply).toHaveBeenCalledTimes(1)
  })

  it('re-applies when the CA matches but the bundle drifted (e.g. roots refresh)', async () => {
    mockGetJson.mockResolvedValue({
      data: { 'proxy-ca.pem': 'SAME', 'ca-bundle.pem': 'OLD-BUNDLE' },
    })
    await ensureCaConfigMap('SAME', 'NEW-BUNDLE')
    expect(mockApply).toHaveBeenCalledTimes(1)
  })
})

describe('inner-redirect builders (yaac-in-yaac projection)', () => {
  const VC_NS = 'yaac-vc-abcd1234'
  const VC_NAME = 'yvc-abcd1234'
  const INNER_SVC = 'yaac-proxy-x-yaac-x-yvc-abcd1234' // vcluster-translated name
  const INSTALL = 'fedcba9876543210' // the inner install's data-dir-hash

  it('inner CEC: per-install name, EDS-backed by the inner proxy Service, in the vcluster namespace', () => {
    const m = buildInnerEgressRedirectCecManifest(VC_NS, INNER_SVC, INSTALL) as unknown as {
      metadata: { name: string; namespace: string; labels: Record<string, string>; annotations: Record<string, string> }
      spec: {
        backendServices: Array<{ name: string; namespace: string; number: string[] }>
        resources: Array<{ '@type': string; name?: string; type?: string }>
      }
    }
    expect(m.metadata.name).toBe(`${INNER_EGRESS_REDIRECT_CEC_NAME}-${INSTALL}`)
    expect(m.metadata.name).toBe(innerRedirectObjectName(INNER_EGRESS_REDIRECT_CEC_NAME, INSTALL))
    expect(m.metadata.namespace).toBe(VC_NS)
    // Projection + install labels: the reconcile prune pass lists by these.
    expect(m.metadata.labels).toEqual({
      app: PROXY_APP_NAME,
      [LABEL_PROJECTION]: PROJECTION_INNER_REDIRECT,
      [LABEL_DATA_DIR_HASH]: INSTALL,
    })
    expect(m.metadata.annotations['cec.cilium.io/use-original-source-address']).toBe('false')
    expect(m.spec.backendServices).toEqual([{
      name: INNER_SVC,
      namespace: VC_NS,
      number: [String(TRANSPARENT_HTTPS_PORT), String(TRANSPARENT_HTTP_PORT), String(TRANSPARENT_TUNNEL_PORT)],
    }])
    const clusters = m.spec.resources.filter((r) => String(r['@type']).endsWith('v3.Cluster'))
    expect(clusters.map((c) => ({ name: c.name, type: c.type }))).toEqual([
      { name: `${VC_NS}/${INNER_SVC}:${TRANSPARENT_HTTPS_PORT}`, type: 'EDS' },
      { name: `${VC_NS}/${INNER_SVC}:${TRANSPARENT_HTTP_PORT}`, type: 'EDS' },
      { name: `${VC_NS}/${INNER_SVC}:${TRANSPARENT_TUNNEL_PORT}`, type: 'EDS' },
    ])
  })

  it('inner override CNP: managed-by AND own install AND not inner-proxy, listeners at the normal priority', () => {
    const m = buildInnerSessionEgressRedirectCnpManifest(VC_NS, VC_NAME, INSTALL) as unknown as {
      metadata: { name: string; namespace: string; labels: Record<string, string> }
      spec: {
        endpointSelector: { matchExpressions: Array<{ key: string; operator: string; values: string[] }> }
        egress: Array<{ toPorts: Array<{ ports: Array<{ port: string }>; listener?: { envoyConfig: { name: string }; name: string; priority?: number } }> }>
      }
    }
    expect(m.metadata.name).toBe(`${INNER_SESSION_EGRESS_REDIRECT_CNP_NAME}-${INSTALL}`)
    expect(m.metadata.namespace).toBe(VC_NS)
    expect(m.metadata.labels).toEqual({
      app: PROXY_APP_NAME,
      [LABEL_PROJECTION]: PROJECTION_INNER_REDIRECT,
      [LABEL_DATA_DIR_HASH]: INSTALL,
    })
    // Scope: this vcluster's synced pods OF THIS INSTALL, excluding the inner
    // proxy (loop-free). Pods without an install label (e.g. test mocks) stay
    // on the fallback.
    expect(m.spec.endpointSelector.matchExpressions).toEqual([
      { key: LABEL_VCLUSTER_MANAGED_BY, operator: 'In', values: [VC_NAME] },
      { key: LABEL_DATA_DIR_HASH, operator: 'In', values: [INSTALL] },
      { key: LABEL_ROLE, operator: 'NotIn', values: [ROLE_INNER_PROXY] },
    ])
    // Routing-only override: just the 3 world redirects (HTTPS, HTTP, tunnel).
    // Intracluster + DNS come from the fallback (the inner proxy's DNS stub is a
    // managed-by sibling there), so no DNS rule lives here.
    expect(m.spec.egress).toHaveLength(3)
    const listeners = m.spec.egress.map((e) => e.toPorts[0].listener).filter(Boolean)
    expect(listeners).toHaveLength(3)
    // Every redirect listener targets the install's OWN inner CEC at the
    // NORMAL priority (same value any yaac uses — transparent), which beats
    // the outer fallback.
    for (const l of listeners) {
      expect(l?.envoyConfig.name).toBe(`${INNER_EGRESS_REDIRECT_CEC_NAME}-${INSTALL}`)
      expect(l?.priority).toBe(SESSION_REDIRECT_PRIORITY)
    }
  })

  it('inner proxy-ingress CNP: control host-only, transparent ports to managed-by pods', () => {
    const m = buildInnerProxyIngressCnpManifest(VC_NS, VC_NAME) as unknown as {
      metadata: { name: string; namespace: string; labels: Record<string, string> }
      spec: {
        endpointSelector: { matchLabels: Record<string, string> }
        ingress: Array<{
          fromEntities?: string[]
          fromEndpoints?: Array<{ matchExpressions: Array<{ key: string; operator: string; values: string[] }> }>
          toPorts: Array<{ ports: Array<{ port: string; protocol: string }> }>
        }>
      }
    }
    // Shared per vcluster (unsuffixed): it selects EVERY install's inner proxy
    // and its rules are install-independent. Carries the projection label (no
    // install hash) so the prune pass removes it once no proxy remains.
    expect(m.metadata.name).toBe(INNER_PROXY_INGRESS_CNP_NAME)
    expect(m.metadata.labels).toEqual({
      app: PROXY_APP_NAME,
      [LABEL_PROJECTION]: PROJECTION_INNER_REDIRECT,
    })
    expect(m.spec.endpointSelector.matchLabels).toEqual({ [LABEL_ROLE]: ROLE_INNER_PROXY })
    const [host, session] = m.spec.ingress
    expect(host.fromEntities).toEqual(['host'])
    expect(host.toPorts[0].ports).toEqual([{ port: String(PROXY_PORT), protocol: 'TCP' }])
    expect(session.fromEndpoints?.[0].matchExpressions)
      .toEqual([{ key: LABEL_VCLUSTER_MANAGED_BY, operator: 'In', values: [VC_NAME] }])
    expect(session.toPorts[0].ports.map((p) => p.port)).toEqual([
      String(TRANSPARENT_HTTPS_PORT), String(TRANSPARENT_HTTP_PORT),
      String(TRANSPARENT_TUNNEL_PORT), String(DNS_STUB_PORT),
    ])
  })

  it('fallback CCEC: cluster-scoped (no namespace), install-scoped name, EDS → outer proxy', () => {
    const m = buildVclusterFallbackRedirectCcecManifest() as unknown as {
      kind: string
      metadata: { name: string; namespace?: string; labels: Record<string, string> }
      spec: {
        backendServices: Array<{ name: string; namespace: string }>
        resources: Array<{ '@type': string; name?: string }>
      }
    }
    // Cluster-scoped: a CCEC so a per-vcluster CNP can reference it cross-ns.
    expect(m.kind).toBe('CiliumClusterwideEnvoyConfig')
    expect(m.metadata.namespace).toBeUndefined()
    // Name + label are install-scoped so the real install and ephemeral
    // yaac-test-* installs don't collide on the global CCEC name.
    expect(m.metadata.name).toBe(vclusterFallbackCcecName('test-ns'))
    expect(m.metadata.name).toBe('yaac-vcluster-fallback-redirect-test-ns')
    expect(m.metadata.labels['yaac.install-namespace']).toBe('test-ns')
    // EDS-resolves the OUTER proxy (k8sNamespace=test-ns).
    expect(m.spec.backendServices[0]).toMatchObject({ name: 'yaac-proxy', namespace: 'test-ns' })
    const clusters = m.spec.resources.filter((r) => String(r['@type']).endsWith('v3.Cluster'))
    expect(clusters[0].name).toBe(`test-ns/yaac-proxy:${TRANSPARENT_HTTPS_PORT}`)
  })

  it('fallback CNP: ALL managed-by pods → outer proxy (low precedence) + intracluster', () => {
    const m = buildVclusterFallbackRedirectCnpManifest(VC_NS, VC_NAME) as unknown as {
      metadata: { name: string; namespace: string }
      spec: {
        endpointSelector: { matchExpressions: Array<{ key: string; operator: string; values: string[] }> }
        egress: Array<{
          toEntities?: string[]
          toEndpoints?: Array<{ matchLabels?: Record<string, string>; matchExpressions?: Array<{ key: string; operator: string; values: string[] }> }>
          toPorts?: Array<{ ports: Array<{ port: string; protocol: string }>; listener?: { envoyConfig: { kind: string; name: string }; priority?: number } }>
        }>
      }
    }
    expect(m.metadata.name).toBe(VCLUSTER_FALLBACK_REDIRECT_NAME)
    expect(m.metadata.namespace).toBe(VC_NS)
    // ALL synced pods (no inner-proxy exclusion — the inner proxy chains here).
    expect(m.spec.endpointSelector.matchExpressions).toEqual([
      { key: LABEL_VCLUSTER_MANAGED_BY, operator: 'In', values: [VC_NAME] },
    ])
    // The 3 world redirects target the SHARED cluster-scoped fallback CCEC
    // (referenced by kind, cross-namespace) at the LOW precedence.
    const listeners = m.spec.egress.flatMap((e) => e.toPorts ?? []).map((p) => p.listener).filter(Boolean)
    expect(listeners).toHaveLength(3)
    for (const l of listeners) {
      expect(l?.envoyConfig.kind).toBe('CiliumClusterwideEnvoyConfig')
      expect(l?.envoyConfig.name).toBe(vclusterFallbackCcecName('test-ns'))
      expect(l?.priority).toBe(VCLUSTER_FALLBACK_PRIORITY)
    }
    // The fallback must lose to a normal-priority inner override.
    expect(VCLUSTER_FALLBACK_PRIORITY).toBeGreaterThan(SESSION_REDIRECT_PRIORITY)
    // Intracluster (folded in from the deleted k8s synced-pods NetworkPolicy):
    // the vcluster API (control-plane pod on 8443) + any sibling synced pod.
    const api = m.spec.egress.find((e) =>
      e.toEndpoints?.[0].matchLabels?.app === 'vcluster' && !e.toPorts?.[0].listener)
    expect(api?.toEndpoints?.[0].matchLabels).toEqual({ app: 'vcluster', release: VC_NAME })
    expect(api?.toPorts?.[0].ports).toEqual([{ port: '8443', protocol: 'TCP' }])
    const siblings = m.spec.egress.find((e) =>
      e.toEndpoints?.[0].matchExpressions && !e.toPorts)
    expect(siblings?.toEndpoints?.[0].matchExpressions).toEqual([
      { key: LABEL_VCLUSTER_MANAGED_BY, operator: 'In', values: [VC_NAME] },
    ])
  })
})
