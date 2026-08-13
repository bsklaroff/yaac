import { EventEmitter } from 'node:events'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type ExecResult = { stdout: string; stderr: string }
type ExecCallback = (err: unknown, res?: ExecResult) => void
const execFileMock = vi.fn<(file: string, args: readonly string[]) => Promise<ExecResult>>()

interface FakeChild extends EventEmitter {
  stdout: EventEmitter & { unref?: () => void }
  stderr: EventEmitter & { unref?: () => void }
  unref: () => void
  kill: () => void
}
const spawnedChildren: Array<{ file: string; args: string[]; child: FakeChild }> = []
let spawnCloseCode = 0
/** Local port the fake `kubectl port-forward` reports listening on. */
const FORWARD_PORT = 41234
/** Set to fail the port-forward the way a missing Deployment does. */
let forwardFails = false

// The process boundary in both directions: `spawn` covers the kubectl
// port-forward child AND the tracked podman push, so the port-forward
// module underneath runs for real rather than being stubbed out.
vi.mock('node:child_process', () => ({
  // The barrel pulls in runtime.ts, which reaches kubectl.ts; both promisify
  // a child_process binding at module eval. Only the two below are called.
  exec: vi.fn(),
  execFile: (
    file: string,
    args: readonly string[],
    opts: unknown,
    cb?: ExecCallback,
  ) => {
    const actualCb = (typeof opts === 'function' ? opts : cb) as ExecCallback
    void execFileMock(file, args).then(
      (res) => actualCb(null, res),
      (err: unknown) => actualCb(err),
    )
  },
  spawn: (file: string, args: string[]) => {
    const child = new EventEmitter() as FakeChild
    child.stdout = Object.assign(new EventEmitter(), { unref: vi.fn() })
    child.stderr = Object.assign(new EventEmitter(), { unref: vi.fn() })
    child.unref = vi.fn()
    child.kill = vi.fn()
    spawnedChildren.push({ file, args, child })
    if (args[0] === 'port-forward') {
      // A live port-forward announces its listener and then stays up.
      process.nextTick(() => {
        if (forwardFails) child.emit('exit', 1)
        else {
          child.stdout.emit('data', Buffer.from(
            `Forwarding from 127.0.0.1:${FORWARD_PORT} -> 5000\n`,
          ))
        }
      })
    } else {
      process.nextTick(() => child.emit('close', spawnCloseCode))
    }
    return child
  },
}))

// serverLog/pipeToServerLog write files / wire up stream piping — silence
// them so the spawn fake above can stay minimal.
vi.mock('#log', () => ({
  serverLog: vi.fn(),
  pipeToServerLog: vi.fn(),
}))

import { pipeToServerLog } from '#log'

import {
  invalidateRegistryEndpoint,
  pushImageToRegistry,
  registryEndpoint,
  registryHasTag,
  registryHost,
  registryReachable,
  registryRef,
} from '#drivers/k8s/container'
// State-reset hook for the shared port-forward registry (module state that
// would otherwise leak a live child between cases), not a unit under test.
import { _resetPortForwardsForTests } from '#drivers/k8s/substrate/port-forward'

const fetchMock = vi.fn<typeof fetch>()

/** The install's registry ref prefix with no YAAC_K8S_REGISTRY override. */
const CLUSTER_HOST = 'yaac-registry.yaac.svc.cluster.local:5000'
/** Where this process reaches it: the fake port-forward's local end. */
const ENDPOINT = `127.0.0.1:${FORWARD_PORT}`
/**
 * Where the podman ENGINE reaches it under podman machine — same forwarded
 * port, host swapped for the VM's alias of the host loopback.
 */
const VM_ENDPOINT = `host.containers.internal:${FORWARD_PORT}`

const realPlatform = process.platform

/**
 * Pin the host platform: it is what decides whether podman shares this
 * process's netns (Linux) or runs in a VM (macOS), and therefore which
 * address a push target carries. Pinned in `beforeEach` so the suite asserts
 * one platform's behaviour at a time rather than the developer's.
 */
function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

/** Only the podman children (the port-forward child is not a push). */
function podmanPushes(): Array<{ file: string; args: string[] }> {
  return spawnedChildren.filter((c) => c.file === 'podman')
}

function forwardArgs(): string[][] {
  return spawnedChildren.filter((c) => c.args[0] === 'port-forward').map((c) => c.args)
}

beforeEach(() => {
  execFileMock.mockReset()
  fetchMock.mockReset()
  spawnedChildren.length = 0
  spawnCloseCode = 0
  forwardFails = false
  _resetPortForwardsForTests()
  vi.stubGlobal('fetch', fetchMock)
  stubPlatform('linux')
})

afterEach(() => {
  _resetPortForwardsForTests()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  stubPlatform(realPlatform)
})

function fetchResponse(init: { ok: boolean; status?: number }): Response {
  return { ok: init.ok, status: init.status ?? (init.ok ? 200 : 500) } as Response
}

describe('registryHost', () => {
  it('is the registry Service FQDN in the default namespace', () => {
    // Pinned to the DEFAULT namespace, not k8sNamespace(): per-run e2e
    // namespaces must keep sharing one image store.
    vi.stubEnv('YAAC_K8S_NAMESPACE', 'yaac-test-abc123')
    expect(registryHost()).toBe(CLUSTER_HOST)
  })

  it('honors the YAAC_K8S_REGISTRY override (a nested install)', () => {
    vi.stubEnv('YAAC_K8S_REGISTRY', 'yaac-reg-proj.yaac.svc.cluster.local:5000')
    expect(registryHost()).toBe('yaac-reg-proj.yaac.svc.cluster.local:5000')
  })
})

describe('registryRef', () => {
  it('qualifies a tag with the cluster host, never the local endpoint', () => {
    expect(registryRef('yaac-tools:abc')).toBe(`${CLUSTER_HOST}/yaac-tools:abc`)
  })

  it('follows the YAAC_K8S_REGISTRY override', () => {
    vi.stubEnv('YAAC_K8S_REGISTRY', 'reg.local:5000')
    expect(registryRef('a:b')).toBe('reg.local:5000/a:b')
  })
})

describe('registryEndpoint', () => {
  it('port-forwards into the registry Deployment and reuses one child', async () => {
    await expect(registryEndpoint()).resolves.toBe(ENDPOINT)
    await expect(registryEndpoint()).resolves.toBe(ENDPOINT)

    // One long-lived child per server run, into the Deployment in the
    // registry's own (default) namespace, on an ephemeral local port.
    expect(forwardArgs()).toEqual([[
      'port-forward', '-n', 'yaac', 'deploy/yaac-registry', '0:5000',
    ]])
  })

  it('dials an externally managed registry directly, with no forward at all', async () => {
    // A nested yaac IS a pod: it reaches the outer project registry over
    // cluster DNS, and must never spawn a port-forward for it.
    vi.stubEnv('YAAC_K8S_REGISTRY', 'yaac-reg-proj.yaac.svc.cluster.local:5000')
    await expect(registryEndpoint()).resolves.toBe('yaac-reg-proj.yaac.svc.cluster.local:5000')
    expect(forwardArgs()).toHaveLength(0)
  })

  it('rejects when the forward cannot be established', async () => {
    forwardFails = true
    await expect(registryEndpoint()).rejects.toThrow(/port-forward/)
  })
})

describe('invalidateRegistryEndpoint', () => {
  it('drops the child so the next call re-establishes the forward', async () => {
    await registryEndpoint()
    invalidateRegistryEndpoint()
    await registryEndpoint()
    expect(forwardArgs()).toHaveLength(2)
  })
})

describe('registryReachable', () => {
  it('pings /v2/ through the forwarded endpoint', async () => {
    fetchMock.mockResolvedValue(fetchResponse({ ok: true }))
    await expect(registryReachable()).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      `http://${ENDPOINT}/v2/`,
      expect.objectContaining({ signal: expect.any(AbortSignal) as AbortSignal }),
    )
  })

  it('counts an auth-gated registry (401) as reachable', async () => {
    fetchMock.mockResolvedValue(fetchResponse({ ok: false, status: 401 }))
    await expect(registryReachable()).resolves.toBe(true)
  })

  it('is false — without throwing — when there is no route to the registry', async () => {
    forwardFails = true
    await expect(registryReachable()).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns false on other statuses, and re-forwards after a dead transport', async () => {
    fetchMock.mockResolvedValueOnce(fetchResponse({ ok: false, status: 500 }))
    await expect(registryReachable()).resolves.toBe(false)
    // A 500 is the registry answering, so the forward is fine and kept.
    expect(forwardArgs()).toHaveLength(1)

    // A transport error is not: the cached child is dropped so the next
    // call cannot spend the whole server run talking to a dead forward.
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(registryReachable()).resolves.toBe(false)
    fetchMock.mockResolvedValueOnce(fetchResponse({ ok: true }))
    await expect(registryReachable()).resolves.toBe(true)
    expect(forwardArgs()).toHaveLength(2)
  })
})

describe('registryHasTag', () => {
  it('returns false for a ref without a tag', async () => {
    await expect(registryHasTag('no-tag-here')).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('HEADs the manifest URL and returns true on 200', async () => {
    fetchMock.mockResolvedValue(fetchResponse({ ok: true }))
    await expect(registryHasTag('yaac-tools:abc123')).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      `http://${ENDPOINT}/v2/yaac-tools/manifests/abc123`,
      expect.objectContaining({ method: 'HEAD' }),
    )
  })

  it('returns false when the manifest is absent, the registry is down, or unroutable', async () => {
    fetchMock.mockResolvedValueOnce(fetchResponse({ ok: false, status: 404 }))
    await expect(registryHasTag('yaac-tools:missing')).resolves.toBe(false)
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(registryHasTag('yaac-tools:abc')).resolves.toBe(false)
    // No route at all reads as "absent" too, so the caller pushes and
    // fails loudly there rather than skipping a push that never happened.
    forwardFails = true
    invalidateRegistryEndpoint()
    await expect(registryHasTag('yaac-tools:abc')).resolves.toBe(false)
  })
})

describe('pushImageToRegistry', () => {
  it('skips the push when the immutable tag already exists', async () => {
    fetchMock.mockResolvedValue(fetchResponse({ ok: true })) // manifest HEAD hit
    const ref = await pushImageToRegistry('yaac-tools:abc')
    expect(ref).toBe(`${CLUSTER_HOST}/yaac-tools:abc`)
    expect(podmanPushes()).toHaveLength(0)
  })

  it('pushes to the local endpoint and returns the CLUSTER ref', async () => {
    fetchMock.mockResolvedValue(fetchResponse({ ok: false, status: 404 }))
    const ref = await pushImageToRegistry('yaac-tools:abc')
    // The two addresses of one registry: podman uploads through the
    // forwarded loopback port, while the ref a pod pulls is the svc FQDN.
    // Blob storage is keyed by repository path, so they name the same bytes.
    expect(ref).toBe(`${CLUSTER_HOST}/yaac-tools:abc`)
    expect(podmanPushes()).toHaveLength(1)
    expect(podmanPushes()[0].args).toEqual([
      'push', '--tls-verify=false', 'yaac-tools:abc', `${ENDPOINT}/yaac-tools:abc`,
    ])
  })

  it('targets the VM alias under podman machine, keeping the forwarded port', async () => {
    // Under podman machine the push runs INSIDE the VM, where 127.0.0.1 is
    // the VM's own loopback and the forward's host-side listener is refused.
    // Targeting the loopback there costs three retries per blob, lands
    // nothing, and leaves registryHasTag() unable to skip the next attempt —
    // so the endpoint podman gets must differ from the one the server dials.
    stubPlatform('darwin')
    fetchMock.mockResolvedValue(fetchResponse({ ok: false, status: 404 }))
    const ref = await pushImageToRegistry('yaac-tools:abc')
    expect(ref).toBe(`${CLUSTER_HOST}/yaac-tools:abc`)
    expect(podmanPushes()[0].args).toEqual([
      'push', '--tls-verify=false', 'yaac-tools:abc', `${VM_ENDPOINT}/yaac-tools:abc`,
    ])
    // The host is swapped, the PORT is not: it is a host port either way, and
    // a second forward would hand podman a port nothing is listening on.
    expect(podmanPushes()[0].args.at(-1)).toContain(`:${FORWARD_PORT}/`)
    expect(forwardArgs()).toHaveLength(1)
    // The server's OWN reachability check keeps using the loopback — the two
    // endpoints are resolved separately and must not collapse into one.
    expect(fetchMock.mock.calls[0][0]).toContain(ENDPOINT)
  })

  it('sends an external registry to both halves unchanged, VM or not', async () => {
    // A nested yaac's registry is a cluster address its in-pod podman and the
    // server reach identically, so the VM swap must not touch it.
    stubPlatform('darwin')
    vi.stubEnv('YAAC_K8S_REGISTRY', 'yaac-reg-proj.yaac.svc.cluster.local:5000')
    fetchMock.mockResolvedValue(fetchResponse({ ok: false, status: 404 }))
    await pushImageToRegistry('yaac-tools:abc')
    expect(podmanPushes()[0].args.at(-1)).toBe(
      'yaac-reg-proj.yaac.svc.cluster.local:5000/yaac-tools:abc',
    )
    // No forward at all — there is nothing to port-forward to.
    expect(forwardArgs()).toHaveLength(0)
  })

  it('rejects when podman push exits non-zero', async () => {
    fetchMock.mockResolvedValue(fetchResponse({ ok: false, status: 404 }))
    spawnCloseCode = 125
    await expect(pushImageToRegistry('yaac-tools:abc')).rejects.toThrow(
      'podman push exited with code 125',
    )
  })

  it('passes --compression-format through (trust-split zstd parent pushes)', async () => {
    fetchMock.mockResolvedValue(fetchResponse({ ok: false, status: 404 }))
    await pushImageToRegistry('yaac-tools:abc', { compressionFormat: 'zstd' })
    expect(podmanPushes()[0].args).toEqual([
      'push', '--tls-verify=false', '--compression-format', 'zstd',
      'yaac-tools:abc', `${ENDPOINT}/yaac-tools:abc`,
    ])
  })

  it('threads onLog into the output piping', async () => {
    fetchMock.mockResolvedValue(fetchResponse({ ok: false, status: 404 }))
    const onLog = vi.fn()
    await pushImageToRegistry('yaac-tools:abc', { onLog })
    // The runner wraps `onLog` (it keeps a tail for failure messages), so
    // the thread-through is asserted by driving a line through the wrapper.
    const piped = vi.mocked(pipeToServerLog).mock.calls
      .filter((c) => c[1] === '[push yaac-tools:abc] ').at(-1)
    expect(piped).toBeDefined()
    piped?.[2]?.('Copying blob sha256:deadbeef')
    expect(onLog).toHaveBeenCalledWith('Copying blob sha256:deadbeef')
  })
})
