import crypto from 'node:crypto'
import fengari from 'fengari'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as childProcess from 'node:child_process'

// The cluster (the fake behind client-node) and the kubectl child process
// (`rollout status`, `exec`) are the boundaries. The cluster folder runs for
// real behind them, including `runPodToCompletion`, which drives the
// hosts.toml writer pods.
const mockKubectl = vi.hoisted(() => vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string }>>())
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof childProcess>(),
  execFile: (_file: string, args: string[], _opts: unknown, cb: (err: unknown, res?: object) => void) => {
    mockKubectl(args).then((res) => { cb(null, res) }, cb)
  },
}))

// The node-CIDR probe behind the ingress policy reads the live cluster.
vi.mock('#drivers/k8s/cluster/cluster-cidrs', () => ({
  nodeIpBlocks: vi.fn().mockResolvedValue(['10.89.0.7/32']),
}))

// The registry client's reachability probe is HTTP over a kubectl
// port-forward, which a unit run does not have.
vi.mock('#drivers/k8s/container/registry', () => ({
  REGISTRY_NAMESPACE: 'yaac',
  REGISTRY_SERVICE_NAME: 'yaac-registry',
  REGISTRY_SERVICE_PORT: 5000,
  registryHost: vi.fn(() => 'yaac-registry.yaac.svc.cluster.local:5000'),
  registryReachable: vi.fn().mockResolvedValue(false),
  invalidateRegistryEndpoint: vi.fn(),
}))

import { ensureMainRegistry, mainRegistryExec } from '#drivers/k8s/cluster'
// Setup values and label keys the assertions speak in, not units under test.
import {
  LABEL_MAIN_REGISTRY_NODE_WRITE,
  MAIN_REGISTRY_APP_LABEL,
  MAIN_REGISTRY_STORAGE_SIZE,
  mainRegistryPvcName,
} from '#drivers/k8s/cluster/main-registry'
import { ROLE_BUILDER } from '#drivers/k8s/substrate/proxy-constants'
import { REGISTRY_UPSTREAM_IMAGE } from '#drivers/k8s/cluster/project-registry'
import { ENVOY_UPSTREAM_IMAGE } from '#drivers/k8s/cluster/netd'
import { registryAuthFile } from '#drivers/k8s/container'
import { _resetRegistryGrantKeyForTests, mintRegistryGrant } from '#drivers/k8s/container/registry-grant'
import { dataDirHash } from '#drivers/k8s/substrate'
import { invalidateRegistryEndpoint, registryReachable } from '#drivers/k8s/container/registry'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'

const mockReachable = vi.mocked(registryReachable)
const mockInvalidate = vi.mocked(invalidateRegistryEndpoint)
const CLUSTER_IP = '10.96.12.34'

/** The cluster's grant key, as its Secret serves it. */
let grantKeyPem = ''
function newGrantKeyPem(): string {
  return crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    .export({ type: 'pkcs8', format: 'pem' }).toString()
}
const FIRST_GRANT_KEY_PEM = newGrantKeyPem()

interface Manifest {
  kind: string
  metadata: { name: string; namespace: string; labels?: Record<string, string> }
  spec: Record<string, unknown>
}

function applied(): Manifest[] {
  return fakeCluster.callsOf('apply').map((c) => c.body as unknown as Manifest)
}

function appliedOfKind(kind: string): Manifest {
  const found = applied().find((m) => m.kind === kind)
  if (!found) throw new Error(`no ${kind} applied (got ${applied().map((m) => m.kind).join(', ')})`)
  return found
}

function kubectlArgs(): string[][] {
  return mockKubectl.mock.calls.map((c) => c[0])
}

/**
 * Stage the cluster an ensure meets: the grant-key Secret and the nodes,
 * plus what the API server fills in on read: the Service's allocated
 * ClusterIP and each writer pod's terminal phase.
 */
function serveCluster(opts: {
  clusterIp?: string | null
  nodes?: string[]
  podPhase?: string
} = {}): void {
  fakeCluster.reset()
  fakeCluster.seed(
    {
      apiVersion: 'v1', kind: 'Secret',
      metadata: { name: 'yaac-registry-grant-key', namespace: 'yaac-registry-keys' },
      data: { 'key.pem': Buffer.from(grantKeyPem).toString('base64') },
    },
    ...(opts.nodes ?? ['yaac-control-plane']).map((name) => ({ apiVersion: 'v1', kind: 'Node', metadata: { name } })),
  )
  const ip = opts.clusterIp === undefined ? CLUSTER_IP : opts.clusterIp
  fakeCluster.intercept((call) => {
    if (call.verb !== 'read' || !call.name) return
    const stored = fakeCluster.get<Record<string, unknown>>(call.kind, call.name, call.namespace)
    if (!stored) return
    if (call.kind === 'Service' && ip) fakeCluster.seed({ ...stored, spec: { ...stored.spec as object, clusterIP: ip } } as never)
    if (call.kind === 'Pod') fakeCluster.seed({ ...stored, status: { phase: opts.podPhase ?? 'Succeeded' } } as never)
  })
}

/**
 * Run the gate's Lua in fengari (a pure-JS Lua VM) against a stub of the
 * Envoy `handle`. `verifySignature` calls `crypto.verify`, so a genuine
 * grant verifies; `raise` makes it throw, as a script bug would. Returns a
 * request runner that answers the gate's status, or `pass`.
 */
function runGate(
  bootstrap: string,
  verify: 'real' | 'raise' = 'real',
): (method: string, path: string, authorization?: string) => string {
  const { lua, lauxlib, lualib, to_luastring } = fengari
  const source = (JSON.parse(bootstrap) as {
    static_resources: { listeners: Array<{ filter_chains: Array<{ filters: Array<{ typed_config: {
      http_filters: Array<{ name: string; typed_config: { default_source_code?: { inline_string: string } } }>
    } }> }> }> }
  }).static_resources.listeners[0].filter_chains[0].filters[0].typed_config.http_filters
    .find((f) => f.name === 'envoy.filters.http.lua')!.typed_config.default_source_code!.inline_string
  const harness = `
function run_request(method, path, authorization)
  local status = nil
  local headers = { [':method'] = method, [':path'] = path, authorization = authorization }
  local handle = {}
  function handle:headers() return { get = function(_, name) return headers[name] end } end
  function handle:respond(h) status = h[':status'] end
  function handle:importPublicKey(der) return { get = function() return der end } end
  function handle:verifySignature(hash, key, sig, siglen, data, datalen)
    return js_verify(hash, key, sig, data)
  end
  function handle:logErr() end
  envoy_on_request(handle)
  return status or 'pass'
end
`
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  lua.lua_pushjsfunction(L, (state) => {
    if (verify === 'raise') return lauxlib.luaL_error(state, to_luastring('verify exploded'))
    const key = crypto.createPublicKey({ key: Buffer.from(lua.lua_tostring(state, 2)), format: 'der', type: 'spki' })
    lua.lua_pushboolean(state, lua.lua_tojsstring(state, 1) === 'sha256' && crypto.verify(
      'sha256', lua.lua_tostring(state, 4), key, lua.lua_tostring(state, 3),
    ))
    return 1
  })
  lua.lua_setglobal(L, to_luastring('js_verify'))
  if (lauxlib.luaL_loadstring(L, to_luastring(source + harness)) !== lua.LUA_OK
    || lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) {
    throw new Error(`gate Lua failed to load: ${lua.lua_tojsstring(L, -1)}`)
  }
  return (method, path, authorization) => {
    lua.lua_getglobal(L, to_luastring('run_request'))
    lua.lua_pushstring(L, to_luastring(method))
    lua.lua_pushstring(L, to_luastring(path))
    if (authorization === undefined) lua.lua_pushnil(L)
    else lua.lua_pushstring(L, to_luastring(authorization))
    if (lua.lua_pcall(L, 3, 1, 0) !== lua.LUA_OK) throw new Error(lua.lua_tojsstring(L, -1))
    const answer = lua.lua_tojsstring(L, -1)
    lua.lua_pop(L, 1)
    return answer
  }
}

/** The Basic header a podman holding this authfile sends. */
function basicOf(authFile: string): string {
  const { auths } = JSON.parse(authFile) as { auths: Record<string, { auth: string }> }
  return `Basic ${Object.values(auths)[0].auth}`
}

beforeEach(() => {
  vi.clearAllMocks()
  grantKeyPem = FIRST_GRANT_KEY_PEM
  _resetRegistryGrantKeyForTests()
  mockKubectl.mockResolvedValue({ stdout: '', stderr: '' })
  mockReachable.mockResolvedValue(false)
  serveCluster()
})

describe('ensureMainRegistry', () => {
  it('is a no-op when the registry already answers', async () => {
    mockReachable.mockResolvedValue(true)
    await ensureMainRegistry()
    // On a healthy install the boot check is one ping.
    expect(fakeCluster.calls).toEqual([])
    expect(mockKubectl).not.toHaveBeenCalled()
  })

  it('applies namespace, PVC, Deployment and Service, then wires every node up', async () => {
    mockReachable.mockResolvedValueOnce(false).mockResolvedValue(true)
    await ensureMainRegistry()

    // The claim is applied before the Deployment that mounts it, so the
    // rollout wait never sees a pod Pending on a missing volume.
    expect(applied().map((m) => m.kind)).toEqual([
      'Namespace', 'PersistentVolumeClaim', 'ConfigMap', 'Deployment', 'Service', 'NetworkPolicy', 'Pod',
    ])

    // Privileged Pod Security: the node-write pods hostPath-mount certs.d,
    // which a baseline/restricted default would reject.
    expect(appliedOfKind('Namespace').metadata.labels)
      .toMatchObject({ 'pod-security.kubernetes.io/enforce': 'privileged' })

    // Everything lands in the fixed `yaac` namespace, not k8sNamespace():
    // per-run e2e namespaces share one image store.
    const deploy = appliedOfKind('Deployment')
    expect(deploy.metadata).toMatchObject({ name: 'yaac-registry', namespace: 'yaac' })
    expect(deploy.metadata.labels?.app).toBe(MAIN_REGISTRY_APP_LABEL)
    const spec = deploy.spec as {
      strategy: { type: string }
      template: {
        spec: {
          runtimeClassName?: string
          priorityClassName: string
          containers: Array<{ image: string; imagePullPolicy: string; readinessProbe: unknown }>
          volumes: Array<{ persistentVolumeClaim?: { claimName: string } }>
          affinity?: unknown
          nodeSelector?: unknown
        }
      }
    }
    // A rolling update would put two pods on one store, and could deadlock
    // on an RWO volume across nodes.
    expect(spec.strategy.type).toBe('Recreate')
    // The registry cannot serve its own pod's images, so both containers
    // use digest-pinned upstream images.
    expect(spec.template.spec.containers.map((c) => c.image))
      .toEqual([REGISTRY_UPSTREAM_IMAGE, ENVOY_UPSTREAM_IMAGE])
    for (const c of spec.template.spec.containers) expect(c.imagePullPolicy).toBe('IfNotPresent')
    // Trusted infra: runc, and higher priority than workspace pods.
    expect(spec.template.spec.runtimeClassName).toBeUndefined()
    expect(spec.template.spec.priorityClassName).toBe('yaac-infra')

    // The store lives on the claim, not a node, so the pod is not pinned:
    // a reschedule takes the volume with it.
    expect(spec.template.spec.volumes[0].persistentVolumeClaim)
      .toEqual({ claimName: mainRegistryPvcName() })
    expect(spec.template.spec.affinity).toBeUndefined()
    expect(spec.template.spec.nodeSelector).toBeUndefined()

    const pvc = appliedOfKind('PersistentVolumeClaim')
    expect(pvc.metadata).toMatchObject({ name: mainRegistryPvcName(), namespace: 'yaac' })
    // Keyed by install, so coexisting installs never share a blob store.
    expect(pvc.metadata.name).toContain(dataDirHash())
    expect(pvc.spec).toEqual({
      // One replica + Recreate means one mounter; RWX needs a file-backed
      // storage class most clusters lack.
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: MAIN_REGISTRY_STORAGE_SIZE } },
    })
    // No storageClassName: bind through the cluster's default class, since
    // naming one would break clusters that lack it.
    expect(pvc.spec).not.toHaveProperty('storageClassName')

    const svc = appliedOfKind('Service')
    expect(svc.metadata).toMatchObject({ name: 'yaac-registry', namespace: 'yaac' })
    expect(svc.spec).toMatchObject({
      type: 'ClusterIP',
      selector: { app: MAIN_REGISTRY_APP_LABEL },
      ports: [{ name: 'registry', port: 5000, targetPort: 5000, protocol: 'TCP' }],
    })

    // Rolled out before the node write, so the writer pod's image is
    // already on the node.
    const rollout = kubectlArgs().find((a) => a[0] === 'rollout')
    expect(rollout).toEqual(expect.arrayContaining([
      'rollout', 'status', 'deployment/yaac-registry', '-n', 'yaac',
    ]))

    // The node is not a cluster-DNS client, so its containerd hosts.toml
    // maps the svc FQDN to the live ClusterIP.
    const writer = appliedOfKind('Pod')
    const podSpec = writer.spec as {
      nodeName: string
      tolerations: Array<{ operator: string }>
      containers: Array<{ image: string; command: string[] }>
      volumes: Array<{ hostPath: { path: string } }>
    }
    expect(writer.metadata.labels?.[LABEL_MAIN_REGISTRY_NODE_WRITE]).toBe('hosts')
    expect(podSpec.nodeName).toBe('yaac-control-plane')
    // nodeName skips the scheduler, but a NoExecute taint still evicts, so
    // without this a tainted node would never learn how to pull.
    expect(podSpec.tolerations).toEqual([{ operator: 'Exists' }])
    expect(podSpec.containers[0].image).toBe(REGISTRY_UPSTREAM_IMAGE)
    expect(podSpec.containers[0].command[2])
      .toContain(`[host."http://${CLUSTER_IP}:5000"]`)
    expect(podSpec.volumes[0].hostPath.path)
      .toBe('/etc/containerd/certs.d/yaac-registry.yaac.svc.cluster.local:5000')

    // This process's port-forward may point at the replaced pod.
    expect(mockInvalidate).toHaveBeenCalled()
  })

  it('puts a write gate holding only the public grant key in front of the registry', async () => {
    mockReachable.mockResolvedValueOnce(false).mockResolvedValue(true)
    await ensureMainRegistry()

    interface Container {
      name: string
      env?: Array<{ name: string; value: string }>
      ports?: Array<{ containerPort: number }>
      readinessProbe?: { httpGet: { path: string; port: number; httpHeaders: unknown[] } }
      volumeMounts: Array<{ name: string; mountPath: string }>
    }
    const template = (appliedOfKind('Deployment').spec as {
      template: {
        metadata: { annotations: Record<string, string> }
        spec: { containers: Container[]; volumes: Array<{ name: string; configMap?: { name: string } }> }
      }
    }).template
    const [registry, gate] = template.spec.containers
    // registry:2 listens only on loopback; the Service port is the gate's.
    // Its blob-descriptor cache is off, so a collected blob is never
    // answered from memory as present.
    expect(registry.env).toEqual([
      { name: 'REGISTRY_HTTP_ADDR', value: '127.0.0.1:5001' },
      { name: 'REGISTRY_STORAGE_CACHE_BLOBDESCRIPTOR', value: '' },
    ])
    expect(registry.ports).toBeUndefined()
    expect(gate.name).toBe('gate')
    expect(gate.ports).toEqual([{ containerPort: 5000 }])
    // Readiness goes through the gate to the registry. The bare `/v2/` is
    // challenged, so the probe presents an empty credential.
    expect(gate.readinessProbe?.httpGet).toMatchObject({ path: '/v2/', port: 5000 })
    expect(gate.readinessProbe?.httpGet.httpHeaders).toEqual([{ name: 'Authorization', value: 'Basic Og==' }])

    // The gate's ConfigMap holds the public key only.
    const cm = appliedOfKind('ConfigMap') as unknown as {
      metadata: { name: string; namespace: string }
      data: Record<string, string>
    }
    expect(cm.metadata).toMatchObject({ name: 'yaac-registry-gate', namespace: 'yaac' })
    expect(template.spec.volumes).toContainEqual({ name: 'gate-config', configMap: { name: 'yaac-registry-gate' } })
    const bootstrap = cm.data['bootstrap.json']
    const publicDer = crypto.createPublicKey(grantKeyPem).export({ type: 'spki', format: 'der' })
    expect(bootstrap).toContain(publicDer.toString('base64'))
    const privateDer = crypto.createPrivateKey(grantKeyPem).export({ type: 'pkcs8', format: 'der' })
    expect(bootstrap).not.toContain(privateDer.toString('base64').slice(0, 64))
    const listener = (JSON.parse(bootstrap) as {
      static_resources: { listeners: Array<{ address: { socket_address: { port_value: number } } }> }
    }).static_resources.listeners[0]
    expect(listener.address.socket_address.port_value).toBe(5000)

    // Envoy reads its bootstrap once, so a changed key must roll the pod.
    const hash = template.metadata.annotations['yaac.registry-gate-config']
    grantKeyPem = newGrantKeyPem()
    _resetRegistryGrantKeyForTests()
    serveCluster()
    mockReachable.mockResolvedValueOnce(false).mockResolvedValue(true)
    await ensureMainRegistry()
    const rolled = (appliedOfKind('Deployment').spec as { template: typeof template })
      .template.metadata.annotations['yaac.registry-gate-config']
    expect(rolled).not.toBe(hash)
  })

  it('gates writes on a genuine, unexpired grant naming the exact repo the registry writes', async () => {
    mockReachable.mockResolvedValueOnce(false).mockResolvedValue(true)
    await ensureMainRegistry()
    const bootstrap = (appliedOfKind('ConfigMap') as unknown as { data: Record<string, string> })
      .data['bootstrap.json']
    const gate = runGate(bootstrap)
    const host = 'yaac-registry.yaac.svc.cluster.local:5000'
    const [a, b] = ['yaac-user-a', 'yaac-user-b']
    const grantA = basicOf(await registryAuthFile(host, [a, 'yaac-buildcache-a'], 600))
    const admin = basicOf(await registryAuthFile(host, '*', 600))
    const expired = basicOf(await registryAuthFile(host, [a], -60))
    const basic = (password: string): string => `Basic ${Buffer.from(`yaac:${password}`).toString('base64')}`
    const foreignKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    const forged = basic(mintRegistryGrant(foreignKey, '*', Math.floor(Date.now() / 1000) + 600))
    const genuine = Buffer.from(grantA.slice('Basic '.length), 'base64').toString()
    const tampered = basic(genuine.slice('yaac:'.length).replace(`|${a},`, '|yaac-base,'))

    const cases: Array<[string, string, string | undefined, string]> = [
      // Reads never need a grant; a bare /v2/ is challenged so podman sends one.
      ['GET', '/v2/_catalog', undefined, 'pass'],
      ['HEAD', `/v2/${b}/manifests/t`, undefined, 'pass'],
      ['GET', '/v2/', undefined, '401'],
      ['GET', '/v2/', 'Basic Og==', 'pass'],
      // The whole push of a granted repo: upload, chunk, commit, mount, tag.
      ['POST', `/v2/${a}/blobs/uploads/`, grantA, 'pass'],
      ['PATCH', `/v2/${a}/blobs/uploads/3f2c9a1e?_state=x`, grantA, 'pass'],
      ['PUT', `/v2/${a}/blobs/uploads/3f2c9a1e?digest=sha256:00`, grantA, 'pass'],
      ['POST', `/v2/${a}/blobs/uploads/?mount=sha256:00&from=yaac-base`, grantA, 'pass'],
      ['PUT', `/v2/${a}/manifests/t`, grantA, 'pass'],
      ['PUT', '/v2/yaac-buildcache-a/manifests/k', grantA, 'pass'],
      // Nothing else: another project, the trusted chain, a mount INTO one.
      ['POST', `/v2/${b}/blobs/uploads/`, grantA, '403'],
      ['PUT', '/v2/yaac-base/manifests/t', grantA, '403'],
      ['POST', `/v2/yaac-base/blobs/uploads/?mount=sha256:00&from=${a}`, grantA, '403'],
      // registry:2 names this repo `<a>/blobs/x`, so the gate must too.
      ['PUT', `/v2/${a}/blobs/x/manifests/t`, grantA, '403'],
      ['POST', `/v2/${a}/blobs/x/blobs/uploads/`, grantA, '403'],
      // A write route of no known shape names no repo.
      ['PUT', `/v2/${a}/blobs/sha256:00`, grantA, '403'],
      // Bad grants.
      ['POST', `/v2/${a}/blobs/uploads/`, undefined, '401'],
      ['POST', `/v2/${a}/blobs/uploads/`, 'Basic Og==', '401'],
      ['POST', `/v2/${a}/blobs/uploads/`, expired, '401'],
      ['POST', `/v2/${a}/blobs/uploads/`, forged, '401'],
      ['POST', '/v2/yaac-base/blobs/uploads/', tampered, '401'],
      ['OPTIONS', `/v2/${a}/manifests/t`, undefined, '401'],
      // The admin grant writes anything but deletes nothing.
      ['PUT', '/v2/yaac-base/manifests/t', admin, 'pass'],
      ['DELETE', `/v2/${a}/manifests/t`, admin, '403'],
    ]
    expect(cases.map(([method, path, auth]) => gate(method, path, auth)))
      .toEqual(cases.map(([, , , want]) => want))

    // A script error refuses the request: Envoy would otherwise pass it.
    expect(runGate(bootstrap, 'raise')('POST', `/v2/${a}/blobs/uploads/`, grantA)).toBe('500')
  })

  it('locks registry ingress to the node and to builder pods in any namespace', async () => {
    mockReachable.mockResolvedValueOnce(false).mockResolvedValue(true)
    await ensureMainRegistry()

    const np = appliedOfKind('NetworkPolicy')
    expect(np.metadata).toMatchObject({ name: 'yaac-registry-ingress', namespace: 'yaac' })
    expect(np.spec).toMatchObject({
      podSelector: { matchLabels: { app: MAIN_REGISTRY_APP_LABEL } },
      policyTypes: ['Ingress'],
    })
    const rules = (np.spec as { ingress: Array<{ from: unknown[]; ports: unknown[] }> }).ingress
    // containerd pulls, the kubelet probe and the server's port-forward
    // come from the node's network namespace, which only an ipBlock names.
    expect(rules[0].from).toEqual([{ ipBlock: { cidr: '10.89.0.7/32' } }])
    // Builder pods live in per-run namespaces during e2e, so a bare
    // podSelector (this namespace only) would lock them out.
    expect(rules[1].from).toEqual([{
      namespaceSelector: {},
      podSelector: { matchLabels: { 'yaac.role': ROLE_BUILDER } },
    }])
    for (const r of rules) expect(r.ports).toEqual([{ protocol: 'TCP', port: 5000 }])
  })

  it('annotates a rollout failure with the command that diagnoses it', async () => {
    mockKubectl.mockImplementation((args: string[]) => (
      args[0] === 'rollout' && args[1] === 'status'
        ? Promise.reject(new Error('timed out waiting for the condition'))
        : Promise.resolve({ stdout: '', stderr: '' })
    ))
    // kubectl's timeout text does not say whether the pod is Pending,
    // ImagePullBackOff or waiting on an unbindable claim (common with no
    // default StorageClass).
    await expect(ensureMainRegistry()).rejects.toThrow(/kubectl -n yaac get pods,pvc/)
    await expect(ensureMainRegistry()).rejects.toThrow(/no default StorageClass/)
  })

  it('refuses a stalled rollout whose pod netns ignores the node\'s ARP', async () => {
    mockKubectl.mockImplementation((args: string[]) => {
      if (args[0] === 'rollout') return Promise.reject(new Error('timed out waiting for the condition'))
      if (args[0] === 'exec') return Promise.resolve({ stdout: '2\n0\n', stderr: '' })
      return Promise.resolve({ stdout: '', stderr: '' })
    })
    // The fix is on the host and needs every pod recreated, so the generic
    // Pending/ImagePullBackOff hint is left out.
    const err = await ensureMainRegistry().then(() => null, (e: unknown) => e as Error)
    expect(err?.message).toMatch(/arp_ignore=2/)
    expect(err?.message).toContain('sudo sysctl -w net.core.devconf_inherit_init_net=3')
    expect(err?.message).toMatch(/yaac cluster delete\n\s+yaac cluster install/)
    expect(err?.message).not.toMatch(/get pods,pvc/)
    // Refused at the stall check, not after sitting out the full timeout.
    expect(kubectlArgs().filter((a) => a[0] === 'rollout')).toHaveLength(1)
    expect(kubectlArgs().find((a) => a[0] === 'exec')).toEqual([
      'exec', '-n', 'yaac', 'deploy/yaac-registry', '-c', 'registry', '--',
      'cat', '/proc/sys/net/ipv4/conf/all/arp_ignore', '/proc/sys/net/ipv4/conf/eth0/arp_ignore',
    ])
  })

  it('keeps waiting out a slow rollout whose pod netns answers ARP', async () => {
    mockReachable.mockResolvedValueOnce(false).mockResolvedValue(true)
    let rollouts = 0
    mockKubectl.mockImplementation((args: string[]) => {
      if (args[0] === 'rollout' && rollouts++ === 0) return Promise.reject(new Error('timed out'))
      if (args[0] === 'exec') return Promise.resolve({ stdout: '0\n0\n', stderr: '' })
      return Promise.resolve({ stdout: '', stderr: '' })
    })
    await ensureMainRegistry()
    // A slow upstream pull is not a stall: the rest of the budget is spent.
    expect(kubectlArgs().filter((a) => a[0] === 'rollout').map((a) => a.at(-1)))
      .toEqual(['--timeout=60s', '--timeout=240s'])
  })

  it('writes one hosts.toml pod per node, reaping strays first', async () => {
    mockReachable.mockResolvedValueOnce(false).mockResolvedValue(true)
    serveCluster({ nodes: ['node-a', 'node-b'] })
    await ensureMainRegistry()

    const writers = applied().filter((m) => m.kind === 'Pod')
    expect(writers.map((p) => (p.spec as { nodeName: string }).nodeName)).toEqual(['node-a', 'node-b'])
    // Writer pod names are unique per run, so leftovers are swept by label.
    // The node-write label keeps the sweep off the registry's own pod.
    const sweep = fakeCluster.callsOf('list', 'Pod')[0]
    expect(sweep.labelSelector).toContain(`${LABEL_MAIN_REGISTRY_NODE_WRITE}=hosts`)
    // Each writer is deleted once it finishes.
    expect(fakeCluster.objects('Pod')).toEqual([])
  })

  it('applies everything again under `force`, even when the registry answers', async () => {
    mockReachable.mockResolvedValue(true)
    await ensureMainRegistry({ force: true })
    // `yaac cluster install` re-writes wiring a node restart may have lost.
    expect(applied().map((m) => m.kind)).toContain('Deployment')
    expect(applied().map((m) => m.kind)).toContain('Pod')
  })

  it('fails when the Service has no ClusterIP to point the node at', async () => {
    serveCluster({ clusterIp: null })
    await expect(ensureMainRegistry()).rejects.toThrow(/no ClusterIP/)
  })

  it('fails when a hosts.toml pod does not complete', async () => {
    serveCluster({ podPhase: 'Failed' })
    await expect(ensureMainRegistry()).rejects.toThrow(/did not complete \(phase Failed\)/)
  })

  it('waits out a restarted node\'s datapath, and fails when the registry never answers', async () => {
    vi.useFakeTimers()
    try {
      // After a node restart the rollout can report done while the pod's
      // network is still coming up, so the dial succeeds only later.
      const answersAt = Date.now() + 45_000
      mockReachable.mockImplementation(() => Promise.resolve(Date.now() >= answersAt))
      const recovered = ensureMainRegistry()
      await vi.advanceTimersByTimeAsync(46_000)
      await expect(recovered).resolves.toBeUndefined()

      mockReachable.mockResolvedValue(false)
      const never = expect(ensureMainRegistry()).rejects.toThrow(/did not become reachable/)
      await vi.advanceTimersByTimeAsync(300_000)
      await never
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('mainRegistryExec', () => {
  it('execs into the registry Deployment and returns stdout', async () => {
    mockKubectl.mockResolvedValue({ stdout: 'BUSY\n', stderr: '' })
    await expect(mainRegistryExec(['sh', '-c', 'find /x'], 5_000)).resolves.toBe('BUSY\n')
    // The container is named because the gate shares the pod. Called once,
    // so a garbage collect never runs twice.
    expect(kubectlArgs()).toEqual([
      ['exec', '-n', 'yaac', 'deploy/yaac-registry', '-c', 'registry', '--', 'sh', '-c', 'find /x'],
    ])
  })
})
