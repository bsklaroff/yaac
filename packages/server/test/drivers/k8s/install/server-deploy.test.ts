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
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import type * as kubectlModule from '#drivers/k8s/substrate/kubectl'
import type * as registryModule from '#drivers/k8s/container/registry'
import type * as imageEngineModule from '#drivers/k8s/image-engine'

vi.mock('#log', () => ({ serverLog: vi.fn(), pipeToServerLog: vi.fn() }))

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

import {
  deployServerWorkload,
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
    loadBalancerClass?: string
    allocateLoadBalancerNodePorts?: boolean
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
 * A tailnet-fronted Service as the apiserver reports it once the operator
 * has published — what `get service` answers after `publishedAfter` reads.
 */
function tailnetService(hostname: string, publishedAfter = 0): (args: string[]) => unknown {
  let reads = 0
  return (args: string[]) => {
    if (!args.includes('service')) return null
    reads += 1
    return {
      metadata: { annotations: { 'tailscale.com/hostname': 'yaac' } },
      spec: { type: 'LoadBalancer', loadBalancerClass: 'tailscale' },
      status: reads > publishedAfter ? { loadBalancer: { ingress: [{ ip: '100.64.0.9', hostname }] } } : {},
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
  return deployServerWorkload({ fronting: kindFronting(), ...opts })
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
    // input to the Deployment's environment. The forwarder comes last —
    // on a converging install the Service apply is what releases the old
    // NodePort on the node before the forwarder binds it.
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
    // this HOST's, not a pinned constant. The data dir is a hostPath this
    // machine owns and virtiofs makes that uid a ceiling, so a pod running
    // as anything else cannot write the directory it was just handed. Group
    // 0 is what makes the image's own files writable at that uid.
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
  })

  it('hands the pod what it can no longer read off a host, and no host-side shim', async () => {
    await deploy({
      log: vi.fn(),
      torHostAddr: '10.89.0.1',
    })

    const env = Object.fromEntries(
      deployedPodSpec().containers[0].env.map((e) => [e.name, e.value]),
    )

    // No git identity: it is a server SETTING now, in the database the pod
    // already mounts, rather than a snapshot install took off whichever host
    // it happened to run on. `YAAC_GIT_*` stays absent for its own reason —
    // that pair is the same identity travelling the other way, server into a
    // worktree's environment.
    expect(env.YAAC_SERVER_GIT_NAME).toBeUndefined()
    expect(env.YAAC_SERVER_GIT_EMAIL).toBeUndefined()
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

  it('carries the remote-hosting posture the install shell was given', async () => {
    // These belong to the DEPLOYMENT, not to a shell: there is no shell in
    // a pod to export them in afterwards, and `yaac server restart` only
    // rolls the pods the Deployment already describes. So a re-run of
    // `yaac cluster install` is how a tailnet-fronted server gets them,
    // and the install log says so when they turn the credential gate on.
    vi.stubEnv('YAAC_ALLOWED_HOSTS', 'srv.tailnet.ts.net')
    vi.stubEnv('YAAC_TRUST_PROXY', '1')
    vi.stubEnv('YAAC_FORWARD_BIND', '100.64.0.7')
    const log = vi.fn()

    await deploy({ log })

    const env = Object.fromEntries(
      deployedPodSpec().containers[0].env.map((e) => [e.name, e.value]),
    )
    expect(env.YAAC_ALLOWED_HOSTS).toBe('srv.tailnet.ts.net')
    expect(env.YAAC_TRUST_PROXY).toBe('1')
    // The forwarded-port chips are rendered from the SNAPSHOT, which the
    // pod composes — so a tailnet bind address that stayed on the host
    // would leave every chip linking at the viewer's own loopback.
    expect(env.YAAC_FORWARD_BIND).toBe('100.64.0.7')
    expect(log.mock.calls.flat().join('\n')).toMatch(/REQUIRE a credential/)
  })

  it('leaves the loopback defaults off the pod entirely', async () => {
    await deploy({ log: vi.fn() })

    const names = deployedPodSpec().containers[0].env.map((e) => e.name)
    expect(names).not.toContain('YAAC_ALLOWED_HOSTS')
    expect(names).not.toContain('YAAC_TRUST_PROXY')
    // Absent rather than the literal default: `env.forwardBind` answers
    // `127.0.0.1` for an unset var, so passing it through unconditionally
    // would pin a value nobody chose into every ordinary install.
    expect(names).not.toContain('YAAC_FORWARD_BIND')
  })

  it('states no git identity when the host has none', async () => {
    // An unconfigured host is not a failed install: the CLI resolves (and
    // prompts for) its own identity per worktree, so only webapp-created
    // worktrees are affected — and they get the error `createWorktree`
    // raises rather than a pod committing as somebody else.
    await deploy({ log: vi.fn() })

    const names = deployedPodSpec().containers[0].env.map((e) => e.name)
    expect(names).not.toContain('YAAC_SERVER_GIT_NAME')
    expect(names).not.toContain('YAAC_SERVER_GIT_EMAIL')
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
    // which no rule names, and is dropped. On a credential-optional local
    // install that is the entire wall, which is why cluster check probes
    // it. The kind fronting adds no peer: its forwarder is host-networked,
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
    const svc = tailnetService('yaac.tail1234.ts.net', 1)
    mockGetJson.mockImplementation((args: string[]) => Promise.resolve(
      args.includes('nodes')
        ? { items: [{ status: { addresses: [{ type: 'InternalIP', address: '10.89.0.2' }] } }] }
        : claimRead(args) ?? svc(args),
    ))
    const log = vi.fn()

    const origin = await deploy({ fronting: tailnetFronting({ hostname: 'yaac' }), log })

    // The operator's LoadBalancer Service, and no NodePort on the side —
    // that would publish the API on every node address of a pool behind
    // nothing but the policy.
    const [service] = applied('Service')
    expect(service.spec?.type).toBe('LoadBalancer')
    expect(service.spec?.loadBalancerClass).toBe('tailscale')
    expect(service.spec?.allocateLoadBalancerNodePorts).toBe(false)
    expect((service.metadata as { annotations: Record<string, string> }).annotations)
      .toEqual({ 'tailscale.com/hostname': 'yaac' })
    expect(applied('ConfigMap')).toHaveLength(0)

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

    // The origin is what the operator published, read off the Service
    // AFTER it was applied and BEFORE the Deployment was rendered — the
    // Deployment has to admit that name, which is what requires a
    // credential, since the tailnet is the trust boundary now rather than
    // this loopback. Not TRUST_PROXY: an L4 exposure sanitizes no header,
    // so trusting X-Forwarded-* would hand them to any tailnet client.
    expect(origin).toBe('http://yaac.tail1234.ts.net')
    const env = Object.fromEntries(deployedPodSpec().containers[0].env.map((e) => [e.name, e.value]))
    expect(env.YAAC_ALLOWED_HOSTS).toBe('yaac.tail1234.ts.net')
    expect(env.YAAC_TRUST_PROXY).toBeUndefined()
    expect(log.mock.calls.flat().join('\n')).toMatch(/REQUIRE a credential/)
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
        : claimRead(args) ?? tailnetService('yaac.tail1234.ts.net')(args),
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
          : claimRead(args) ?? tailnetService('never', Number.MAX_SAFE_INTEGER)(args),
      ))
      let settled = false
      const pending = deploy({ fronting: tailnetFronting({ hostname: 'yaac' }), log: vi.fn() })
        .finally(() => { settled = true })
      const verdict = expect(pending).rejects.toThrow(/Tailscale operator did not publish/)
      // Tick until it settles: the deploy does real disk I/O (the lock read,
      // the layout migration) before it reaches the publish wait, and each
      // of those needs a turn of the loop between clock advances.
      for (let i = 0; i < 1_000 && !settled; i += 1) {
        await new Promise((r) => setImmediate(r))
        await vi.advanceTimersByTimeAsync(1_000)
      }
      await verdict
      // The Service is there for the operator to act on; nothing that
      // needs the origin was applied.
      expect(applied('Service')).toHaveLength(1)
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

  it('mints the durable token with the lock the pod holds, never the host\'s', async () => {
    // The lock is the server's file. On kind the host could still read it;
    // on a cloud cluster the data dir is not on this machine at all, and a
    // mint that silently fails there is a lockout on an install that
    // requires a credential. One path for both: ask the pod.
    mockWithRetry.mockImplementation((args: string[]) => Promise.resolve(
      args[0] === 'exec' && args.join(' ').includes('.server.lock')
        ? { stdout: JSON.stringify({ pid: 1, port: 8787, secret: 'podsecret', startedAt: 1, buildId: 'b' }), stderr: '' }
        : { stdout: '', stderr: '' },
    ))
    const seen: Array<{ url: string; auth: string | undefined; method: string }> = []
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined
      seen.push({ url: String(url), auth: headers?.authorization, method: init?.method ?? 'GET' })
      if (String(url).endsWith('/tokens') && init?.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({ token: 'minted-by-pod' }), { status: 200 }))
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true, ready: true }), { status: 200 }))
    }))

    await deploy({ log: vi.fn() })

    const execCall = (mockWithRetry.mock.calls as Array<[string[]]>)
      .map(([a]) => a).find((a) => a[0] === 'exec')
    expect(execCall).toContain(`deployment/${SERVER_APP_NAME}`)
    expect(seen.find((s) => s.method === 'POST')?.auth).toBe('Bearer podsecret')
    expect((await readServerConfig())?.token).toBe('minted-by-pod')
  })

  it('stops the pod that is there, then moves the data dir into the tier layout, then deploys', async () => {
    // An install upgrading from before the storage tiers were folders: the
    // old pod holds PGlite open at `<dataDir>/db` and heartbeats its lock
    // there. The order is the whole safety argument — the rename runs only
    // once the pod is gone (docs/legacy-compat-shims.md).
    mockGetJson.mockImplementation((args: string[]) => {
      if (args.includes('nodes')) {
        return Promise.resolve({
          items: [{ status: { addresses: [{ type: 'InternalIP', address: '10.89.0.2' }] } }],
        })
      }
      if (args[1] === 'deployment') return Promise.resolve({ metadata: { name: SERVER_APP_NAME } })
      return Promise.resolve(claimRead(args))
    })
    await fs.mkdir(path.join(tmpDir, 'projects', 'demo'), { recursive: true })
    await fs.mkdir(path.join(tmpDir, 'db'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'secret.key'), 'k')
    const log = vi.fn()

    await deploy({ log })

    const calls = retried()
    const stopAt = calls.findIndex((c) => c.includes('scale') && c.includes('--replicas=0'))
    expect(stopAt).toBeGreaterThanOrEqual(0)
    // Waited on the pod's deletion, not just the scale.
    expect(calls[stopAt + 1]).toMatch(/wait pod .*--for=delete/)
    // The Deployment was applied after the stop.
    const deployOrder = mockApply.mock.invocationCallOrder[
      (mockApply.mock.calls as Array<[Manifest]>).findIndex(([m]) => m.kind === 'Deployment')]
    expect(mockWithRetry.mock.invocationCallOrder[stopAt]).toBeLessThan(deployOrder)
    // And the move landed in between: the log says so in order.
    const lines = log.mock.calls.map(([m]) => String(m))
    const stopLine = lines.findIndex((l) => /Stopping the running server pod/.test(l))
    const moveLine = lines.findIndex((l) => /\[layout\] moved .*\/db ->/.test(l))
    const deployLine = lines.findIndex((l) => /Deploying the yaac server/.test(l))
    expect(stopLine).toBeGreaterThanOrEqual(0)
    expect(stopLine).toBeLessThan(moveLine)
    expect(moveLine).toBeLessThan(deployLine)
    await expect(fs.access(path.join(tmpDir, 'server-local', 'db'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(tmpDir, 'server-local', 'secret.key'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(tmpDir, 'global', 'projects', 'demo'))).resolves.toBeUndefined()
  })

  it('skips the stop when there is no Deployment yet, and still migrates', async () => {
    await fs.mkdir(path.join(tmpDir, 'projects', 'demo'), { recursive: true })
    await deploy({ log: vi.fn() })
    expect(retried().some((c) => c.includes('--replicas=0'))).toBe(false)
    await expect(fs.access(path.join(tmpDir, 'global', 'projects', 'demo'))).resolves.toBeUndefined()
  })

  it('refuses to deploy beside a host server that still holds the data dir', async () => {
    // The documented upgrade is `npm update`, then install — ordinarily run
    // on an install whose server is UP. Deploying into that is two writers
    // on one database, and neither guard downstream catches it: a
    // pre-lease lock reads as same-host inside the pod (no `host` field),
    // so the pod judges it by a pid in its own namespace, calls it stale
    // and takes it; and the published-origin probe would be answered by
    // the very server being replaced. So it is refused here, on the host,
    // where the lock still means what it says.
    await writeLock({
      pid: process.pid, port: 8787, secret: 's', startedAt: Date.now(), buildId: 'b',
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

  it('refuses a CURRENT host server too, not just a pre-lease one', async () => {
    // The commoner case, and the one a "no host field" check waves
    // through: a server on this machine that DOES write the lease fields.
    // It fails differently — the pod crash-loops on the held lock and the
    // rollout times out after five minutes — but it is the same two
    // servers on one data dir, and the same one-line refusal fixes it.
    await writeLock({
      pid: process.pid, port: 8787, secret: 's', startedAt: Date.now(), buildId: 'b',
      instance: 'inst-1', host: os.hostname(), heartbeatAt: Date.now(),
    })

    await expect(deploy({ log: vi.fn() }))
      .rejects.toThrow(/already running.*host process/)
    expect(mockApply).not.toHaveBeenCalled()
  })

  it('rolls its own pod without complaint — an off-host lock is what a re-install replaces', async () => {
    // The guard must not fire on the ordinary case. An in-cluster server's
    // lock names another host, and rolling it IS what install does; the
    // Deployment's Recreate strategy sequences that.
    await writeLock({
      pid: 1, port: 8787, secret: 's', startedAt: Date.now(), buildId: 'b',
      instance: 'abc', host: 'yaac-server-77d4f', heartbeatAt: Date.now(),
    })

    await expect(deploy({ log: vi.fn() })).resolves.toMatch(/^http:/)
  })

  it('deploys past a host lock whose server is gone', async () => {
    // A stale lock is a leftover, not a running server — refusing on one
    // would make a crashed server permanently un-upgradable.
    const DEAD_PORT = 1
    await writeLock({
      pid: process.pid, port: DEAD_PORT, secret: 's', startedAt: Date.now(), buildId: 'b',
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
    // The live Service is the record of the fronting: a ClusterIP (or a
    // NodePort from an install not yet re-converged, or none at all — the
    // e2e harness) is the kind fronting, so the origin is the loopback one.
    mockGetJson.mockImplementation((args: string[]) => Promise.resolve(
      args.includes('service') ? { spec: { type: 'ClusterIP' } } : null,
    ))
    await expect(startClusterServer()).resolves.toBe('http://127.0.0.1:9123')
    const calls = retried()
    expect(calls.some((c) => c.includes('scale') && c.includes('--replicas=1'))).toBe(true)
    expect(calls.some((c) => c.includes('rollout status'))).toBe(true)
  })

  it('waits on the tailnet origin when that is what the live Service records', async () => {
    mockGetJson.mockImplementation((args: string[]) =>
      Promise.resolve(tailnetService('yaac.tail1234.ts.net')(args)))
    await expect(startClusterServer()).resolves.toBe('http://yaac.tail1234.ts.net')
    expect(vi.mocked(globalThis.fetch).mock.calls.every(([u]) =>
      (u as string).startsWith('http://yaac.tail1234.ts.net'))).toBe(true)
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
    expect(calls.some((c) => c.includes('rollout restart'))).toBe(true)
    expect(calls.some((c) => c.includes('rollout status'))).toBe(true)
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalled()
  })
})
