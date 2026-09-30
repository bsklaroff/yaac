/**
 * The server as a workload of its own cluster: what `yaac cluster install`
 * applies, and what `yaac server start|stop|restart` do once it has.
 *
 * Mocked at the process boundary only — kubectl, the registry client, and
 * the host `fetch` that probes the published origin — so the real manifests
 * are built and the assertions land on the objects the apiserver would
 * actually receive.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import { PassThrough } from 'node:stream'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import type * as kubectlModule from '#drivers/k8s/substrate/kubectl'
import type * as registryModule from '#drivers/k8s/container/registry'
import type * as runtimeModule from '#drivers/k8s/container/runtime'
import type * as imageEngineModule from '#drivers/k8s/image-engine'
import type * as childProcessModule from 'node:child_process'

vi.mock('#log', () => ({ serverLog: vi.fn(), pipeToServerLog: vi.fn() }))

// `server logs` streams through a `kubectl exec` child; nothing else in
// this suite spawns one.
const mockSpawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof childProcessModule>()),
  spawn: mockSpawn,
}))

const mockApply = vi.hoisted(() => vi.fn())
const mockGetJson = vi.hoisted(() => vi.fn())
const mockWithRetry = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/substrate/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  k8sNamespace: () => 'test-ns',
  dataDirHash: () => 'ddh16',
  kubectlApply: mockApply,
  kubectlGetJson: mockGetJson,
  kubectlWithRetry: mockWithRetry,
}))

// The bundle is a build artifact, not a source file, so hashing it for
// real would make this suite depend on `pnpm build` having run. The tag is
// only ever compared to itself here; what the image is BUILT from is the
// install path's business, covered where a real cluster is.
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

// The host engine, which the kind fronting asks for the port its node
// publishes. Nothing else here crosses it, so any other call is a failure
// rather than a real process run without the options it was given.
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
// Setup value: the fronting every case hands the deploy — an argument set,
// chosen so the kind path (the forwarder, the loopback origin) runs for real.
import { kindFronting, tailnetFronting } from '#drivers/k8s/install/server-fronting'
// Setup values: the names and ports the datapath vocabulary fixes, so the
// assertions below name the same constants the manifests do rather than
// re-spelling them.
import {
  SERVER_APP_NAME,
  SERVER_FRONT_APP_NAME,
  SERVER_FRONT_PORT,
  SERVER_POD_PORT,
  TAILSCALE_OPERATOR_NAMESPACE,
  processIdentity,
} from '#drivers/k8s/substrate'
// Setup value: the real hash function, so the expected tag is derived the
// way the code derives it rather than pasted as a literal.
import { stringHash } from '#drivers/k8s/image-engine'
import { readServerConfig } from '@yaac/shared/server-config'
// Setup value: a lock on the data dir is what the pre-deploy guard reads,
// and writing one is how a test stands a "server already running" up.
import { writeLock } from '@yaac/shared/lock'
// State-reset hook for the node-CIDR probe the ingress policy is rendered
// from — it caches per process, and each case seeds its own nodes.
import { resetClusterCidrCache } from '#drivers/k8s/cluster/cluster-cidrs'

/**
 * Every manifest this run applied, by kind. Typed loosely on purpose: the
 * builders return plain objects (the shape IS the assertion), so the test
 * declares only the fields it reads.
 */
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
 * The tailnet fronting's Ingress as the apiserver reports it once the
 * operator has published — what `get ingress` answers after
 * `publishedAfter` reads.
 */
function tailnetIngress(hostname: string, publishedAfter = 0): (args: string[]) => unknown {
  let reads = 0
  return (args: string[]) => {
    if (!args.includes('ingress')) return null
    reads += 1
    return {
      spec: { ingressClassName: 'tailscale', tls: [{ hosts: ['yaac'] }] },
      status: reads > publishedAfter ? { loadBalancer: { ingress: [{ hostname, ports: [{ port: 443 }] }] } } : {},
    }
  }
}

/**
 * A storage claim as the apiserver reports it once the static pair has
 * bound — what every deploy waits on after applying it. Absent on the
 * first read (so the pair is applied), Bound to its own volume after.
 */
const claimReads = new Map<string, number>()
function claimRead(args: string[]): unknown {
  if (args[1] !== 'pvc') return null
  const n = (claimReads.get(args[2]) ?? 0) + 1
  claimReads.set(args[2], n)
  if (n === 1) return null
  return { spec: { volumeName: `${args[2]}-ddh16` }, status: { phase: 'Bound' } }
}

/** The kind path, unless a case hands another fronting. */
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
  return (mockApply.mock.calls as Array<[Manifest]>)
    .map(([m]) => m)
    .filter((m) => m.kind === kind)
}

/** The pod spec of a Deployment this run applied — the server's by default. */
function deployedPodSpec(name = SERVER_APP_NAME): PodSpec {
  const deployment = applied('Deployment').find((m) => (m.metadata as { name: string }).name === name)
  const template = deployment?.spec?.template
  if (!template) throw new Error(`no ${name} Deployment pod template was applied`)
  return template.spec
}

/** The kubectl argv of every retrying call, joined for substring matching. */
function retried(): string[] {
  return (mockWithRetry.mock.calls as Array<[string[]]>).map(([args]) => args.join(' '))
}

let tmpDir: string

beforeEach(async () => {
  vi.clearAllMocks()
  claimReads.clear()
  resetClusterCidrCache()
  tmpDir = await createTempDataDir()
  mockApply.mockResolvedValue(undefined)
  mockWithRetry.mockResolvedValue({ stdout: '', stderr: '' })
  // The kind node publishes the server where a cluster created with no
  // YAAC_SERVER_PORT would, unless a case says otherwise.
  mockPodmanPort.mockResolvedValue({ stdout: '127.0.0.1:8787\n', stderr: '' })
  // One node with an InternalIP, so the ingress wall has a concrete node
  // address to admit.
  mockGetJson.mockImplementation((args: string[]) => {
    if (args.includes('nodes')) {
      return Promise.resolve({
        items: [{
          spec: { podCIDR: '10.244.0.0/24' },
          status: { addresses: [{ type: 'InternalIP', address: '10.89.0.2' }] },
        }],
      })
    }
    return Promise.resolve(claimRead(args))
  })
  // The image is already in the registry, so no build is attempted: this
  // suite is about the workload, and podman is not a process boundary it
  // needs to cross.
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

    // The SA and its ClusterRole exist before the pod that mounts the
    // token, and the ingress policy before the Service publishes the port
    // — a window where the API is reachable from pods is a window a
    // worktree could use it.
    const order = (kind: string): number =>
      (mockApply.mock.calls as Array<[Manifest]>).findIndex(([m]) => m.kind === kind)
    expect(order('ServiceAccount')).toBeLessThan(order('Deployment'))
    expect(order('ClusterRole')).toBeLessThan(order('Deployment'))
    expect(order('ClusterRoleBinding')).toBeLessThan(order('Deployment'))
    expect(order('NetworkPolicy')).toBeLessThan(order('Service'))
    // And the Service before the Deployment: the origin it publishes is an
    // input to the Deployment's environment. The forwarder comes after the
    // Service — on a converging install the Service apply is what releases
    // the old NodePort on the node before the forwarder binds it.
    expect(order('Service')).toBeLessThan(order('Deployment'))
    const frontOrder = (mockApply.mock.calls as Array<[Manifest]>)
      .findIndex(([m]) => m.kind === 'Deployment' && (m.metadata as { name: string }).name === SERVER_FRONT_APP_NAME)
    expect(frontOrder).toBeGreaterThan(order('Service'))

    // The cluster-scoped pair is namespace-suffixed, like netd's. A
    // ClusterRoleBinding does not belong to a namespace, and one cluster
    // hosts more than one install — the real one plus an ephemeral
    // `yaac-test-<run-id>` per e2e file — so a shared name would have the
    // last applier own everyone's binding. The install namespace is
    // stamped as a label because these do NOT cascade when it is deleted.
    const [binding] = applied('ClusterRoleBinding')
    const bindingMeta = binding.metadata as { name: string; labels: Record<string, string> }
    expect(bindingMeta.name).toBe('yaac-server-test-ns')
    expect(bindingMeta.labels['yaac.install-namespace']).toBe('test-ns')
    expect((binding as unknown as { roleRef: { name: string } }).roleRef.name)
      .toBe('yaac-server-test-ns')

    // Single writer: PGlite is embedded, so two servers of one install are
    // two writers of one directory. Recreate at one replica is what keeps
    // the lease from having to arbitrate on every roll.
    const [deployment] = applied('Deployment')
    expect(deployment.spec?.replicas).toBe(1)
    expect(deployment.spec?.strategy).toEqual({ type: 'Recreate' })
    const pod = deployedPodSpec()
    // Trusted yaac code: plain runc, no sentry.
    expect(pod.runtimeClassName).toBeUndefined()
    // The uid every path it pre-creates for a worktree pod is owned by —
    // the one install decided, which on kind is this host's (the data dir
    // is a hostPath this machine owns, and virtiofs makes that uid a
    // ceiling). Group 0 is what makes the image's own files writable at
    // that uid.
    expect(pod.securityContext).toMatchObject({
      runAsUser: process.getuid?.(),
      runAsGroup: process.getgid?.(),
      supplementalGroups: [0],
    })
    // No fsGroup: hostPath ownership is not the kubelet's to manage.
    expect(pod.securityContext).not.toHaveProperty('fsGroup')
    // And no setuid path to real root: group 0 plus a group-writable
    // /etc/passwd would otherwise reach it through `su`.
    expect(pod.containers[0].securityContext).toEqual({ allowPrivilegeEscalation: false })
    // The image is tagged by the bundle ALONE — no uid. One server image
    // per bundle, whoever built it (docs/arbitrary-uid-images.md).
    expect(pod.containers[0].image).toBe(
      `reg.local:5000/yaac-server:${stringHash('bundlehash')}`,
    )

    // The three tiers as three mounts: the two claims install bound, and
    // this node's own node-local tree. Nothing under the data dir by
    // hostPath.
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
    // And the claims were applied — PV then PVC per tier — before the
    // Deployment that names them, into the data dir's own folders.
    const pvs = applied('PersistentVolume') as unknown as Array<{ spec: { hostPath: { path: string } } }>
    expect(pvs.map((p) => p.spec.hostPath.path)).toEqual([
      path.join(tmpDir, 'global'), path.join(tmpDir, 'server-local'),
    ])
    expect(order('PersistentVolume')).toBeLessThan(order('PersistentVolumeClaim'))
    expect(order('PersistentVolumeClaim')).toBeLessThan(order('Deployment'))

    // The published origin, and the `server.json` that makes every client on
    // this machine resolve it without being told — including the record that
    // this data dir is a k8s install, so a later `yaac server start` finds
    // the Deployment instead of spawning a host server beside it.
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(await readServerConfig()).toMatchObject({
      url: origin, enabled: true, driver: 'k8s',
    })
    // The Deployment carries whose it is, which a later install compares.
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

    // No git identity: it is a server SETTING, in the database the pod
    // already mounts. `YAAC_GIT_*` is the same identity travelling the other
    // way, server into a worktree's environment.
    expect(env.YAAC_GIT_NAME).toBeUndefined()

    // A pod's loopback has no reachable backend, so the bind widens and the
    // ingress policy takes over as the wall.
    expect(env.YAAC_BIND_ADDR).toBe('0.0.0.0')
    expect(env.YAAC_SERVER_PORT).toBe(String(SERVER_POD_PORT))
    // The same absolute data dir, so dataDirHash() and every label carry
    // over unchanged into the pod — an identity string there, since what
    // the pod MOUNTS are the three tier roots it is told about here.
    expect(env.YAAC_DATA_DIR).toBe(tmpDir)
    expect(env.YAAC_GLOBAL_ROOT).toBe('/yaac/global')
    expect(env.YAAC_SERVER_LOCAL_ROOT).toBe('/yaac/server-local')
    expect(env.YAAC_NODE_LOCAL_ROOT).toBe('/yaac/node-local')
    expect(env.YAAC_DRIVER).toBe('k8s')
    // The two in-cluster shortcuts: the relay dials the proxy Service
    // instead of a port-forward, and IN_CLUSTER is what makes the registry
    // client dial Service DNS rather than forward to it.
    expect(env.YAAC_IN_CLUSTER).toBe('1')
    expect(env.YAAC_RELAY_ADDR).toContain('yaac-proxy.test-ns.svc.cluster.local:')
  })

  it('stamps the identity install decided, not the uid of the machine running it', async () => {
    // A byo install run from a laptop: the laptop's uid means nothing to
    // the cluster's NFS server, so install hands a fixed identity down and
    // the Deployment is where it is recorded.
    await deploy({ identity: { uid: 1000, gid: 1000 }, log: vi.fn() })
    expect(deployedPodSpec().securityContext).toEqual({
      runAsUser: 1000, runAsGroup: 1000, supplementalGroups: [0],
    })
  })

  it('carries the remote-hosting posture the install shell was given', async () => {
    // These belong to the DEPLOYMENT, not to a shell: there is no shell in
    // a pod to export them in afterwards, and `yaac server restart` only
    // rolls the pods the Deployment already describes. So a re-run of
    // `yaac cluster install` is how a tailnet-fronted server gets them.
    vi.stubEnv('YAAC_ALLOWED_HOSTS', 'srv.tailnet.ts.net')
    vi.stubEnv('YAAC_FORWARD_BIND', '100.64.0.7')

    await deploy({ log: vi.fn() })

    const env = Object.fromEntries(
      deployedPodSpec().containers[0].env.map((e) => [e.name, e.value]),
    )
    expect(env.YAAC_ALLOWED_HOSTS).toBe('srv.tailnet.ts.net')
    // The forwarded-port chips are rendered from the SNAPSHOT, which the
    // pod composes — so a tailnet bind address that stayed on the host
    // would leave every chip linking at the viewer's own loopback.
    expect(env.YAAC_FORWARD_BIND).toBe('100.64.0.7')
  })

  it('leaves the loopback defaults off the pod entirely', async () => {
    await deploy({ log: vi.fn() })

    const names = deployedPodSpec().containers[0].env.map((e) => e.name)
    expect(names).not.toContain('YAAC_ALLOWED_HOSTS')
    // Absent rather than the literal default: `env.forwardBind` answers
    // `127.0.0.1` for an unset var, so passing it through unconditionally
    // would pin a value nobody chose into every ordinary install.
    expect(names).not.toContain('YAAC_FORWARD_BIND')
  })

  it('rewrites an IPv6-loopback Tor SOCKS URL to the host, brackets and all', async () => {
    // `YAAC_USE_TOR` names a listener on the HOST, and a pod's loopback is
    // its own — so install rewrites the loopback halves to the host's
    // address on the kind network. The IPv6 form is the one that gets
    // missed: `new URL(...).hostname` yields `[::1]` WITH the brackets, so
    // a bare `::1` compare never fires and the pod silently keeps a URL
    // that reaches nothing. The symptom is every git fetch hanging.
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

    // The node addresses and the fronting, and nothing else. A worktree
    // pod dialing the Service or pod IP presents a POD source address,
    // which no rule names, and is dropped. A pod that got through could
    // claim a loopback Host and be the owner, so that is the entire wall,
    // which is why cluster check probes it. The kind fronting adds no peer: its forwarder is host-networked,
    // so its dial is already one of the node addresses.
    const [nodeHalf, frontHalf] = applied('NetworkPolicy')
    expect(nodeHalf.spec?.podSelector).toEqual({ matchLabels: { app: SERVER_APP_NAME } })
    expect(nodeHalf.spec?.policyTypes).toEqual(['Ingress'])
    expect(nodeHalf.spec?.ingress).toEqual([{
      from: [{ ipBlock: { cidr: '10.89.0.2/32' } }],
      ports: [{ protocol: 'TCP', port: SERVER_POD_PORT }],
    }])
    expect(frontHalf.spec?.podSelector).toEqual({ matchLabels: { app: SERVER_APP_NAME } })
    expect(frontHalf.spec?.ingress).toEqual([])

    // A ClusterIP, not a NodePort: the API is published on no node address
    // at all. What reaches it from the host is the forwarder below.
    const [svc] = applied('Service')
    expect(svc.spec?.type).toBe('ClusterIP')
    expect(svc.spec?.ports?.[0]).toMatchObject({ port: SERVER_POD_PORT, targetPort: SERVER_POD_PORT })
    expect(svc.spec?.ports?.[0]?.nodePort).toBeUndefined()
    // A tailnet install's Ingress is retired, or it would go on recording
    // the tailnet fronting for `server start` to wait on.
    expect(retried()).toContain(`delete ingress ${SERVER_APP_NAME} -n test-ns --ignore-not-found`)

    // The forwarder: a hostNetwork Envoy on the control-plane node — where
    // the kind port mapping delivers — binding the mapped port and dialing
    // the Service by name. In the node's own network namespace, so what
    // reaches the server pod is sourced from the node, on every platform.
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
    // Absolute, so the node's search domains (forwarded upstream) are never tried.
    expect(config.data?.['bootstrap.yaml']).toContain(`address: ${SERVER_APP_NAME}.test-ns.svc.cluster.local.,`)
    // Rolled out before the origin is probed, like the server itself.
    expect(retried().some((c) => c.includes(`rollout status deployment/${SERVER_FRONT_APP_NAME}`))).toBe(true)
  })

  it('publishes through the tailnet when told to', async () => {
    const ingress = tailnetIngress('yaac.tail1234.ts.net', 1)
    mockGetJson.mockImplementation((args: string[]) => Promise.resolve(
      args.includes('nodes')
        ? { items: [{ status: { addresses: [{ type: 'InternalIP', address: '10.89.0.2' }] } }] }
        : claimRead(args) ?? ingress(args),
    ))
    const log = vi.fn()

    const origin = await deploy({ fronting: tailnetFronting({ hostname: 'yaac' }), log })

    // A ClusterIP behind the operator's TLS Ingress, named for the server
    // so the proxy pod's labels name it too — never an L4 exposure, which
    // would hand the pod whatever headers a tailnet device sent. No kind
    // forwarder, and a kind install's forwarder is retired.
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
    expect(retried()).toContain(`delete deployment ${SERVER_FRONT_APP_NAME} -n test-ns --ignore-not-found`)

    // The fronting half of the wall selects the operator's proxy pod for
    // this Service, in the operator's namespace; the node half is as ever.
    const [nodeHalf, frontHalf] = applied('NetworkPolicy')
    expect(nodeHalf.spec?.ingress).toEqual([{
      from: [{ ipBlock: { cidr: '10.89.0.2/32' } }],
      ports: [{ protocol: 'TCP', port: SERVER_POD_PORT }],
    }])
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

    // The origin is the https name the operator published, read off the
    // Ingress AFTER it was applied and BEFORE the Deployment was rendered —
    // the Deployment has to admit that name, which puts every request
    // through the identity rule, since the tailnet is the trust boundary
    // now rather than this loopback.
    expect(origin).toBe('https://yaac.tail1234.ts.net')
    const env = Object.fromEntries(deployedPodSpec().containers[0].env.map((e) => [e.name, e.value]))
    expect(env.YAAC_ALLOWED_HOSTS).toBe('yaac.tail1234.ts.net')
    expect(vi.mocked(globalThis.fetch).mock.calls.some(([u]) => (u as string).startsWith(origin))).toBe(true)
    expect(await readServerConfig()).toMatchObject({ url: origin, enabled: true, driver: 'k8s' })
  })

  it('unions the fronting\'s hosts with the install shell\'s', async () => {
    // A host-side `tailscale serve` on the same machine is still a valid
    // way in (docs/remote-hosting.md), so what the shell carries is added
    // to what the fronting publishes, never replaced by it.
    vi.stubEnv('YAAC_ALLOWED_HOSTS', 'srv.tailnet.ts.net')
    mockGetJson.mockImplementation((args: string[]) => Promise.resolve(
      args.includes('nodes')
        ? { items: [{ status: { addresses: [{ type: 'InternalIP', address: '10.89.0.2' }] } }] }
        : claimRead(args) ?? tailnetIngress('yaac.tail1234.ts.net')(args),
    ))

    await deploy({ fronting: tailnetFronting({ hostname: 'yaac' }), log: vi.fn() })

    const env = Object.fromEntries(deployedPodSpec().containers[0].env.map((e) => [e.name, e.value]))
    expect(env.YAAC_ALLOWED_HOSTS.split(',').sort()).toEqual(['srv.tailnet.ts.net', 'yaac.tail1234.ts.net'])
  })

  it('refuses when the operator never publishes a hostname, before the Deployment', async () => {
    // Only the clock is faked: the deploy reads the host lock off real
    // disk first, and that I/O has to be able to land between ticks.
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    try {
      mockGetJson.mockImplementation((args: string[]) => Promise.resolve(
        args.includes('nodes')
          ? { items: [{ status: { addresses: [{ type: 'InternalIP', address: '10.89.0.2' }] } }] }
          : claimRead(args) ?? tailnetIngress('never', Number.MAX_SAFE_INTEGER)(args),
      ))
      let settled = false
      const pending = deploy({ fronting: tailnetFronting({ hostname: 'yaac' }), log: vi.fn() })
        .finally(() => { settled = true })
      const verdict = expect(pending).rejects.toThrow(/Tailscale operator did not publish/)
      // Tick until it settles: the deploy does real disk I/O (the lock read)
      // before it reaches the publish wait, and that needs a turn of the
      // loop between clock advances.
      for (let i = 0; i < 1_000 && !settled; i += 1) {
        await new Promise((r) => setImmediate(r))
        await vi.advanceTimersByTimeAsync(1_000)
      }
      await verdict
      // The Ingress is there for the operator to act on; nothing that
      // needs the origin was applied.
      expect(applied('Ingress')).toHaveLength(1)
      expect(applied('Deployment')).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reaches every namespace, because it creates namespaces', async () => {
    await deploy({ log: vi.fn() })

    // Per-project registries live in namespaces the server creates at
    // runtime, so a binding into the namespaces that exist today could not
    // cover them — hence a ClusterRole rather than a Role.
    const [role] = applied('ClusterRole')
    const rules = role.rules ?? []
    const core = rules.find((r) => r.apiGroups.includes('') && r.resources.includes('pods'))
    expect(core?.resources).toContain('namespaces')
    expect(core?.resources).toContain('pods/exec')
    // Read-only on what it only observes.
    const nodes = rules.find((r) => r.resources.includes('nodes'))
    expect(nodes?.verbs).toEqual(['get', 'list', 'watch'])
    // Enumerated, not `*` on `*`: it holds no reach over CRDs or anything
    // else nobody named.
    expect(rules.every((r) => !r.resources.includes('*'))).toBe(true)
  })

  it('warns, having registered, when the server will not identify this machine', async () => {
    // Under the tailnet fronting there is no loopback path, so this
    // machine's CLI goes through the identity rule like any device — and a
    // tagged device has no user to be. Said at install, not on the next
    // command.
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
    mockGetJson.mockImplementation((args: string[]) => {
      if (args.includes('nodes')) {
        return Promise.resolve({
          items: [{ status: { addresses: [{ type: 'InternalIP', address: '10.89.0.2' }] } }],
        })
      }
      if (args[1] === 'deployment') return Promise.resolve({ metadata: { name: SERVER_APP_NAME } })
      return Promise.resolve(claimRead(args))
    })

    await deploy({ log: vi.fn() })

    const calls = retried()
    const stopAt = calls.findIndex((c) => c.includes('scale') && c.includes('--replicas=0'))
    expect(stopAt).toBeGreaterThanOrEqual(0)
    // Waited on the pod's deletion, not just the scale.
    expect(calls[stopAt + 1]).toMatch(/wait pod .*--for=delete/)
    const deployOrder = mockApply.mock.invocationCallOrder[
      (mockApply.mock.calls as Array<[Manifest]>).findIndex(([m]) => m.kind === 'Deployment')]
    expect(mockWithRetry.mock.invocationCallOrder[stopAt]).toBeLessThan(deployOrder)
  })

  it('skips the stop when there is no Deployment yet', async () => {
    await deploy({ log: vi.fn() })
    expect(retried().some((c) => c.includes('--replicas=0'))).toBe(false)
  })

  it('refuses to deploy beside a host server that still holds the data dir', async () => {
    // The documented upgrade is `npm update`, then install — ordinarily run
    // on an install whose server is UP. Deploying into that is two servers
    // on one database, and the published-origin probe would be answered by
    // the very server being replaced. So it is refused here, on the host.
    await writeLock({
      pid: process.pid, port: 8787, startedAt: Date.now(), buildId: 'b',
      instance: 'inst-1', host: os.hostname(), heartbeatAt: Date.now(),
    })
    // /health answers, which with this process's own live pid is the whole
    // of "a host server is running".
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(
      new Response(JSON.stringify({ ok: true, ready: true }), { status: 200 }),
    )))

    await expect(deploy({ log: vi.fn() }))
      .rejects.toThrow(/already running.*host process[\s\S]*yaac server stop/)
    // Nothing applied: the refusal is before the first manifest, so a
    // failed install leaves the cluster exactly as it found it.
    expect(mockApply).not.toHaveBeenCalled()
  })

  it('rolls its own pod without complaint — an off-host lock is what a re-install replaces', async () => {
    // The guard must not fire on the ordinary case. An in-cluster server's
    // lock names another host, and rolling it IS what install does; the
    // Deployment's Recreate strategy sequences that.
    await writeLock({
      pid: 1, port: 8787, startedAt: Date.now(), buildId: 'b',
      instance: 'abc', host: 'yaac-server-77d4f', heartbeatAt: Date.now(),
    })

    await expect(deploy({ log: vi.fn() })).resolves.toMatch(/^http:/)
  })

  it('deploys past a host lock whose server is gone', async () => {
    // A stale lock is a leftover, not a running server — refusing on one
    // would make a crashed server permanently un-upgradable.
    const DEAD_PORT = 1
    await writeLock({
      pid: process.pid, port: DEAD_PORT, startedAt: Date.now(), buildId: 'b',
      instance: 'inst-1', host: os.hostname(), heartbeatAt: Date.now(),
    })
    // Nothing answers on the lock's port, which for a same-host lock is
    // what "gone" looks like even while its pid (this test process) exists.
    // Every other origin — the published one this install waits on — still
    // answers.
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
  it('is how the CLI tells a deployed server from a host process', async () => {
    mockGetJson.mockResolvedValueOnce({ metadata: { name: SERVER_APP_NAME } })
    expect(await serverDeploymentExists()).toBe(true)
    mockGetJson.mockResolvedValueOnce(null)
    expect(await serverDeploymentExists()).toBe(false)
  })

  it('raises a could-not-ask rather than answering "no Deployment"', async () => {
    // The distinction is load-bearing, and the CLI depends on it: an unset
    // kubeconfig or an apiserver blip answered as `false` would send a k8s
    // install down the HOST path, where `stop` clears a live pod's lock and
    // `start` puts a second server on its data dir. Absent is a fact;
    // unreachable is a refusal.
    mockGetJson.mockRejectedValueOnce(new Error('The connection to the server was refused'))
    await expect(serverDeploymentExists()).rejects.toThrow(/connection to the server/)
  })
})

describe('startClusterServer', () => {
  it('scales the Deployment back up rather than spawning anything, and answers the origin', async () => {
    vi.stubEnv('YAAC_SERVER_PORT', '9123')
    // The live Ingress is the record of the fronting: none at all (every
    // kind install, and the e2e harness) is the kind fronting, so the
    // origin is the loopback one.
    mockGetJson.mockResolvedValue(null)
    await expect(startClusterServer()).resolves.toBe('http://127.0.0.1:9123')
    // Named outright, so the node's mapping is not asked.
    expect(mockPodmanPort).not.toHaveBeenCalled()
    const calls = retried()
    expect(calls.some((c) => c.includes('scale') && c.includes('--replicas=1'))).toBe(true)
    expect(calls.some((c) => c.includes('rollout status'))).toBe(true)
    // A log reader left holding an attach-once claim would pin the server
    // to its node, so it goes first.
    expect(calls.findIndex((c) => c.includes('delete pod yaac-server-log-reader')))
      .toBeLessThan(calls.findIndex((c) => c.includes('scale')))
  })

  it('waits on the port the cluster was created with, not this shell\'s default', async () => {
    // kind fixes the host port at create time. A cluster created under
    // another YAAC_SERVER_PORT still holds that one, so an unset variable
    // here is read off the node's mapping — not taken to mean 8787, where
    // some other server may well be answering.
    vi.stubEnv('YAAC_SERVER_PORT', '')
    mockGetJson.mockResolvedValue(null)
    mockPodmanPort.mockResolvedValue({ stdout: '127.0.0.1:8866\n', stderr: '' })
    await expect(startClusterServer()).resolves.toBe('http://127.0.0.1:8866')
    expect(mockPodmanPort).toHaveBeenCalledWith(['port', 'yaac-control-plane', `${String(SERVER_FRONT_PORT)}/tcp`])
    expect(vi.mocked(globalThis.fetch).mock.calls.every(([u]) =>
      (u as string).startsWith('http://127.0.0.1:8866/'))).toBe(true)
  })

  it('refuses rather than guess a port when the node\'s mapping cannot be read', async () => {
    // Whatever answers a guessed port is not this cluster — and install
    // would register it. A node created before the mapping existed gets the
    // recreate advice at once, not after a 60s wait on nothing.
    vi.stubEnv('YAAC_SERVER_PORT', '')
    mockGetJson.mockResolvedValue(null)
    mockPodmanPort.mockRejectedValueOnce(Object.assign(new Error('exit 125'), {
      stderr: 'Error: failed to find published port "30787/tcp"\n',
    }))
    await expect(startClusterServer()).rejects.toThrow(/publishes no host port[\s\S]*yaac cluster delete/)
    // Any other podman failure is reported in podman's words, and is not
    // mistaken for a cluster that needs recreating.
    mockPodmanPort.mockRejectedValueOnce(Object.assign(new Error('exit 125'), {
      stderr: 'Error: unable to connect to Podman socket\n',
    }))
    const other = startClusterServer()
    await expect(other).rejects.toThrow(/unable to connect to Podman socket/)
    await expect(other).rejects.not.toThrow(/yaac cluster delete/)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('waits on the tailnet origin when that is what the live Ingress records', async () => {
    mockGetJson.mockImplementation((args: string[]) =>
      Promise.resolve(tailnetIngress('yaac.tail1234.ts.net')(args)))
    await expect(startClusterServer()).resolves.toBe('https://yaac.tail1234.ts.net')
    expect(vi.mocked(globalThis.fetch).mock.calls.every(([u]) =>
      (u as string).startsWith('https://yaac.tail1234.ts.net'))).toBe(true)
  })

  it('turns a rolled-out Deployment that never answers into the fix for it', async () => {
    // A Deployment that is Available while 127.0.0.1 refuses is not a
    // server problem: it is a cluster created before the port mapping
    // existed, and kind writes mappings only at create time — which cannot
    // be converged, only recreated. The fronting supplies that diagnosis.
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

  it('points an origin that answers 404 at a re-install, never at recreating the cluster', async () => {
    // A Deployment an older yaac installed runs an image whose routes
    // predate this CLI's: reached, so the fronting's "recreate it" advice
    // (which loses every worktree) is wrong, and a re-install is the fix.
    vi.useFakeTimers()
    try {
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 404 }))))
      const pending = startClusterServer()
      const verdict = expect(pending).rejects.toThrow(/answered HTTP 404[\s\S]*yaac cluster install`\.$/)
      await vi.advanceTimersByTimeAsync(61_000)
      await verdict
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits out an answering-but-still-initializing server', async () => {
    // /health answers before the DB is open, so `ready` is the gate: a
    // 200 alone would report a server the next command cannot use.
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
  it('scales to zero, keeping the RBAC and Service a later start needs', async () => {
    await stopClusterServer()
    const calls = retried()
    expect(calls.some((c) => c.includes('scale') && c.includes('--replicas=0'))).toBe(true)
    // A `kubectl delete` would take the RBAC and the Service with it, so
    // undoing a stop would be a full install rather than a start.
    expect(calls.some((c) => c.startsWith('delete '))).toBe(false)
  })

  it('waits on the pod going away, not on a replica count that disappears', async () => {
    await stopClusterServer()
    const calls = retried()
    // `status.replicas` is omitted at zero, so a jsonpath wait for `=0`
    // never matches and every successful stop pays the whole timeout.
    expect(calls.some((c) => c.includes('jsonpath'))).toBe(false)
    expect(calls.some((c) => c.includes('wait pod') && c.includes('--for=delete'))).toBe(true)
  })

  it('does not fail the stop when the drain outlives the wait', async () => {
    // The scale is recorded either way, and a successor waits on the lease
    // going stale rather than on this.
    mockWithRetry.mockImplementation((args: string[]) =>
      args[0] === 'wait'
        ? Promise.reject(new Error('timed out'))
        : Promise.resolve({ stdout: '', stderr: '' }))
    await expect(stopClusterServer()).resolves.toBeUndefined()
  })
})

describe('restartClusterServer', () => {
  it('rolls the pod and waits for the published origin to answer again', async () => {
    await expect(restartClusterServer()).resolves.toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const calls = retried()
    expect(calls.findIndex((c) => c.includes('delete pod yaac-server-log-reader')))
      .toBeLessThan(calls.findIndex((c) => c.includes('rollout restart')))
    expect(calls.findIndex((c) => c.includes('delete pod yaac-server-log-reader'))).toBeGreaterThanOrEqual(0)
    expect(calls.some((c) => c.includes('rollout status'))).toBe(true)
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalled()
  })
})

describe('deployedInstallIdentity', () => {
  it('reads the identity back off the live Deployment, which is its record', async () => {
    // What `cluster check` and the e2e harness run their pods at: on a byo
    // install that is not the uid of the machine asking.
    mockGetJson.mockResolvedValueOnce({
      spec: { template: { spec: { securityContext: { runAsUser: 1234, runAsGroup: 1234 } } } },
    })
    await expect(deployedInstallIdentity(false)).resolves.toEqual({ uid: 1234, gid: 1234 })
    expect(mockGetJson).toHaveBeenLastCalledWith(['get', 'deployment', SERVER_APP_NAME, '-n', 'test-ns'])
  })

  it('with no Deployment, is what install would deploy — never a guess past a failed read', async () => {
    mockGetJson.mockResolvedValueOnce(null)
    await expect(deployedInstallIdentity(false)).resolves.toEqual(processIdentity())
    mockGetJson.mockResolvedValueOnce(null)
    await expect(deployedInstallIdentity(true)).resolves.toEqual({ uid: 1000, gid: 1000 })
    mockGetJson.mockRejectedValueOnce(new Error('Unable to connect to the server'))
    await expect(deployedInstallIdentity(true)).rejects.toThrow(/Unable to connect/)
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
    mockGetJson.mockImplementation((args: string[]) => Promise.resolve(
      args[1] === 'pods'
        ? {
          items: pods.map((p) => ({
            metadata: { name: p.name },
            spec: { nodeName: p.node },
            status: { containerStatuses: [{ name: 'server', state: p.running ? { running: {} } : { waiting: {} } }] },
          })),
        }
        : {
          spec: { template: { spec: {
            securityContext: { runAsUser: 1000, runAsGroup: 1000, supplementalGroups: [0] },
            containers: [{ name: 'server', image: 'reg.local:5000/yaac-server:abc' }],
          } } },
        },
    ))
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
    expect(mockApply).not.toHaveBeenCalled()

    fakeKubectl('', 0)
    await clusterServerLogs({ follow: true, lines: 5 })
    expect(mockSpawn.mock.lastCall?.[1]).toEqual(expect.arrayContaining(['-F', '-n', '5']))
    fakeKubectl('', 0)
    await clusterServerLogs({ lines: -3 })
    expect(mockSpawn.mock.lastCall?.[1]).toEqual(expect.arrayContaining(['-n', '0']))
  })

  it('reads a down server\'s log through a read-only reader pod on its node, and removes it', async () => {
    // Crash-looping: a pod, but no running container — when the log matters most.
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
    // Pinned where an attach-once volume already is; the server's own image
    // and identity; the claim read-only; bounded if the CLI is killed hard.
    expect(reader.spec.nodeName).toBe('pool-2')
    expect(reader.spec.containers[0].image).toBe('reg.local:5000/yaac-server:abc')
    expect(reader.spec.securityContext).toMatchObject({ runAsUser: 1000, runAsGroup: 1000 })
    expect(reader.spec.volumes[0].persistentVolumeClaim).toEqual({ claimName: 'yaac-server-local', readOnly: true })
    expect(reader.spec.containers[0].volumeMounts[0]).toEqual({ name: 'server-local', mountPath: '/yaac/server-local', readOnly: true })
    expect(reader.spec.activeDeadlineSeconds).toBeGreaterThan(0)
    expect((mockSpawn.mock.lastCall?.[1] as string[]).slice(0, 6)).toEqual(['exec', 'yaac-server-log-reader', '-n', 'test-ns', '-c', 'reader'])
    expect(written.join('')).toContain('fatal: boom')
    const deletes = (mockWithRetry.mock.calls as Array<[string[]]>).map(([a]) => a.join(' '))
      .filter((a) => a.startsWith('delete pod yaac-server-log-reader'))
    expect(deletes).toHaveLength(2)
    // Exec'd only once Ready: kubectl exec does not wait for a pod named directly.
    const calls = retried()
    const ready = calls.findIndex((c) => c.startsWith('wait --for=condition=Ready pod/yaac-server-log-reader'))
    expect(ready).toBeGreaterThan(calls.findIndex((c) => c.startsWith('delete pod yaac-server-log-reader')))

    // Scaled to zero: no pod at all, so no node to pin to.
    mockApply.mockClear()
    cluster([])
    fakeKubectl('', 1, 'error: unable to upgrade connection\n')
    await expect(clusterServerLogs()).rejects.toThrow(/could not read the server log in pod yaac-server-log-reader: error: unable to upgrade/)
    expect((applied('Pod')[0] as unknown as { spec: { nodeName?: string } }).spec.nodeName).toBeUndefined()
    // ...and the reader is removed on failure too.
    expect((mockWithRetry.mock.lastCall as [string[]])[0].slice(0, 3)).toEqual(['delete', 'pod', 'yaac-server-log-reader'])

    // A reader that never starts is said to be the reader, not an exec error,
    // and nothing is exec'd into it.
    const execs = mockSpawn.mock.calls.length
    const base = mockWithRetry.getMockImplementation()
    mockWithRetry.mockImplementation((args: string[]) => args[0] === 'wait'
      ? Promise.reject(new Error('timed out waiting for the condition'))
      : ((base?.(args) as Promise<{ stdout: string; stderr: string }> | undefined) ?? Promise.resolve({ stdout: '', stderr: '' })))
    await expect(clusterServerLogs()).rejects.toThrow(/log reader pod did not become Ready within 120s \(timed out/)
    expect(mockSpawn.mock.calls.length).toBe(execs)
    expect((mockWithRetry.mock.lastCall as [string[]])[0].slice(0, 3)).toEqual(['delete', 'pod', 'yaac-server-log-reader'])
    mockWithRetry.mockImplementation(base ?? (() => Promise.resolve({ stdout: '', stderr: '' })))
  })
})
