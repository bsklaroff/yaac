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
import os from 'node:os'
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
  waitForPublishedServer,
  serverDeploymentExists,
  serverPublishedOrigin,
  startClusterServer,
  stopClusterServer,
} from '#drivers/k8s/install'
// Setup values: the names and ports the datapath vocabulary fixes, so the
// assertions below name the same constants the manifests do rather than
// re-spelling them.
import {
  SERVER_APP_NAME,
  SERVER_NODE_PORT,
  SERVER_POD_PORT,
  podUid,
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
  rules?: Array<{ apiGroups: string[]; resources: string[]; verbs: string[] }>
  spec?: Record<string, unknown> & {
    replicas?: number
    strategy?: unknown
    type?: string
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
  securityContext?: Record<string, number>
  volumes: Array<{ hostPath?: { path: string } }>
  containers: Array<{
    image: string
    env: Array<{ name: string; value: string }>
    volumeMounts: Array<{ mountPath: string }>
  }>
}

function applied(kind: string): Manifest[] {
  return (mockApply.mock.calls as Array<[Manifest]>)
    .map(([m]) => m)
    .filter((m) => m.kind === kind)
}

/** The pod spec of the one Deployment this run applied. */
function deployedPodSpec(): PodSpec {
  const [deployment] = applied('Deployment')
  const template = deployment.spec?.template
  if (!template) throw new Error('no Deployment pod template was applied')
  return template.spec
}

/** The kubectl argv of every retrying call, joined for substring matching. */
function retried(): string[] {
  return (mockWithRetry.mock.calls as Array<[string[]]>).map(([args]) => args.join(' '))
}

let tmpDir: string

beforeEach(async () => {
  vi.clearAllMocks()
  resetClusterCidrCache()
  tmpDir = await createTempDataDir()
  mockApply.mockResolvedValue(undefined)
  mockWithRetry.mockResolvedValue({ stdout: '', stderr: '' })
  // One node carrying a pod CIDR, so the ingress policy has a concrete
  // range to EXCLUDE (the shape of the rule is "everything but a pod").
  mockGetJson.mockImplementation((args: string[]) => {
    if (args.includes('nodes')) {
      return Promise.resolve({
        items: [{
          spec: { podCIDR: '10.244.0.0/24' },
          status: { addresses: [{ type: 'InternalIP', address: '10.89.0.2' }] },
        }],
      })
    }
    return Promise.resolve(null)
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
    const origin = await deployServerWorkload({ log: vi.fn() })

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
    // as anything else cannot write the directory it was just handed.
    expect(pod.securityContext).toMatchObject({
      runAsUser: podUid(),
      runAsGroup: process.getgid?.(),
      fsGroup: process.getgid?.(),
    })
    // And the image it runs is tagged by that uid, not by the bundle alone.
    // Without the uid in the TAG, a host would find a tag already in the
    // registry whose `yaac` user is a number this Deployment does not run
    // as — a pod with no such user and a HOME belonging to someone else.
    expect(pod.containers[0].image).toBe(
      `reg.local:5000/yaac-server:${stringHash(`bundlehash:uid=${String(podUid())}`)}`,
    )

    // The whole data dir, at its own absolute path: phase 2 moves the
    // process, not the storage, so everything inside the pod resolves
    // exactly as it did on the host.
    expect(pod.volumes[0].hostPath?.path).toBe(tmpDir)
    expect(pod.containers[0].volumeMounts[0].mountPath).toBe(tmpDir)

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
    await deployServerWorkload({
      log: vi.fn(),
      torHostAddr: '10.89.0.1',
      gitUser: { name: 'Ada Lovelace', email: 'ada@example.com' },
    })

    const env = Object.fromEntries(
      deployedPodSpec().containers[0].env.map((e) => [e.name, e.value]),
    )

    // The git identity non-interactive worktree creation commits under. The
    // pod cannot read it: `git config --global` there reads a `$HOME` that
    // is an ephemeral image layer, and the data dir is the only host mount.
    // Named apart from the `YAAC_GIT_*` pair, which is the same identity
    // travelling the other way — server into a worktree's environment.
    expect(env.YAAC_SERVER_GIT_NAME).toBe('Ada Lovelace')
    expect(env.YAAC_SERVER_GIT_EMAIL).toBe('ada@example.com')
    expect(env.YAAC_GIT_NAME).toBeUndefined()

    // A pod's loopback has no reachable backend, so the bind widens and the
    // ingress policy takes over as the wall.
    expect(env.YAAC_BIND_ADDR).toBe('0.0.0.0')
    expect(env.YAAC_SERVER_PORT).toBe(String(SERVER_POD_PORT))
    // The same absolute data dir, so dataDirHash() and every label carry
    // over unchanged into the pod.
    expect(env.YAAC_DATA_DIR).toBe(tmpDir)
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

    await deployServerWorkload({ log })

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
    await deployServerWorkload({ log: vi.fn() })

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
    await deployServerWorkload({ log: vi.fn() })

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

    await deployServerWorkload({ log: vi.fn(), torHostAddr: '10.89.0.1' })

    const env = Object.fromEntries(
      deployedPodSpec().containers[0].env.map((e) => [e.name, e.value]),
    )
    expect(env.YAAC_HOST_TOR_SOCKS_URL).toBe('socks5h://10.89.0.1:9050')
  })

  it('walls the API off from pods, on a NodePort the host maps', async () => {
    await deployServerWorkload({ log: vi.fn() })

    // Everything EXCEPT the pod CIDRs — not the node CIDRs. kube-proxy
    // masquerades in POSTROUTING, after the filter hook, so the policy sees
    // the original off-cluster source and a node-address rule would drop
    // the only traffic it exists to admit. A worktree pod dialing the
    // Service or pod IP presents a POD source address and is dropped. On a
    // credential-optional local install that is the entire wall, which is
    // why cluster check probes it.
    const [np] = applied('NetworkPolicy')
    expect(np.spec?.podSelector).toEqual({ matchLabels: { app: SERVER_APP_NAME } })
    expect(np.spec?.policyTypes).toEqual(['Ingress'])
    expect(np.spec?.ingress).toEqual([{
      from: [{ ipBlock: { cidr: '0.0.0.0/0', except: ['10.244.0.0/24'] } }],
      ports: [{ protocol: 'TCP', port: SERVER_POD_PORT }],
    }])

    const [svc] = applied('Service')
    expect(svc.spec?.type).toBe('NodePort')
    expect(svc.spec?.ports?.[0]).toMatchObject({
      port: SERVER_POD_PORT,
      nodePort: SERVER_NODE_PORT,
    })
  })

  it('reaches every namespace, because it creates namespaces', async () => {
    await deployServerWorkload({ log: vi.fn() })

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

    await expect(deployServerWorkload({ log: vi.fn() }))
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

    await expect(deployServerWorkload({ log: vi.fn() }))
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

    await expect(deployServerWorkload({ log: vi.fn() })).resolves.toMatch(/^http:/)
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

    await expect(deployServerWorkload({ log: vi.fn() })).resolves.toMatch(/^http:/)
  })
})

describe('waitForPublishedServer', () => {
  it('turns a rolled-out Deployment that never answers into the one fix for it', async () => {
    // A Deployment that is Available while 127.0.0.1 refuses is not a
    // server problem: it is a cluster created before the port mapping
    // existed, and kind writes mappings only at create time — which cannot
    // be converged, only recreated.
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))))
    await expect(waitForPublishedServer(50)).rejects.toThrow(/yaac cluster delete/)
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
    await waitForPublishedServer(10_000)
    expect(calls).toBeGreaterThan(2)
  })
})

describe('serverPublishedOrigin', () => {
  it('is the loopback origin the kind port mapping fronts', () => {
    vi.stubEnv('YAAC_SERVER_PORT', '9123')
    expect(serverPublishedOrigin()).toBe('http://127.0.0.1:9123')
    vi.unstubAllEnvs()
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
  it('scales the Deployment back up rather than spawning anything', async () => {
    await startClusterServer()
    const calls = retried()
    expect(calls.some((c) => c.includes('scale') && c.includes('--replicas=1'))).toBe(true)
    expect(calls.some((c) => c.includes('rollout status'))).toBe(true)
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
    await restartClusterServer()
    const calls = retried()
    expect(calls.some((c) => c.includes('rollout restart'))).toBe(true)
    expect(calls.some((c) => c.includes('rollout status'))).toBe(true)
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalled()
  })
})
