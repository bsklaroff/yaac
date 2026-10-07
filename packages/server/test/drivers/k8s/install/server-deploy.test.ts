/**
 * The server as a workload in its own cluster: what `yaac cluster install`
 * applies, and what `yaac server start|stop|restart` do afterwards.
 *
 * Only the cluster (the shared fake, plus the kubectl processes for rollout
 * waits and log tails), the registry client and the host `fetch` (which
 * probes the published origin) are faked, so the real manifests are built.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import { PassThrough } from 'node:stream'
import path from 'node:path'
import { fakeCluster, type FakeCall } from '@yaac/test-utils/k8s-stub'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import type * as apiModule from '#drivers/k8s/substrate/api'
import type * as registryModule from '#drivers/k8s/container/registry'
import type * as runtimeModule from '#drivers/k8s/container/runtime'
import type * as imageEngineModule from '#drivers/k8s/image-engine'
import type * as childProcessModule from 'node:child_process'


// `server logs` streams through a spawned `kubectl exec`.
const mockSpawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof childProcessModule>()),
  spawn: mockSpawn,
}))

// The rollout waits are the kubectl processes this path runs.
const mockKubectl = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/substrate/api', async (importOriginal) => ({
  ...(await importOriginal<typeof apiModule>()),
  k8sNamespace: () => 'test-ns',
  dataDirHash: () => 'ddh16',
  execFileAsync: mockKubectl,
}))

// The bundle is a build artifact, so hashing it for real would require
// `pnpm build` first.
const mockContextHash = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/image-engine', async (importOriginal) => ({
  ...(await importOriginal<typeof imageEngineModule>()),
  contextHash: mockContextHash,
}))

const mockRegistryHasTag = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/container/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof registryModule>()),
  registryHasTag: mockRegistryHasTag,
  registryRef: (tag: string) => `reg.local:5000/${tag}`,
  pushImageToRegistry: (tag: string) => Promise.resolve(`reg.local:5000/${tag}`),
}))

// Host podman, which the kind fronting asks for the node's published port.
// Any other podman call fails.
const mockPodmanPort = vi.hoisted(() => vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string }>>())
vi.mock('#drivers/k8s/container/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof runtimeModule>()),
  execFileAsync: (file: string, args: string[]) =>
    file === 'podman' && args[0] === 'port'
      ? mockPodmanPort(args)
      : Promise.reject(new Error(`unexpected host process: ${file} ${args.join(' ')}`)),
}))

import {
  clusterServerLogs,
  deployServerWorkload,
  deployedInstallIdentity,
  restartClusterServer,
  serverDeploymentExists,
  startClusterServer,
  stopClusterServer,
} from '#drivers/k8s/install'
// Setup values: the frontings passed to the deploy.
import { kindFronting, tailnetFronting } from '#drivers/k8s/install/server-fronting'
// Setup values: shared names and ports.
import {
  SERVER_APP_NAME,
  SERVER_FRONT_APP_NAME,
  SERVER_FRONT_PORT,
  SERVER_POD_PORT,
  TAILSCALE_OPERATOR_NAMESPACE,
  processIdentity,
} from '#drivers/k8s/substrate'
// Setup value: the real hash function, to derive the expected tag.
import { stringHash } from '#drivers/k8s/image-engine'
import { readServerConfig } from '@yaac/shared/server-config'
// Setup value: writes the data-dir lock the pre-deploy guard reads.
import { writeLock } from '@yaac/shared/lock'
// State reset for the cached node-CIDR probe.
import { resetClusterCidrCache } from '#drivers/k8s/cluster/cluster-cidrs'

/** An applied manifest, typed with only the fields the tests read. */
interface Manifest {
  kind: string
  metadata?: Record<string, unknown>
  data?: Record<string, string>
  rules?: Array<{ apiGroups: string[]; resources: string[]; verbs: string[] }>
  spec?: Record<string, unknown> & {
    replicas?: number
    strategy?: unknown
    type?: string
    ingressClassName?: string
    defaultBackend?: unknown
    tls?: unknown
    podSelector?: unknown
    policyTypes?: string[]
    ingress?: unknown
    externalTrafficPolicy?: unknown
    ports?: Array<Record<string, unknown>>
    template?: { spec: PodSpec }
  }
}

interface PodSpec {
  runtimeClassName?: string
  hostNetwork?: boolean
  dnsPolicy?: string
  nodeSelector?: Record<string, string>
  tolerations?: Array<Record<string, string>>
  securityContext?: Record<string, number>
  volumes: Array<{
    name: string
    hostPath?: { path: string; type?: string }
    persistentVolumeClaim?: { claimName: string }
  }>
  containers: Array<{
    image: string
    command?: string[]
    env: Array<{ name: string; value: string }>
    securityContext?: Record<string, unknown>
    volumeMounts: Array<{ name: string; mountPath: string }>
  }>
}

/**
 * Every API call and kubectl process, in order, as one line each: the
 * verb, kind and name (a patch adds its body), or `kubectl <argv>`.
 */
let actions: string[]

function describeCall(c: FakeCall): string {
  return [c.verb, c.kind, c.name ?? '', ...(c.verb === 'patch' ? [JSON.stringify(c.body)] : [])].join(' ')
}

/**
 * The tailnet Ingress, published by the operator: its hostname appears in
 * the status after `publishedAfter` reads.
 */
function publishIngress(hostname: string, publishedAfter = 0): void {
  let reads = 0
  fakeCluster.intercept((c) => {
    if (c.verb !== 'read' || c.kind !== 'Ingress') return
    const ing = fakeCluster.get('Ingress', SERVER_APP_NAME, 'test-ns')
    if (!ing || (reads += 1) <= publishedAfter) return
    fakeCluster.seed({
      ...ing,
      status: { loadBalancer: { ingress: [{ hostname, ports: [{ port: 443 }] }] } },
    })
  })
}

/** A live tailnet Ingress, as a previous install left it. */
function liveTailnetIngress(hostname: string): void {
  fakeCluster.seed({
    apiVersion: 'networking.k8s.io/v1', kind: 'Ingress',
    metadata: { name: SERVER_APP_NAME, namespace: 'test-ns' },
    spec: { ingressClassName: 'tailscale', tls: [{ hosts: ['yaac'] }] },
    status: { loadBalancer: { ingress: [{ hostname }] } },
  })
}

/** The live server Deployment, with the identity and image it runs. */
function liveDeployment(uid = 1000): void {
  fakeCluster.seed({
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: SERVER_APP_NAME, namespace: 'test-ns' },
    spec: { template: { spec: {
      securityContext: { runAsUser: uid, runAsGroup: uid, supplementalGroups: [0] },
      containers: [{ name: 'server', image: 'reg.local:5000/yaac-server:abc' }],
    } } },
  })
}

/** Deploy with the kind fronting unless another is given. */
function deploy(
  opts: Partial<Parameters<typeof deployServerWorkload>[0]> & { log: (m: string) => void },
): Promise<string> {
  return deployServerWorkload({
    fronting: kindFronting(),
    identity: processIdentity(),
    storage: { kind: 'static' },
    installId: 'install-1',
    ...opts,
  })
}

function applied(kind: string): Manifest[] {
  return fakeCluster.callsOf('apply', kind).map((c) => c.body as unknown as Manifest)
}

/** The pod spec of an applied Deployment (the server's by default). */
function deployedPodSpec(name = SERVER_APP_NAME): PodSpec {
  const deployment = applied('Deployment').find((m) => (m.metadata as { name: string }).name === name)
  const template = deployment?.spec?.template
  if (!template) throw new Error(`no ${name} Deployment pod template was applied`)
  return template.spec
}

let tmpDir: string

beforeEach(async () => {
  vi.clearAllMocks()
  resetClusterCidrCache()
  tmpDir = await createTempDataDir()
  actions = []
  fakeCluster.intercept((c) => { actions.push(describeCall(c)) })
  mockKubectl.mockImplementation((_file: string, args: string[]) => {
    actions.push(`kubectl ${args.join(' ')}`)
    return Promise.resolve({ stdout: '', stderr: '' })
  })
  // A claim binds to its static volume, and a pod goes Ready, once read.
  fakeCluster.intercept((c) => {
    if (c.verb !== 'read' || !c.name) return
    const obj = fakeCluster.get(c.kind, c.name, c.namespace)
    if (!obj || obj.status) return
    if (c.kind === 'PersistentVolumeClaim') {
      fakeCluster.seed({ ...obj, status: { phase: 'Bound' } })
    } else if (c.kind === 'Pod') {
      fakeCluster.seed({ ...obj, status: { conditions: [{ type: 'Ready', status: 'True' }] } })
    }
  })
  // The kind node publishes the default server port.
  mockPodmanPort.mockResolvedValue({ stdout: '127.0.0.1:8787\n', stderr: '' })
  // One node with an InternalIP for the ingress policy to admit.
  fakeCluster.seed({
    apiVersion: 'v1', kind: 'Node', metadata: { name: 'node-1' },
    spec: { podCIDR: '10.244.0.0/24' },
    status: { addresses: [{ type: 'InternalIP', address: '10.89.0.2' }] },
  })
  // The image is already in the registry, so nothing is built.
  mockContextHash.mockResolvedValue('bundlehash')
  mockRegistryHasTag.mockResolvedValue(true)
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(
    new Response(JSON.stringify({ ok: true, ready: true }), { status: 200 }),
  )))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await cleanupTempDir(tmpDir)
})

describe('deployServerWorkload', () => {
  it('applies an identity, a wall and a workload, in that order', async () => {
    const origin = await deploy({ log: vi.fn() })

    // RBAC before the pod that mounts the token, and the ingress policy
    // before the Service, so the API is never briefly reachable from pods.
    const applies = fakeCluster.callsOf('apply')
    const order = (kind: string): number => applies.findIndex((c) => c.kind === kind)
    expect(order('ServiceAccount')).toBeLessThan(order('Deployment'))
    expect(order('ClusterRole')).toBeLessThan(order('Deployment'))
    expect(order('ClusterRoleBinding')).toBeLessThan(order('Deployment'))
    expect(order('NetworkPolicy')).toBeLessThan(order('Service'))
    // The Service before the Deployment, whose env uses its origin. The
    // forwarder after the Service, which frees an old NodePort first.
    expect(order('Service')).toBeLessThan(order('Deployment'))
    const frontOrder = applies.findIndex((c) => c.kind === 'Deployment' && c.name === SERVER_FRONT_APP_NAME)
    expect(frontOrder).toBeGreaterThan(order('Service'))

    // Cluster-scoped names include the namespace, since several installs
    // (including e2e runs) can share a cluster. They are labelled with it
    // because a namespace delete does not remove them.
    const [binding] = applied('ClusterRoleBinding')
    const bindingMeta = binding.metadata as { name: string; labels: Record<string, string> }
    expect(bindingMeta.name).toBe('yaac-server-test-ns')
    expect(bindingMeta.labels['yaac.install-namespace']).toBe('test-ns')
    expect((binding as unknown as { roleRef: { name: string } }).roleRef.name)
      .toBe('yaac-server-test-ns')

    // One replica, recreated: PGlite is embedded, so two servers would
    // write one directory.
    const [deployment] = applied('Deployment')
    expect(deployment.spec?.replicas).toBe(1)
    expect(deployment.spec?.strategy).toEqual({ type: 'Recreate' })
    const pod = deployedPodSpec()
    // Trusted yaac code: runc, not gVisor.
    expect(pod.runtimeClassName).toBeUndefined()
    // The uid install chose (on kind, this host's, since the data dir is
    // a host path it owns). Group 0 makes the image's files writable.
    expect(pod.securityContext).toMatchObject({
      runAsUser: process.getuid?.(),
      runAsGroup: process.getgid?.(),
      supplementalGroups: [0],
    })
    // No fsGroup: the kubelet must not manage hostPath ownership.
    expect(pod.securityContext).not.toHaveProperty('fsGroup')
    // No privilege escalation: group 0 and a group-writable /etc/passwd
    // would otherwise allow `su` to root.
    expect(pod.containers[0].securityContext).toEqual({ allowPrivilegeEscalation: false })
    // Tagged by the bundle only, not the uid
    // (docs/arbitrary-uid-images.md).
    expect(pod.containers[0].image).toBe(
      `reg.local:5000/yaac-server:${stringHash('bundlehash')}`,
    )

    // Three mounts: the two bound claims and the node-local tree. Nothing
    // from the data dir by hostPath.
    const mountOf = (name: string): string | undefined =>
      pod.containers[0].volumeMounts.find((m) => m.name === name)?.mountPath
    expect(pod.volumes.find((v) => v.name === 'global')?.persistentVolumeClaim).toEqual({ claimName: 'yaac-global' })
    expect(mountOf('global')).toBe('/yaac/global')
    expect(pod.volumes.find((v) => v.name === 'server-local')?.persistentVolumeClaim).toEqual({ claimName: 'yaac-server-local' })
    expect(mountOf('server-local')).toBe('/yaac/server-local')
    expect(pod.volumes.find((v) => v.name === 'node-local')?.hostPath)
      .toEqual({ path: '/var/lib/yaac/node/ddh16', type: 'DirectoryOrCreate' })
    expect(mountOf('node-local')).toBe('/yaac/node-local')
    expect(pod.volumes.some((v) => v.hostPath?.path.startsWith(tmpDir))).toBe(false)
    // The claims (PV then PVC per tier) are applied before the Deployment.
    const pvs = applied('PersistentVolume') as unknown as Array<{ spec: { hostPath: { path: string } } }>
    expect(pvs.map((p) => p.spec.hostPath.path)).toEqual([
      path.join(tmpDir, 'global'), path.join(tmpDir, 'server-local'),
    ])
    expect(order('PersistentVolume')).toBeLessThan(order('PersistentVolumeClaim'))
    expect(order('PersistentVolumeClaim')).toBeLessThan(order('Deployment'))

    // The published origin is recorded in `server.json` with driver k8s,
    // so clients find it and `yaac server start` uses the Deployment.
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(await readServerConfig()).toMatchObject({
      url: origin, enabled: true, driver: 'k8s',
    })
    // Labelled with its install, which a later install compares.
    expect(applied('Deployment').find((d) => d.metadata?.name === SERVER_APP_NAME)?.metadata?.labels)
      .toMatchObject({ 'yaac.install-id': 'install-1' })
  })

  it('hands the pod what it can no longer read off a host, and no host-side shim', async () => {
    await deploy({
      log: vi.fn(),
      torHostAddr: '10.89.0.1',
    })

    const env = Object.fromEntries(
      deployedPodSpec().containers[0].env.map((e) => [e.name, e.value]),
    )

    // No git identity: it is a server setting in the database.
    expect(env.YAAC_GIT_NAME).toBeUndefined()

    // Nothing can reach a pod's loopback, so the server binds all
    // interfaces and the ingress policy restricts access.
    expect(env.YAAC_BIND_ADDR).toBe('0.0.0.0')
    expect(env.YAAC_SERVER_PORT).toBe(String(SERVER_POD_PORT))
    // The same data dir path, so dataDirHash() and labels match. The pod
    // only uses it as an identifier; it mounts the three roots below.
    expect(env.YAAC_DATA_DIR).toBe(tmpDir)
    expect(env.YAAC_GLOBAL_ROOT).toBe('/yaac/global')
    expect(env.YAAC_SERVER_LOCAL_ROOT).toBe('/yaac/server-local')
    expect(env.YAAC_NODE_LOCAL_ROOT).toBe('/yaac/node-local')
    expect(env.YAAC_DRIVER).toBe('k8s')
    // IN_CLUSTER makes the registry client dial Service DNS.
    expect(env.YAAC_IN_CLUSTER).toBe('1')
  })

  it('stamps the identity install decided, not the uid of the machine running it', async () => {
    // A byo install from a laptop: the laptop's uid means nothing to the
    // cluster's storage, so install passes a fixed identity.
    await deploy({ identity: { uid: 1000, gid: 1000 }, log: vi.fn() })
    expect(deployedPodSpec().securityContext).toEqual({
      runAsUser: 1000, runAsGroup: 1000, supplementalGroups: [0],
    })
  })

  it('carries the forward bind the install shell was given, but not its allowed hosts', async () => {
    // Set on the Deployment; `yaac server restart` only rolls existing
    // pods, so re-running install is how it changes. Which names the server
    // answers to follows the fronting alone: a shell-set YAAC_ALLOWED_HOSTS
    // must not open a local install to anything.
    vi.stubEnv('YAAC_ALLOWED_HOSTS', 'srv.tailnet.ts.net')
    vi.stubEnv('YAAC_FORWARD_BIND', '100.64.0.7')

    await deploy({ log: vi.fn() })

    const env = Object.fromEntries(
      deployedPodSpec().containers[0].env.map((e) => [e.name, e.value]),
    )
    expect(env.YAAC_ALLOWED_HOSTS).toBeUndefined()
    expect(env.YAAC_ACCESS_MODE).toBe('local')
    // The pod builds the snapshot that forwarded-port links come from, so
    // it needs the tailnet bind address.
    expect(env.YAAC_FORWARD_BIND).toBe('100.64.0.7')
  })

  it('leaves the loopback defaults off the pod entirely', async () => {
    await deploy({ log: vi.fn() })

    const names = deployedPodSpec().containers[0].env.map((e) => e.name)
    expect(names).not.toContain('YAAC_ALLOWED_HOSTS')
    // Omitted when unset, rather than pinning the 127.0.0.1 default.
    expect(names).not.toContain('YAAC_FORWARD_BIND')
  })

  it('rewrites an IPv6-loopback Tor SOCKS URL to the host, brackets and all', async () => {
    // Tor listens on the host, so loopback addresses are rewritten to the
    // host's kind-network address. `new URL(...).hostname` returns `[::1]`
    // with brackets, so the IPv6 case must match that form.
    vi.stubEnv('YAAC_USE_TOR', '1')
    vi.stubEnv('YAAC_HOST_TOR_SOCKS_URL', 'socks5h://[::1]:9050')

    await deploy({ log: vi.fn(), torHostAddr: '10.89.0.1' })

    const env = Object.fromEntries(
      deployedPodSpec().containers[0].env.map((e) => [e.name, e.value]),
    )
    expect(env.YAAC_HOST_TOR_SOCKS_URL).toBe('socks5h://10.89.0.1:9050')
  })

  it('walls the API off from pods, and publishes it through the kind forwarder', async () => {
    await deploy({ log: vi.fn() })

    // Only node addresses and the fronting. A workspace pod has a pod
    // source address and is dropped; one that got through could claim a
    // loopback Host and act as the owner (cluster check probes this). The
    // kind forwarder is host-networked, so it needs no extra peer.
    const [nodeHalf, frontHalf] = applied('NetworkPolicy')
    expect(nodeHalf.spec?.podSelector).toEqual({ matchLabels: { app: SERVER_APP_NAME } })
    expect(nodeHalf.spec?.policyTypes).toEqual(['Ingress'])
    // (Its proxy rule, to the mama port only, is pinned in policy-manifests.)
    expect(nodeHalf.spec?.ingress).toContainEqual({
      from: [{ ipBlock: { cidr: '10.89.0.2/32' } }],
      ports: [{ protocol: 'TCP', port: SERVER_POD_PORT }],
    })
    expect(frontHalf.spec?.podSelector).toEqual({ matchLabels: { app: SERVER_APP_NAME } })
    expect(frontHalf.spec?.ingress).toEqual([])

    // ClusterIP, not NodePort; the host reaches it via the forwarder below.
    const [svc] = applied('Service')
    expect(svc.spec?.type).toBe('ClusterIP')
    expect(svc.spec?.ports?.[0]).toMatchObject({ port: SERVER_POD_PORT, targetPort: SERVER_POD_PORT })
    expect(svc.spec?.ports?.[0]?.nodePort).toBeUndefined()
    // A previous tailnet Ingress is deleted, or `server start` would wait
    // on it.
    expect(actions).toContain(`delete Ingress ${SERVER_APP_NAME}`)

    // The forwarder: a host-network Envoy on the control-plane node (where
    // kind's port mapping lands) that dials the Service, so traffic reaches
    // the server from a node address.
    const front = deployedPodSpec(SERVER_FRONT_APP_NAME)
    expect(front.hostNetwork).toBe(true)
    expect(front.dnsPolicy).toBe('ClusterFirstWithHostNet')
    expect(front.nodeSelector).toEqual({ 'node-role.kubernetes.io/control-plane': '' })
    expect(front.tolerations?.[0]).toMatchObject({ key: 'node-role.kubernetes.io/control-plane' })
    expect(front.runtimeClassName).toBeUndefined()
    const [envoy] = front.containers
    expect(envoy.image).toContain('envoyproxy/envoy')
    expect(envoy.securityContext).toMatchObject({ runAsNonRoot: true, capabilities: { drop: ['ALL'] } })
    expect(envoy.command).toContain('--use-dynamic-base-id')
    const [config] = applied('ConfigMap')
    expect(config.data?.['bootstrap.yaml']).toContain(`port_value: ${String(SERVER_FRONT_PORT)}`)
    // A trailing dot, so the node's search domains are never tried.
    expect(config.data?.['bootstrap.yaml']).toContain(`address: ${SERVER_APP_NAME}.test-ns.svc.cluster.local.,`)
    expect(actions.some((c) => c.includes(`rollout status deployment/${SERVER_FRONT_APP_NAME}`))).toBe(true)
  })

  it('publishes through the tailnet when told to', async () => {
    publishIngress('yaac.tail1234.ts.net', 1)
    const log = vi.fn()

    const origin = await deploy({ fronting: tailnetFronting({ hostname: 'yaac' }), log })

    // A ClusterIP behind the operator's TLS Ingress, never L4 exposure.
    // Any kind forwarder is removed.
    const [service] = applied('Service')
    expect(service.spec?.type).toBe('ClusterIP')
    const [ing] = applied('Ingress')
    expect((ing.metadata as { name: string }).name).toBe(SERVER_APP_NAME)
    expect(ing.spec).toEqual({
      ingressClassName: 'tailscale',
      defaultBackend: { service: { name: SERVER_APP_NAME, port: { number: SERVER_POD_PORT } } },
      tls: [{ hosts: ['yaac'] }],
    })
    expect(applied('ConfigMap')).toHaveLength(0)
    expect(actions).toContain(`delete Deployment ${SERVER_FRONT_APP_NAME}`)

    // The fronting policy admits the operator's proxy pod for this Service.
    const [nodeHalf, frontHalf] = applied('NetworkPolicy')
    expect(nodeHalf.spec?.ingress).toContainEqual({
      from: [{ ipBlock: { cidr: '10.89.0.2/32' } }],
      ports: [{ protocol: 'TCP', port: SERVER_POD_PORT }],
    })
    expect(frontHalf.spec?.ingress).toEqual([{
      from: [{
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': TAILSCALE_OPERATOR_NAMESPACE } },
        podSelector: { matchLabels: {
          'tailscale.com/parent-resource': SERVER_APP_NAME,
          'tailscale.com/parent-resource-ns': 'test-ns',
        } },
      }],
      ports: [{ protocol: 'TCP', port: SERVER_POD_PORT }],
    }])

    // The origin is the https name read from the Ingress before the
    // Deployment is rendered, since the Deployment must allow that host.
    expect(origin).toBe('https://yaac.tail1234.ts.net')
    const env = Object.fromEntries(deployedPodSpec().containers[0].env.map((e) => [e.name, e.value]))
    expect(env.YAAC_ALLOWED_HOSTS).toBe('yaac.tail1234.ts.net')
    expect(env.YAAC_ACCESS_MODE).toBe('tailnet')
    expect(vi.mocked(globalThis.fetch).mock.calls.some(([u]) => (u as string).startsWith(origin))).toBe(true)
    expect(await readServerConfig()).toMatchObject({ url: origin, enabled: true, driver: 'k8s' })
  })

  it('hands --owner to the server, and fails on the reason a server refusing its access mode gives', async () => {
    publishIngress('yaac.tail1234.ts.net')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      ok: true, ready: false, access: null, refused: 'this install runs in local mode',
    })))))

    await expect(deploy({ fronting: tailnetFronting({ hostname: 'yaac' }), owner: 'alice@example.com', log: vi.fn() }))
      .rejects.toThrow('the server refused to start: this install runs in local mode')

    const env = Object.fromEntries(deployedPodSpec().containers[0].env.map((e) => [e.name, e.value]))
    expect(env.YAAC_ACCESS_OWNER).toBe('alice@example.com')
  })

  it('refuses when the operator never publishes a hostname, before the Deployment', async () => {
    // Only the clock is faked; the deploy's lock read is real disk I/O.
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    try {
      publishIngress('never', Number.MAX_SAFE_INTEGER)
      let settled = false
      const pending = deploy({ fronting: tailnetFronting({ hostname: 'yaac' }), log: vi.fn() })
        .finally(() => { settled = true })
      const verdict = expect(pending).rejects.toThrow(/Tailscale operator did not publish/)
      // Tick until settled, letting the real disk I/O run between ticks.
      for (let i = 0; i < 1_000 && !settled; i += 1) {
        await new Promise((r) => setImmediate(r))
        await vi.advanceTimersByTimeAsync(1_000)
      }
      await verdict
      // Only the Ingress was applied; nothing that needs the origin.
      expect(applied('Ingress')).toHaveLength(1)
      expect(applied('Deployment')).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reaches every namespace, because it creates namespaces', async () => {
    await deploy({ log: vi.fn() })

    // A ClusterRole, since the server creates namespaces at runtime.
    const [role] = applied('ClusterRole')
    const rules = role.rules ?? []
    const core = rules.find((r) => r.apiGroups.includes('') && r.resources.includes('pods'))
    expect(core?.resources).toContain('namespaces')
    expect(core?.resources).toContain('pods/exec')
    const nodes = rules.find((r) => r.resources.includes('nodes'))
    expect(nodes?.verbs).toEqual(['get', 'list', 'watch'])
    // Resources are listed explicitly, with no wildcard.
    expect(rules.every((r) => !r.resources.includes('*'))).toBe(true)
  })

  it('warns, having registered, when the server will not identify this machine', async () => {
    // With tailnet fronting the CLI is identified like any device, and a
    // tagged device has no user, so install reports it up front.
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(String(url).endsWith('/api/whoami')
      ? new Response(JSON.stringify({
        error: { code: 'UNAUTHENTICATED', message: 'tailscale serve sent no user identity' },
      }), { status: 401 })
      : new Response(JSON.stringify({ ok: true, buildId: 'b', ready: true }), { status: 200 }))))
    const log = vi.fn()

    const origin = await deploy({ log })

    expect(log.mock.calls.flat().join('\n'))
      .toMatch(/WARNING: .*refused to identify this device: tailscale serve sent no user identity/)
    expect(await readServerConfig()).toMatchObject({ url: origin, enabled: true, driver: 'k8s' })
  })

  it('stops the pod that is there before it deploys', async () => {
    liveDeployment()

    await deploy({ log: vi.fn() })

    const stopAt = actions.indexOf(`patch Deployment ${SERVER_APP_NAME} {"spec":{"replicas":0}}`)
    expect(stopAt).toBeGreaterThanOrEqual(0)
    // Waits for the pod's deletion, not just the scale.
    expect(actions[stopAt + 1]).toBe('list Pod ')
    expect(stopAt).toBeLessThan(actions.indexOf(`apply Deployment ${SERVER_APP_NAME}`))
  })

  it('skips the stop when there is no Deployment yet', async () => {
    await deploy({ log: vi.fn() })
    expect(actions.some((c) => c.includes('"replicas":0'))).toBe(false)
  })

  it('refuses to deploy beside a host server that still holds the data dir', async () => {
    // Deploying while a host server runs would put two servers on one
    // database, and the old server would answer the origin probe.
    await writeLock({
      pid: process.ppid, port: 8787, startedAt: Date.now(), buildId: 'b',
      instance: 'inst-1', host: os.hostname(), heartbeatAt: Date.now(),
    })
    // /health answers and the lock's pid is alive: a host server is running.
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(
      new Response(JSON.stringify({ ok: true, ready: true }), { status: 200 }),
    )))

    await expect(deploy({ log: vi.fn() }))
      .rejects.toThrow(/already running.*host process[\s\S]*yaac server stop/)
    // Refused before any manifest is applied.
    expect(fakeCluster.callsOf('apply')).toEqual([])
  })

  it('rolls its own pod without complaint — an off-host lock is what a re-install replaces', async () => {
    // An in-cluster server's lock names another host; install rolls it via
    // the Deployment, so no refusal.
    await writeLock({
      pid: 1, port: 8787, startedAt: Date.now(), buildId: 'b',
      instance: 'abc', host: 'yaac-server-77d4f', heartbeatAt: Date.now(),
    })

    await expect(deploy({ log: vi.fn() })).resolves.toMatch(/^http:/)
  })

  it('deploys past a host lock whose server is gone', async () => {
    // A stale lock from a crashed server is ignored.
    const DEAD_PORT = 1
    await writeLock({
      pid: process.ppid, port: DEAD_PORT, startedAt: Date.now(), buildId: 'b',
      instance: 'inst-1', host: os.hostname(), heartbeatAt: Date.now(),
    })
    // Nothing answers on the lock's port, so the server is gone even
    // though the pid exists. The published origin still answers.
    vi.stubGlobal('fetch', vi.fn((url: string) =>
      String(url).includes(`:${String(DEAD_PORT)}/`)
        ? Promise.reject(new Error('connection refused'))
        : Promise.resolve(new Response(
          JSON.stringify({ ok: true, ready: true }), { status: 200 },
        ))))

    await expect(deploy({ log: vi.fn() })).resolves.toMatch(/^http:/)
  })
})

describe('serverDeploymentExists', () => {
  it('is how the CLI tells a deployed server from a host process, and never guesses', async () => {
    expect(await serverDeploymentExists()).toBe(false)
    liveDeployment()
    expect(await serverDeploymentExists()).toBe(true)

    // An unreachable cluster must throw, not answer false, or the CLI
    // would treat a k8s install as a host server and act on its data dir.
    fakeCluster.intercept(() => { throw new Error('connect ECONNREFUSED 127.0.0.1:6443') })
    await expect(serverDeploymentExists()).rejects.toThrow(/ECONNREFUSED/)
  })
})

describe('startClusterServer', () => {
  it('scales the Deployment back up rather than spawning anything, and answers the origin', async () => {
    vi.stubEnv('YAAC_SERVER_PORT', '9123')
    // No Ingress means the kind fronting and a loopback origin.
    liveDeployment()
    await expect(startClusterServer()).resolves.toBe('http://127.0.0.1:9123')
    // An explicit port, so the node's mapping is not read.
    expect(mockPodmanPort).not.toHaveBeenCalled()
    const scaleAt = actions.indexOf(`patch Deployment ${SERVER_APP_NAME} {"spec":{"replicas":1}}`)
    expect(scaleAt).toBeGreaterThanOrEqual(0)
    expect(actions.some((c) => c.includes('rollout status'))).toBe(true)
    // A leftover log reader holding an RWO claim would pin the server to
    // its node, so it is deleted first.
    expect(actions.indexOf('delete Pod yaac-server-log-reader')).toBeGreaterThanOrEqual(0)
    expect(actions.indexOf('delete Pod yaac-server-log-reader')).toBeLessThan(scaleAt)
  })

  it('waits on the port the cluster was created with, not this shell\'s default', async () => {
    // kind fixes the host port at cluster create, so with no
    // YAAC_SERVER_PORT the port is read from the node's mapping, not
    // assumed to be 8787.
    vi.stubEnv('YAAC_SERVER_PORT', '')
    liveDeployment()
    mockPodmanPort.mockResolvedValue({ stdout: '127.0.0.1:8866\n', stderr: '' })
    await expect(startClusterServer()).resolves.toBe('http://127.0.0.1:8866')
    expect(mockPodmanPort).toHaveBeenCalledWith(['port', 'yaac-control-plane', `${String(SERVER_FRONT_PORT)}/tcp`])
    expect(vi.mocked(globalThis.fetch).mock.calls.every(([u]) =>
      (u as string).startsWith('http://127.0.0.1:8866/'))).toBe(true)
  })

  it('refuses rather than guess a port when the node\'s mapping cannot be read', async () => {
    // A node with no mapping gets the recreate advice at once, rather than
    // a guessed port.
    vi.stubEnv('YAAC_SERVER_PORT', '')
    liveDeployment()
    mockPodmanPort.mockRejectedValueOnce(Object.assign(new Error('exit 125'), {
      stderr: 'Error: failed to find published port "30787/tcp"\n',
    }))
    await expect(startClusterServer()).rejects.toThrow(/publishes no host port[\s\S]*yaac cluster delete/)
    // Other podman failures are reported as-is, without recreate advice.
    mockPodmanPort.mockRejectedValueOnce(Object.assign(new Error('exit 125'), {
      stderr: 'Error: unable to connect to Podman socket\n',
    }))
    const other = startClusterServer()
    await expect(other).rejects.toThrow(/unable to connect to Podman socket/)
    await expect(other).rejects.not.toThrow(/yaac cluster delete/)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('waits on the tailnet origin when that is what the live Ingress records', async () => {
    liveDeployment()
    liveTailnetIngress('yaac.tail1234.ts.net')
    await expect(startClusterServer()).resolves.toBe('https://yaac.tail1234.ts.net')
    expect(vi.mocked(globalThis.fetch).mock.calls.every(([u]) =>
      (u as string).startsWith('https://yaac.tail1234.ts.net'))).toBe(true)
  })

  it('turns a rolled-out Deployment that never answers into the fix for it', async () => {
    // Available but refused on 127.0.0.1 means the cluster lacks the port
    // mapping, which kind sets only at create. The fronting says to
    // recreate it.
    liveDeployment()
    vi.useFakeTimers()
    try {
      vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))))
      const pending = startClusterServer()
      const verdict = expect(pending).rejects.toThrow(/yaac cluster delete/)
      await vi.advanceTimersByTimeAsync(61_000)
      await verdict
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports an origin that answers but never readies, without the unreachable diagnosis', async () => {
    // Recreating the cluster (which loses workspaces) is no fix for a
    // server that answers.
    liveDeployment()
    vi.useFakeTimers()
    try {
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 404 }))))
      const pending = startClusterServer()
      const verdict = expect(pending).rejects.toThrow(/answers, but not as a ready server \(answered HTTP 404\)\.$/)
      await vi.advanceTimersByTimeAsync(61_000)
      await verdict
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits out an answering-but-still-initializing server', async () => {
    // /health answers before the DB is open, so wait for `ready`.
    liveDeployment()
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(() => {
      calls += 1
      return Promise.resolve(new Response(
        JSON.stringify({ ok: true, ready: calls > 2 }),
        { status: 200 },
      ))
    }))
    await startClusterServer()
    expect(calls).toBeGreaterThan(2)
  })
})

describe('stopClusterServer', () => {
  it('scales to zero, keeping what a later start needs, and waits on the pod rather than a count', async () => {
    liveDeployment()
    await stopClusterServer()
    // Stop scales to zero rather than deleting, so start can undo it.
    expect(actions[0]).toBe(`patch Deployment ${SERVER_APP_NAME} {"spec":{"replicas":0}}`)
    expect(actions.some((c) => c.startsWith('delete '))).toBe(false)
    // `status.replicas` is omitted at zero, so the wait is on the pods.
    expect(actions[1]).toBe('list Pod ')
  })

  it('does not fail the stop when the drain outlives the wait', async () => {
    // A successor waits for the lease to go stale.
    liveDeployment()
    fakeCluster.seed({
      apiVersion: 'v1', kind: 'Pod', metadata: { name: 'yaac-server-abc', namespace: 'test-ns', labels: { app: SERVER_APP_NAME } },
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    try {
      const stop = stopClusterServer()
      await vi.advanceTimersByTimeAsync(61_000)
      await expect(stop).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('restartClusterServer', () => {
  it('rolls the pod and waits for the published origin to answer again', async () => {
    liveDeployment()
    await expect(restartClusterServer()).resolves.toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const restartAt = actions.findIndex((c) => c.startsWith(`patch Deployment ${SERVER_APP_NAME}`))
    expect(actions.indexOf('delete Pod yaac-server-log-reader')).toBeGreaterThanOrEqual(0)
    expect(actions.indexOf('delete Pod yaac-server-log-reader')).toBeLessThan(restartAt)
    // A pod-template change is what rolls the pod.
    const template = fakeCluster.get<{ spec: { template: { metadata: { annotations: Record<string, string> } } } }>(
      'Deployment', SERVER_APP_NAME, 'test-ns')!.spec.template
    expect(template.metadata.annotations['kubectl.kubernetes.io/restartedAt']).toMatch(/^\d{4}-/)
    expect(actions.slice(restartAt).some((c) => c.includes('rollout status'))).toBe(true)
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalled()
  })
})

describe('deployedInstallIdentity', () => {
  it('reads the identity back off the live Deployment, which is its record', async () => {
    // The uid `cluster check` and the e2e harness run pods as; on a byo
    // install it differs from the local uid.
    liveDeployment(1234)
    await expect(deployedInstallIdentity(false)).resolves.toEqual({ uid: 1234, gid: 1234 })
  })

  it('with no Deployment, is what install would deploy — never a guess past a failed read', async () => {
    await expect(deployedInstallIdentity(false)).resolves.toEqual(processIdentity())
    await expect(deployedInstallIdentity(true)).resolves.toEqual({ uid: 1000, gid: 1000 })
    fakeCluster.intercept(() => { throw new Error('connect ECONNREFUSED 127.0.0.1:6443') })
    await expect(deployedInstallIdentity(true)).rejects.toThrow(/ECONNREFUSED/)
  })
})

describe('clusterServerLogs', () => {
  /** A kubectl child that prints `out` and exits with `code`. */
  function fakeKubectl(out: string, code: number, err = ''): void {
    mockSpawn.mockImplementationOnce(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
      })
      setImmediate(() => {
        child.stdout.end(out)
        child.stderr.end(err)
        child.emit('close', code, null)
      })
      return child
    })
  }

  /** The server pods the apiserver lists, and the Deployment it holds. */
  function cluster(pods: Array<{ name: string; node?: string; running: boolean }>): void {
    for (const pod of fakeCluster.objects('Pod')) {
      fakeCluster.request({ verb: 'delete', apiVersion: 'v1', kind: 'Pod', name: pod.metadata.name, namespace: 'test-ns' })
    }
    liveDeployment()
    fakeCluster.seed(...pods.map((p) => ({
      apiVersion: 'v1', kind: 'Pod',
      metadata: { name: p.name, namespace: 'test-ns', labels: { app: SERVER_APP_NAME } },
      spec: { nodeName: p.node },
      status: { containerStatuses: [{ name: 'server', state: p.running ? { running: {} } : { waiting: {} } }] },
    })))
    actions = []
  }

  let written: string[]
  beforeEach(() => {
    written = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk))
      return true
    })
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('tails the log in the running server pod, whole by default; `-f` and `-n` go to tail', async () => {
    cluster([{ name: 'yaac-server-abc', running: true }])
    fakeKubectl('[server] listening on 0.0.0.0:7777\n', 0)
    await clusterServerLogs()
    expect(mockSpawn).toHaveBeenLastCalledWith('kubectl', [
      'exec', 'yaac-server-abc', '-n', 'test-ns', '-c', 'server',
      '--', 'tail', '-n', '+1', '/yaac/server-local/server.log',
    ], expect.anything())
    expect(written.join('')).toContain('listening on 0.0.0.0:7777')
    expect(fakeCluster.callsOf('apply')).toEqual([])

    fakeKubectl('', 0)
    await clusterServerLogs({ follow: true, lines: 5 })
    expect(mockSpawn.mock.lastCall?.[1]).toEqual(expect.arrayContaining(['-F', '-n', '5']))
    fakeKubectl('', 0)
    await clusterServerLogs({ lines: -3 })
    expect(mockSpawn.mock.lastCall?.[1]).toEqual(expect.arrayContaining(['-n', '0']))
  })

  it('reads a down server\'s log through a read-only reader pod on its node, and removes it', async () => {
    // Crash-looping: a pod with no running container.
    cluster([{ name: 'yaac-server-abc', node: 'pool-2', running: false }])
    fakeKubectl('[server] fatal: boom\n', 0)
    await clusterServerLogs({ lines: 20 })

    const reader = applied('Pod')[0] as unknown as {
      metadata: { name: string }
      spec: {
        nodeName?: string; activeDeadlineSeconds: number; securityContext: unknown
        containers: Array<{ image: string; volumeMounts: Array<{ mountPath: string; readOnly: boolean }> }>
        volumes: Array<{ persistentVolumeClaim: { claimName: string; readOnly: boolean } }>
      }
    }
    expect(reader.metadata.name).toBe('yaac-server-log-reader')
    // Pinned to the server's node (RWO volume), with its image and
    // identity, the claim read-only, and a deadline in case the CLI dies.
    expect(reader.spec.nodeName).toBe('pool-2')
    expect(reader.spec.containers[0].image).toBe('reg.local:5000/yaac-server:abc')
    expect(reader.spec.securityContext).toMatchObject({ runAsUser: 1000, runAsGroup: 1000 })
    expect(reader.spec.volumes[0].persistentVolumeClaim).toEqual({ claimName: 'yaac-server-local', readOnly: true })
    expect(reader.spec.containers[0].volumeMounts[0]).toEqual({ name: 'server-local', mountPath: '/yaac/server-local', readOnly: true })
    expect(reader.spec.activeDeadlineSeconds).toBeGreaterThan(0)
    expect((mockSpawn.mock.lastCall?.[1] as string[]).slice(0, 6)).toEqual(['exec', 'yaac-server-log-reader', '-n', 'test-ns', '-c', 'reader'])
    expect(written.join('')).toContain('fatal: boom')
    expect(actions.filter((a) => a === 'delete Pod yaac-server-log-reader')).toHaveLength(2)
    // Exec only once Ready; kubectl exec does not wait on a named pod.
    expect(actions.lastIndexOf('read Pod yaac-server-log-reader'))
      .toBeGreaterThan(actions.indexOf('apply Pod yaac-server-log-reader'))
    expect(fakeCluster.get('Pod', 'yaac-server-log-reader', 'test-ns')).toBeUndefined()

    // Scaled to zero: no pod, so no node to pin to.
    cluster([])
    fakeCluster.calls = []
    fakeKubectl('', 1, 'error: unable to upgrade connection\n')
    await expect(clusterServerLogs()).rejects.toThrow(/could not read the server log in pod yaac-server-log-reader: error: unable to upgrade/)
    expect((applied('Pod')[0] as unknown as { spec: { nodeName?: string } }).spec.nodeName).toBeUndefined()
    // The reader is removed on failure too.
    expect(actions.at(-1)).toBe('delete Pod yaac-server-log-reader')

    // A reader that never starts is reported as such, with no exec.
    const execs = mockSpawn.mock.calls.length
    fakeCluster.intercept((c) => {
      const pod = c.verb === 'read' && fakeCluster.get('Pod', 'yaac-server-log-reader', 'test-ns')
      if (pod) fakeCluster.seed({ ...pod, status: { phase: 'Pending' } })
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    try {
      const read = clusterServerLogs()
      const verdict = expect(read).rejects.toThrow(/log reader pod did not become Ready within 120s/)
      await vi.advanceTimersByTimeAsync(121_000)
      await verdict
    } finally {
      vi.useRealTimers()
    }
    expect(mockSpawn.mock.calls.length).toBe(execs)
    expect(actions.at(-1)).toBe('delete Pod yaac-server-log-reader')
  })
})
