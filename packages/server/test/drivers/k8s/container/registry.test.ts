import crypto from 'node:crypto'
import fs from 'node:fs'
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
interface SpawnedChild {
  file: string
  args: string[]
  child: FakeChild
  /** The `--authfile` as the child saw it: content and mode, read at spawn. */
  authFile?: { path: string; content: string; mode: number }
}
const spawnedChildren: SpawnedChild[] = []
let spawnCloseCode = 0
/** Local port the fake `kubectl port-forward` reports listening on. */
const FORWARD_PORT = 41234
/** Set to fail the port-forward the way a missing Deployment does. */
let forwardFails = false

// `spawn` fakes both the kubectl port-forward and the podman push, so the
// port-forward module runs for real.
vi.mock('node:child_process', () => ({
  // Other barrel modules promisify `exec` at load time; it is never called.
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
    const authPath = args.includes('--authfile') ? args[args.indexOf('--authfile') + 1] : null
    spawnedChildren.push({
      file,
      args,
      child,
      authFile: authPath
        ? { path: authPath, content: fs.readFileSync(authPath, 'utf8'), mode: fs.statSync(authPath).mode & 0o777 }
        : undefined,
    })
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

// Silenced so the spawn fake above can stay minimal.
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
  registryTagState,
} from '#drivers/k8s/container'
// State-reset hooks, not units under test.
import { _resetPortForwardsForTests } from '#drivers/k8s/substrate/port-forward'
import { _resetRegistryGrantKeyForTests } from '#drivers/k8s/container/registry-grant'

/** The cluster's grant key, as the `kubectl get secret` below serves it. */
const GRANT_KEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
const GRANT_SECRET = JSON.stringify({
  data: { 'key.pem': Buffer.from(GRANT_KEY.export({ type: 'pkcs8', format: 'pem' })).toString('base64') },
})

/**
 * Check a push's `--authfile` the way the registry's write gate checks a
 * grant: for the engine's endpoint, signed by the cluster key, unexpired,
 * and for every repo (`*`). The file is mode 0600 and deleted after the push.
 */
function expectAdminAuthFile(push: SpawnedChild, endpoint: string): void {
  const authFile = push.authFile!
  expect(authFile.mode).toBe(0o600)
  expect(fs.existsSync(authFile.path)).toBe(false)
  const { auths } = JSON.parse(authFile.content) as { auths: Record<string, { auth: string }> }
  expect(Object.keys(auths)).toEqual([endpoint])
  const basic = Buffer.from(auths[endpoint].auth, 'base64').toString()
  expect(basic.slice(0, basic.indexOf(':'))).toBe('yaac')
  const password = basic.slice(basic.indexOf(':') + 1)
  const dot = password.lastIndexOf('.')
  const payload = password.slice(0, dot)
  expect(crypto.verify('sha256', Buffer.from(payload), GRANT_KEY, Buffer.from(password.slice(dot + 1), 'base64url')))
    .toBe(true)
  const [, expiry, scope] = payload.split('|')
  expect(scope).toBe('*')
  expect(Number(expiry)).toBeGreaterThan(Date.now() / 1000)
}

/** A push's argv with the (verified) authfile pair removed. */
function withoutAuthFile(push: SpawnedChild, endpoint = ENDPOINT): string[] {
  expectAdminAuthFile(push, endpoint)
  const i = push.args.indexOf('--authfile')
  return [...push.args.slice(0, i), ...push.args.slice(i + 2)]
}

const fetchMock = vi.fn<typeof fetch>()

/** The install's registry ref prefix. */
const CLUSTER_HOST = 'yaac-registry.yaac.svc.cluster.local:5000'
/** Where this process reaches it: the fake port-forward's local end. */
const ENDPOINT = `127.0.0.1:${FORWARD_PORT}`
/** Where podman reaches it under podman machine: the VM's alias for the host. */
const VM_ENDPOINT = `host.containers.internal:${FORWARD_PORT}`

const realPlatform = process.platform

/**
 * Pin the host platform, which decides whether podman shares this process's
 * network (Linux) or runs in a VM (macOS), and so which push address it gets.
 */
function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

/** The podman children, excluding the port-forward. */
function podmanPushes(): SpawnedChild[] {
  return spawnedChildren.filter((c) => c.file === 'podman')
}

function forwardArgs(): string[][] {
  return spawnedChildren.filter((c) => c.args[0] === 'port-forward').map((c) => c.args)
}

beforeEach(() => {
  execFileMock.mockReset()
  execFileMock.mockImplementation((file, args) => (args[0] === 'get' && args[1] === 'secret'
    ? Promise.resolve({ stdout: GRANT_SECRET, stderr: '' })
    : Promise.reject(new Error(`unexpected ${file} ${args.join(' ')}`))))
  _resetRegistryGrantKeyForTests()
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
    // Always the `yaac` namespace, not k8sNamespace(): per-run e2e
    // namespaces share one image store.
    vi.stubEnv('YAAC_K8S_NAMESPACE', 'yaac-test-abc123')
    expect(registryHost()).toBe(CLUSTER_HOST)
  })
})

describe('registryRef', () => {
  it('qualifies a tag with the cluster host, never the local endpoint', () => {
    expect(registryRef('yaac-tools:abc')).toBe(`${CLUSTER_HOST}/yaac-tools:abc`)
  })
})

describe('registryEndpoint', () => {
  it('port-forwards into the registry Deployment and reuses one child', async () => {
    await expect(registryEndpoint()).resolves.toBe(ENDPOINT)
    await expect(registryEndpoint()).resolves.toBe(ENDPOINT)

    // One long-lived child per server run, on an ephemeral local port.
    expect(forwardArgs()).toEqual([[
      'port-forward', '-n', 'yaac', 'deploy/yaac-registry', '0:5000',
    ]])
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
    // A 500 means the registry answered, so the forward is kept.
    expect(forwardArgs()).toHaveLength(1)

    // A transport error drops the forward so the next call makes a new one.
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
    // No route also reads as absent, so the caller pushes and fails loudly
    // there instead of skipping the push.
    forwardFails = true
    invalidateRegistryEndpoint()
    await expect(registryHasTag('yaac-tools:abc')).resolves.toBe(false)
  })
})

describe('registryTagState', () => {
  it('reports absent only when the registry answers 404', async () => {
    fetchMock.mockResolvedValueOnce(fetchResponse({ ok: true }))
    await expect(registryTagState('yaac-tools:abc')).resolves.toBe('present')
    fetchMock.mockResolvedValueOnce(fetchResponse({ ok: false, status: 404 }))
    await expect(registryTagState('yaac-tools:abc')).resolves.toBe('absent')
    // Only a 404 means absent, so a caller that deletes on absence never
    // mistakes a slow or restarting registry for an empty one.
    fetchMock.mockResolvedValueOnce(fetchResponse({ ok: false, status: 503 }))
    await expect(registryTagState('yaac-tools:abc')).resolves.toBe('unknown')
    fetchMock.mockRejectedValueOnce(new Error('timeout'))
    await expect(registryTagState('yaac-tools:abc')).resolves.toBe('unknown')
    forwardFails = true
    invalidateRegistryEndpoint()
    await expect(registryTagState('yaac-tools:abc')).resolves.toBe('unknown')
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
    // podman uploads through the forwarded loopback port; pods pull by the
    // Service FQDN. Both name the same repository path.
    expect(ref).toBe(`${CLUSTER_HOST}/yaac-tools:abc`)
    expect(podmanPushes()).toHaveLength(1)
    // The write gate needs an admin grant. It goes in a file, not argv,
    // where `ps` would show it.
    expect(podmanPushes()[0].args.join(' ')).not.toContain('--creds')
    expect(withoutAuthFile(podmanPushes()[0])).toEqual([
      'push', '--tls-verify=false', 'yaac-tools:abc', `${ENDPOINT}/yaac-tools:abc`,
    ])
  })

  it('targets the VM alias under podman machine, keeping the forwarded port', async () => {
    // Under podman machine the push runs inside the VM, where 127.0.0.1 is
    // the VM's own loopback, so podman needs a different address than the
    // server dials.
    stubPlatform('darwin')
    fetchMock.mockResolvedValue(fetchResponse({ ok: false, status: 404 }))
    const ref = await pushImageToRegistry('yaac-tools:abc')
    expect(ref).toBe(`${CLUSTER_HOST}/yaac-tools:abc`)
    expect(withoutAuthFile(podmanPushes()[0], VM_ENDPOINT)).toEqual([
      'push', '--tls-verify=false', 'yaac-tools:abc', `${VM_ENDPOINT}/yaac-tools:abc`,
    ])
    // Same port, and no second forward.
    expect(podmanPushes()[0].args.at(-1)).toContain(`:${FORWARD_PORT}/`)
    expect(forwardArgs()).toHaveLength(1)
    // The server's own check still uses the loopback.
    expect(fetchMock.mock.calls[0][0]).toContain(ENDPOINT)
  })

  it('rejects when podman push exits non-zero', async () => {
    fetchMock.mockResolvedValue(fetchResponse({ ok: false, status: 404 }))
    spawnCloseCode = 125
    await expect(pushImageToRegistry('yaac-tools:abc')).rejects.toThrow(
      'podman push exited with code 125',
    )
    // The grant file is removed after a failed push too.
    expect(fs.existsSync(podmanPushes()[0].authFile!.path)).toBe(false)
  })

  it('passes --compression-format through (trust-split zstd parent pushes)', async () => {
    fetchMock.mockResolvedValue(fetchResponse({ ok: false, status: 404 }))
    await pushImageToRegistry('yaac-tools:abc', { compressionFormat: 'zstd' })
    expect(withoutAuthFile(podmanPushes()[0])).toEqual([
      'push', '--tls-verify=false', '--compression-format', 'zstd',
      'yaac-tools:abc', `${ENDPOINT}/yaac-tools:abc`,
    ])
  })

  it('threads onLog into the output piping', async () => {
    fetchMock.mockResolvedValue(fetchResponse({ ok: false, status: 404 }))
    const onLog = vi.fn()
    await pushImageToRegistry('yaac-tools:abc', { onLog })
    // The runner wraps `onLog` to keep a tail for error messages, so drive
    // a line through the wrapper.
    const piped = vi.mocked(pipeToServerLog).mock.calls
      .filter((c) => c[1] === '[push yaac-tools:abc] ').at(-1)
    expect(piped).toBeDefined()
    piped?.[2]?.('Copying blob sha256:deadbeef')
    expect(onLog).toHaveBeenCalledWith('Copying blob sha256:deadbeef')
  })
})
