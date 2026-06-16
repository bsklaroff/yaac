import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'

vi.mock('@/lib/k8s/kubectl', () => ({
  k8sNamespace: vi.fn(() => 'test-ns'),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

vi.mock('@/lib/git', async (importOriginal) => {
  const actual = await importOriginal<typeof gitModule>()
  return {
    ...actual,
    isTorEnabled: vi.fn(() => false),
  }
})

import {
  CLUSTER_SERVICE_CIDR,
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
  buildProxyDeploymentManifest,
  buildProxyIngressCnpManifest,
  buildProxyRoleBindingManifest,
  buildProxyRoleManifest,
  buildProxyServiceAccountManifest,
  buildProxyServiceManifest,
  buildSessionEgressRedirectCnpManifest,
  buildEgressWorldDenyCiliumPolicyManifest,
  clusterIpForNamespace,
  clusterIpForService,
  EGRESS_WORLD_DENY_NAME,
  ensureCaConfigMap,
  ensureNamespace,
  ensureProxyAuthSecret,
  ensureProxyResources,
  proxyDataHostDir,
  sshAgentHostDir,
} from '@/lib/k8s/bootstrap'
import { kubectlApply, kubectlGetJson, kubectlWithRetry } from '@/lib/k8s/kubectl'
import { isTorEnabled } from '@/lib/git'
import { credentialsDir } from '@/lib/project/paths'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import type * as gitModule from '@/lib/git'

const mockApply = vi.mocked(kubectlApply)
const mockGetJson = vi.mocked(kubectlGetJson)
const mockRetry = vi.mocked(kubectlWithRetry)
const mockTor = vi.mocked(isTorEnabled)

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  mockApply.mockReset()
  mockApply.mockResolvedValue(undefined)
  mockGetJson.mockReset()
  mockRetry.mockReset()
  mockRetry.mockResolvedValue({ stdout: '', stderr: '' })
  mockTor.mockReturnValue(false)
})

afterEach(async () => {
  await cleanupTempDir(tmpDir)
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

  it('pin the VIP-pin service CIDR to the kind-config value', () => {
    expect(CLUSTER_SERVICE_CIDR).toBe('10.96.0.0/16')
  })
})

describe('clusterIpForNamespace', () => {
  it('is deterministic — Service recreation reproduces the identical VIP', () => {
    expect(clusterIpForNamespace('test-ns')).toBe(clusterIpForNamespace('test-ns'))
    expect(clusterIpForNamespace('test-ns')).toBe('10.96.40.19')
    expect(clusterIpForNamespace('yaac')).toBe('10.96.220.80')
  })

  it('stays inside the service /16, skipping the low 16 and the broadcast edge', () => {
    // offset (3rd*256 + 4th octet) must land in [16, 65519] of the /16.
    for (let i = 0; i < 2000; i++) {
      const octets = clusterIpForNamespace(`yaac-test-${i}`).split('.').map(Number)
      expect(octets.slice(0, 2)).toEqual([10, 96])
      const offset = octets[2] * 256 + octets[3]
      expect(offset).toBeGreaterThanOrEqual(16)
      expect(offset).toBeLessThanOrEqual(65519)
    }
  })

  it('can never collide with the apiserver (10.96.0.1) or kube-dns (10.96.0.10)', () => {
    // Both live in the skipped low 16, so no namespace can hash onto them.
    for (let i = 0; i < 5000; i++) {
      const ip = clusterIpForNamespace(`ns-${i}`)
      expect(ip).not.toBe('10.96.0.1')
      expect(ip).not.toBe('10.96.0.10')
    }
  })

  it('uses the wide band — distinct namespaces spread across many /24s', () => {
    const thirdOctets = new Set<number>()
    for (let i = 0; i < 500; i++) {
      thirdOctets.add(Number(clusterIpForNamespace(`ns-${i}`).split('.')[2]))
    }
    // A single-/24 band would collapse all of these to third octet 0; the
    // /16 band must spread them across well over a dozen distinct /24s.
    expect(thirdOctets.size).toBeGreaterThan(50)
    expect(clusterIpForNamespace('test-ns')).not.toBe(clusterIpForNamespace('other-ns'))
  })
})

describe('clusterIpForService', () => {
  it('is deterministic and FROZEN — recreation must reproduce the VIP', () => {
    expect(clusterIpForService('test-ns', 'yaac-reg-demo-12345678'))
      .toBe(clusterIpForService('test-ns', 'yaac-reg-demo-12345678'))
    // Pinned values: baked into running pods' iptables carve-outs,
    // hostAliases, and node hosts.toml — a hash change would strand them.
    expect(clusterIpForService('yaac', 'yaac-reg-demo-12345678')).toBe('10.96.92.178')
  })

  it('keys on both namespace and service name', () => {
    expect(clusterIpForService('ns-a', 'svc')).not.toBe(clusterIpForService('ns-b', 'svc'))
    expect(clusterIpForService('ns-a', 'svc')).not.toBe(clusterIpForService('ns-a', 'svc2'))
  })

  it('cannot alias the proxy pin (namespace names cannot contain "/")', () => {
    expect(clusterIpForService('test-ns', 'x')).not.toBe(clusterIpForNamespace('test-ns'))
  })

  it('stays inside the service /16, skipping the low 16 and the broadcast edge', () => {
    for (let i = 0; i < 2000; i++) {
      const octets = clusterIpForService('yaac', `svc-${i}`).split('.').map(Number)
      expect(octets.slice(0, 2)).toEqual([10, 96])
      const offset = octets[2] * 256 + octets[3]
      expect(offset).toBeGreaterThanOrEqual(16)
      expect(offset).toBeLessThanOrEqual(65519)
    }
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
    // HOME points at the emptyDir mount so ssh-add/known_hosts work when
    // the proxy runs as the daemon uid (not the image's node user).
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

  it('runs as the daemon host uid with fsGroup for the emptyDir HOME', () => {
    const sc = build().spec.template.spec.securityContext
    expect(sc?.runAsUser).toBe(process.getuid?.())
    expect(sc?.runAsGroup).toBe(process.getgid?.())
    expect(sc?.fsGroup).toBe(process.getgid?.())
  })

  it('adds USE_TOR only when tor is enabled', () => {
    expect(build().spec.template.spec.containers[0].env)
      .not.toContainEqual({ name: 'USE_TOR', value: '1' })
    mockTor.mockReturnValue(true)
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
    // only settable by the trusted daemon on its own pods. Synced pods
    // live in their own per-session namespaces, denied there.
    // Excludes the proxy AND session pods — the latter are governed by the
    // redirect CNP, whose world:443/80 allow a world-deny here would beat.
    expect(m.spec.endpointSelector.matchExpressions)
      .toEqual([
        { key: 'app', operator: 'NotIn', values: ['yaac-proxy'] },
        { key: 'yaac.session-id', operator: 'DoesNotExist' },
      ])
    expect(m.spec.egressDeny).toEqual([{ toEntities: ['world'] }])
  })

  it('exempts only the proxy, by an unforgeable trusted-daemon label', () => {
    const m = buildEgressWorldDenyCiliumPolicyManifest() as unknown as Cnp
    expect(m.spec.endpointSelector.matchExpressions[0].values).toEqual(['yaac-proxy'])
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
        labels: { app: PROXY_APP_NAME },
      },
      spec: {
        type: 'ClusterIP',
        // Pinned per namespace: session relays dial this VIP from env.
        clusterIP: clusterIpForNamespace('test-ns'),
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

  it('admits in-cluster registry (5000) + vcluster API (8443) for vcluster sessions, un-MITM\'d', () => {
    const m = buildSessionEgressRedirectCnpManifest() as unknown as Cnp
    const inCluster = m.spec.egress[4]
    expect(inCluster.toEndpoints).toEqual([{}])
    expect(inCluster.toPorts[0].ports).toEqual([
      { port: '5000', protocol: 'TCP' },
      { port: '8443', protocol: 'TCP' },
    ])
    expect(inCluster.toPorts[0].listener).toBeUndefined()
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
      'CiliumEnvoyConfig', 'CiliumNetworkPolicy', 'CiliumNetworkPolicy',
      'CiliumNetworkPolicy',
    ])
    // A fresh cluster needs no VIP migration delete.
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

  it('leaves a Service already at the pinned VIP untouched', async () => {
    mockGetJson.mockResolvedValue({ spec: { clusterIP: clusterIpForNamespace('test-ns') } })
    await ensureProxyResources('localhost:5000/yaac-proxy:abc')
    expect(mockRetry).not.toHaveBeenCalledWith(
      expect.arrayContaining(['delete', 'service']),
    )
  })

  it('migrates a pre-pin Service: deletes it before re-applying (clusterIP is immutable)', async () => {
    mockGetJson.mockResolvedValue({ spec: { clusterIP: '10.96.123.45' } })
    await ensureProxyResources('localhost:5000/yaac-proxy:abc')

    const deleteIdx = mockRetry.mock.calls.findIndex(
      (c) => c[0][0] === 'delete' && c[0][1] === 'service',
    )
    expect(deleteIdx).toBeGreaterThanOrEqual(0)
    expect(mockRetry.mock.calls[deleteIdx][0]).toEqual([
      'delete', 'service', PROXY_APP_NAME, '-n', 'test-ns', '--ignore-not-found',
    ])
    // The delete happens before any apply, so the re-apply recreates the
    // Service at the pinned VIP instead of failing on the immutable field.
    expect(mockApply).toHaveBeenCalled()
  })
})

describe('ensureCaConfigMap', () => {
  it('skips the apply when the stored PEM already matches', async () => {
    mockGetJson.mockResolvedValue({ data: { 'proxy-ca.pem': 'PEM-CONTENT' } })
    await ensureCaConfigMap('PEM-CONTENT')
    expect(mockApply).not.toHaveBeenCalled()
  })

  it('applies the ConfigMap when absent or stale', async () => {
    mockGetJson.mockResolvedValue(null)
    await ensureCaConfigMap('NEW-PEM')
    expect(mockApply).toHaveBeenCalledWith({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'yaac-proxy-ca', namespace: 'test-ns' },
      data: { 'proxy-ca.pem': 'NEW-PEM' },
    })

    mockApply.mockClear()
    mockGetJson.mockResolvedValue({ data: { 'proxy-ca.pem': 'OLD-PEM' } })
    await ensureCaConfigMap('NEW-PEM')
    expect(mockApply).toHaveBeenCalledTimes(1)
  })
})
