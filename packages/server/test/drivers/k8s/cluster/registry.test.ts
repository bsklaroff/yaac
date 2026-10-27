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
const spawnedArgs: string[][] = []
/** Local port the fake `kubectl port-forward` reports listening on. */
const FORWARD_PORT = 41234
/** Set to fail the port-forward the way a missing Deployment does. */
let forwardFails = false

// `spawn` fakes the kubectl port-forward, so the port-forward module runs
// for real.
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
    spawnedArgs.push(args)
    // A live port-forward announces its listener and then stays up.
    process.nextTick(() => {
      if (forwardFails) child.emit('exit', 1)
      else {
        child.stdout.emit('data', Buffer.from(
          `Forwarding from 127.0.0.1:${FORWARD_PORT} -> 5000\n`,
        ))
      }
    })
    return child
  },
}))

import { fakeCluster } from '@yaac/test-utils/k8s-stub'
import {
  invalidateRegistryEndpoint,
  mirrorMatchesRecord,
  mirrorRef,
  missingPrebuiltImage,
  prebuiltRef,
  recordMirrorDigest,
  registryEndpoint,
  registryHost,
  registryReachable,
  registryRef,
  registryTagState,
} from '#drivers/k8s/cluster'
// State-reset hook, not a unit under test.
import { _resetPortForwardsForTests } from '#drivers/k8s/substrate/port-forward'

const fetchMock = vi.fn<typeof fetch>()

/** The install's registry ref prefix. */
const CLUSTER_HOST = 'yaac-registry.yaac.svc.cluster.local:5000'
/** Where this process reaches it: the fake port-forward's local end. */
const ENDPOINT = `127.0.0.1:${FORWARD_PORT}`

function forwardArgs(): string[][] {
  return spawnedArgs.filter((args) => args[0] === 'port-forward')
}

beforeEach(() => {
  execFileMock.mockReset()
  execFileMock.mockImplementation((file, args) => Promise.reject(new Error(`unexpected ${file} ${args.join(' ')}`)))
  fetchMock.mockReset()
  spawnedArgs.length = 0
  forwardFails = false
  _resetPortForwardsForTests()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  _resetPortForwardsForTests()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function fetchResponse(init: { ok: boolean; status?: number }): Response {
  return { ok: init.ok, status: init.status ?? (init.ok ? 200 : 500) } as Response
}

const DIGEST_A = `sha256:${'a'.repeat(64)}`
const DIGEST_B = `sha256:${'b'.repeat(64)}`

/** A manifest HEAD hit naming `digest`. */
function manifestAt(digest: string): Response {
  return new Response(null, { status: 200, headers: { 'docker-content-digest': digest } })
}

/** The mirror digests install has recorded, by ConfigMap key. */
function mirrorRecord(): Record<string, string> | undefined {
  return fakeCluster.get<{ data?: Record<string, string> }>('ConfigMap', 'yaac-mirror-digests', 'yaac')?.data
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

  it('asks by digest for a `repo@digest` ref', async () => {
    fetchMock.mockResolvedValueOnce(fetchResponse({ ok: true }))
    await expect(registryTagState(`podman-stable@${DIGEST_A}`)).resolves.toBe('present')
    expect(fetchMock.mock.calls[0][0]).toBe(`http://${ENDPOINT}/v2/podman-stable/manifests/${DIGEST_A}`)
  })

  it('reports unknown for a ref without a tag, without asking', async () => {
    await expect(registryTagState('no-tag-here')).resolves.toBe('unknown')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('missingPrebuiltImage', () => {
  it('names the command that produces the image', () => {
    const err = missingPrebuiltImage('netd', 'yaac-netd:abc123')
    expect(err.message).toContain('netd image yaac-netd:abc123 is missing')
    expect(err.message).toContain('yaac cluster install')
  })

  it('points a test run at its own prebuild instead', () => {
    vi.stubEnv('YAAC_REQUIRE_PREBUILT_IMAGES', '1')
    const err = missingPrebuiltImage('netd', 'yaac-test-netd:abc123')
    expect(err.message).toContain('Restart the test run')
    expect(err.message).not.toContain('yaac cluster install')
  })
})

describe('prebuiltRef', () => {
  it('answers the in-cluster ref of a tag the registry holds, and refuses a missing or unknown one', async () => {
    fetchMock.mockResolvedValueOnce(fetchResponse({ ok: true }))
    await expect(prebuiltRef('netd', 'yaac-netd:abc123')).resolves.toBe(registryRef('yaac-netd:abc123'))
    expect(fetchMock).toHaveBeenCalledWith(
      `http://${ENDPOINT}/v2/yaac-netd/manifests/abc123`,
      expect.objectContaining({ method: 'HEAD' }),
    )

    fetchMock.mockResolvedValueOnce(fetchResponse({ ok: false, status: 404 }))
    await expect(prebuiltRef('netd', 'yaac-netd:abc123')).rejects.toThrow(/netd image yaac-netd:abc123 is missing/)
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(prebuiltRef('netd', 'yaac-netd:abc123')).rejects.toThrow(/netd image yaac-netd:abc123 is missing/)
  })
})

describe('recordMirrorDigest', () => {
  const TAG = 'podman-stable:v5.5-25d49cf99084'

  it('records the pushed digest, keeping what other mirrors recorded', async () => {
    fetchMock.mockResolvedValueOnce(manifestAt(DIGEST_A))
    await recordMirrorDigest(TAG, DIGEST_A)
    fetchMock.mockResolvedValueOnce(manifestAt(DIGEST_B))
    await recordMirrorDigest('envoyproxy/envoy:v1.34.0-45d37d848802', DIGEST_B)

    expect(mirrorRecord()).toEqual({
      'podman-stable_v5.5-25d49cf99084': DIGEST_A,
      'envoyproxy_envoy_v1.34.0-45d37d848802': DIGEST_B,
    })
  })

  it('lets two first records race without either failing', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(manifestAt(DIGEST_A)))
    await Promise.all([recordMirrorDigest(TAG, DIGEST_A), recordMirrorDigest(TAG, DIGEST_A)])
    expect(mirrorRecord()).toEqual({ 'podman-stable_v5.5-25d49cf99084': DIGEST_A })
  })

  it('refuses when the tag names other bytes after the push, or the digest is malformed', async () => {
    // Another writer, or the registry, moved the tag: never record that.
    fetchMock.mockResolvedValueOnce(manifestAt(DIGEST_B))
    await expect(recordMirrorDigest(TAG, DIGEST_A)).rejects.toThrow(/another writer/)
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200, headers: { 'docker-content-digest': 'x/../y' } }))
    await expect(recordMirrorDigest(TAG, DIGEST_A)).rejects.toThrow(/names nothing readable/)
    await expect(recordMirrorDigest(TAG, 'v5.5')).rejects.toThrow(/malformed digest/)
    expect(mirrorRecord()).toBeUndefined()
  })
})

describe('mirrorMatchesRecord', () => {
  it('holds only while the tag names the digest install recorded', async () => {
    const tag = 'podman-stable:v5.5-25d49cf99084'
    // Nothing recorded: the tag is not trusted, whatever it names.
    fetchMock.mockResolvedValue(manifestAt(DIGEST_A))
    await expect(mirrorMatchesRecord(tag)).resolves.toBe(false)

    await recordMirrorDigest(tag, DIGEST_A)
    await expect(mirrorMatchesRecord(tag)).resolves.toBe(true)

    // Rewritten, or unreadable.
    fetchMock.mockResolvedValue(manifestAt(DIGEST_B))
    await expect(mirrorMatchesRecord(tag)).resolves.toBe(false)
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(mirrorMatchesRecord(tag)).resolves.toBe(false)
  })
})

describe('mirrorRef', () => {
  it('answers the recorded digest while the registry serves it, else refuses', async () => {
    fetchMock.mockResolvedValue(manifestAt(DIGEST_A))
    await expect(mirrorRef('gVisor installer', 'curlimages/curl:8.18.0-d94d07ba9e7d'))
      .rejects.toThrow(/gVisor installer image curlimages\/curl:8.18.0-d94d07ba9e7d is missing/)

    await recordMirrorDigest('curlimages/curl:8.18.0-d94d07ba9e7d', DIGEST_A)
    await expect(mirrorRef('gVisor installer', 'curlimages/curl:8.18.0-d94d07ba9e7d'))
      .resolves.toBe(registryRef(`curlimages/curl@${DIGEST_A}`))
    expect(fetchMock.mock.calls.at(-1)![0]).toBe(`http://${ENDPOINT}/v2/curlimages/curl/manifests/${DIGEST_A}`)

    fetchMock.mockResolvedValue(fetchResponse({ ok: false, status: 404 }))
    await expect(mirrorRef('gVisor installer', 'curlimages/curl:8.18.0-d94d07ba9e7d')).rejects.toThrow(/is missing/)
  })
})
