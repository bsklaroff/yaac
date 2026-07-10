import { EventEmitter } from 'node:events'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type ExecResult = { stdout: string; stderr: string }
type ExecCallback = (err: unknown, res?: ExecResult) => void
const execFileMock = vi.fn<(file: string, args: readonly string[]) => Promise<ExecResult>>()

interface FakeChild extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
}
const spawnedChildren: Array<{ file: string; args: string[]; child: FakeChild }> = []
let spawnCloseCode = 0

vi.mock('node:child_process', () => ({
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
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    spawnedChildren.push({ file, args, child })
    process.nextTick(() => child.emit('close', spawnCloseCode))
    return child
  },
}))

// serverLog/pipeToServerLog write files / wire up stream piping — silence
// them so the spawn fake above can stay minimal.
vi.mock('@/server/log', () => ({
  serverLog: vi.fn(),
  pipeToServerLog: vi.fn(),
}))

import { pipeToServerLog } from '@/server/log'

import {
  REGISTRY_CONTAINER_NAME,
  ensureLocalRegistry,
  pushImageToRegistry,
  registryHasTag,
  registryHost,
  registryReachable,
  registryRef,
  removeLocalRegistry,
} from '@/lib/k8s/registry'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  execFileMock.mockReset()
  fetchMock.mockReset()
  spawnedChildren.length = 0
  spawnCloseCode = 0
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function fetchResponse(init: { ok: boolean; status?: number }): Response {
  return { ok: init.ok, status: init.status ?? (init.ok ? 200 : 500) } as Response
}

describe('registryHost / registryRef', () => {
  it('defaults to localhost:5001', () => {
    expect(registryHost()).toBe('localhost:5001')
    expect(registryRef('yaac-tools:abc')).toBe('localhost:5001/yaac-tools:abc')
  })

  it('honors the YAAC_K8S_REGISTRY override', () => {
    vi.stubEnv('YAAC_K8S_REGISTRY', 'localhost:5999')
    expect(registryHost()).toBe('localhost:5999')
    expect(registryRef('a:b')).toBe('localhost:5999/a:b')
  })

  it('exports the managed registry container name', () => {
    expect(REGISTRY_CONTAINER_NAME).toBe('yaac-registry')
  })
})

describe('registryReachable', () => {
  it('returns true when the OCI ping answers 200', async () => {
    fetchMock.mockResolvedValue(fetchResponse({ ok: true }))
    await expect(registryReachable()).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:5001/v2/',
      expect.objectContaining({ signal: expect.any(AbortSignal) as AbortSignal }),
    )
  })

  it('counts an auth-gated registry (401) as reachable', async () => {
    fetchMock.mockResolvedValue(fetchResponse({ ok: false, status: 401 }))
    await expect(registryReachable()).resolves.toBe(true)
  })

  it('returns false on other statuses and network errors', async () => {
    fetchMock.mockResolvedValueOnce(fetchResponse({ ok: false, status: 500 }))
    await expect(registryReachable()).resolves.toBe(false)
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(registryReachable()).resolves.toBe(false)
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
      'http://localhost:5001/v2/yaac-tools/manifests/abc123',
      expect.objectContaining({ method: 'HEAD' }),
    )
  })

  it('returns false when the manifest is absent or the registry is down', async () => {
    fetchMock.mockResolvedValueOnce(fetchResponse({ ok: false, status: 404 }))
    await expect(registryHasTag('yaac-tools:missing')).resolves.toBe(false)
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(registryHasTag('yaac-tools:abc')).resolves.toBe(false)
  })
})

describe('ensureLocalRegistry', () => {
  it('reuses any registry already answering on the address', async () => {
    fetchMock.mockResolvedValue(fetchResponse({ ok: true }))
    await ensureLocalRegistry()
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('starts registry:2 under podman and waits for it to answer', async () => {
    // First ping fails (nothing listening), every later ping succeeds.
    fetchMock
      .mockResolvedValueOnce(fetchResponse({ ok: false, status: 500 }))
      .mockResolvedValue(fetchResponse({ ok: true }))
    execFileMock.mockResolvedValue({ stdout: '', stderr: '' })

    await ensureLocalRegistry()

    expect(execFileMock).toHaveBeenCalledWith(
      'podman', ['rm', '-f', '--ignore', REGISTRY_CONTAINER_NAME],
    )
    expect(execFileMock).toHaveBeenCalledWith('podman', [
      'run', '-d', '--name', REGISTRY_CONTAINER_NAME,
      '-p', '127.0.0.1:5001:5000',
      'docker.io/library/registry:2',
    ])
  })

  it('throws a pointed error when the registry container fails to start', async () => {
    fetchMock.mockResolvedValue(fetchResponse({ ok: false, status: 500 }))
    execFileMock.mockRejectedValue(new Error('podman missing'))
    await expect(ensureLocalRegistry()).rejects.toThrow('Failed to start local registry container')
  })
})

describe('removeLocalRegistry', () => {
  it('force-removes the managed registry container, ignoring a missing one', async () => {
    execFileMock.mockResolvedValue({ stdout: '', stderr: '' })
    await removeLocalRegistry()
    expect(execFileMock).toHaveBeenCalledWith(
      'podman', ['rm', '-f', '--ignore', REGISTRY_CONTAINER_NAME],
    )
  })
})

describe('pushImageToRegistry', () => {
  it('skips the push when the immutable tag already exists', async () => {
    fetchMock.mockResolvedValue(fetchResponse({ ok: true })) // manifest HEAD hit
    const ref = await pushImageToRegistry('yaac-tools:abc')
    expect(ref).toBe('localhost:5001/yaac-tools:abc')
    expect(spawnedChildren).toHaveLength(0)
  })

  it('pushes via podman with --tls-verify=false and returns the in-cluster ref', async () => {
    fetchMock.mockResolvedValue(fetchResponse({ ok: false, status: 404 }))
    const ref = await pushImageToRegistry('yaac-tools:abc')
    expect(ref).toBe('localhost:5001/yaac-tools:abc')
    expect(spawnedChildren).toHaveLength(1)
    expect(spawnedChildren[0].file).toBe('podman')
    expect(spawnedChildren[0].args).toEqual([
      'push', '--tls-verify=false', 'yaac-tools:abc', 'localhost:5001/yaac-tools:abc',
    ])
  })

  it('rejects when podman push exits non-zero', async () => {
    fetchMock.mockResolvedValue(fetchResponse({ ok: false, status: 404 }))
    spawnCloseCode = 125
    await expect(pushImageToRegistry('yaac-tools:abc')).rejects.toThrow(
      'podman push exited with code 125',
    )
  })

  it('force-pushes even when the tag is already present (rebuild path)', async () => {
    fetchMock.mockResolvedValue(fetchResponse({ ok: true })) // manifest HEAD hit
    const ref = await pushImageToRegistry('yaac-tools:abc', { force: true })
    expect(ref).toBe('localhost:5001/yaac-tools:abc')
    expect(spawnedChildren).toHaveLength(1)
    // The has-tag check is skipped entirely, not just overridden.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('threads onLog into the output piping', async () => {
    fetchMock.mockResolvedValue(fetchResponse({ ok: false, status: 404 }))
    const onLog = vi.fn()
    await pushImageToRegistry('yaac-tools:abc', { onLog })
    expect(vi.mocked(pipeToServerLog)).toHaveBeenCalledWith(
      expect.anything(), '[push yaac-tools:abc] ', onLog,
    )
  })
})
