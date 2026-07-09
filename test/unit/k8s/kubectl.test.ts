import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock node:child_process so the promisified execFile / exec are
// controllable. Must be hoisted before importing the module under test.
type ExecResult = { stdout: string; stderr: string }
type ExecCallback = (err: unknown, res?: ExecResult) => void
const execFileMock = vi.fn<(file: string, args: readonly string[]) => Promise<ExecResult>>()
const execMock = vi.fn<(command: string) => Promise<ExecResult>>()
const stdinEndMock = vi.fn<(input?: string) => void>()
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
    return { stdin: { end: stdinEndMock } }
  },
  exec: (command: string, opts: unknown, cb?: ExecCallback) => {
    const actualCb = (typeof opts === 'function' ? opts : cb) as ExecCallback
    void execMock(command).then(
      (res) => actualCb(null, res),
      (err: unknown) => actualCb(err),
    )
  },
}))

import {
  dataDirHash,
  ensureKubernetes,
  execFileAsync,
  isNotFoundKubectlError,
  isTransientKubectlError,
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
  retryTransient,
  shellKubectlWithRetry,
} from '@/lib/k8s/kubectl'
import { getDataDir, setDataDir } from '@/shared/paths'

function stderrError(stderr: string): Error {
  return Object.assign(new Error('kubectl failed'), { stderr })
}

describe('k8sNamespace', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('defaults to "yaac"', () => {
    expect(k8sNamespace()).toBe('yaac')
  })

  it('honors the YAAC_K8S_NAMESPACE test hook', () => {
    vi.stubEnv('YAAC_K8S_NAMESPACE', 'yaac-test-abc')
    expect(k8sNamespace()).toBe('yaac-test-abc')
  })
})

describe('dataDirHash', () => {
  let originalDataDir: string

  beforeEach(() => {
    originalDataDir = getDataDir()
  })

  afterEach(() => {
    setDataDir(originalDataDir)
  })

  it('is a 16-char hex string with no label-hostile characters', () => {
    expect(dataDirHash()).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is stable for the same data dir and changes when the dir changes', () => {
    setDataDir('/tmp/yaac-hash-a')
    const a1 = dataDirHash()
    const a2 = dataDirHash()
    setDataDir('/tmp/yaac-hash-b')
    const b = dataDirHash()
    expect(a1).toBe(a2)
    expect(b).not.toBe(a1)
  })
})

describe('isTransientKubectlError', () => {
  it.each([
    'connection refused',
    'dial tcp 127.0.0.1:6443: connect: ECONNREFUSED',
    'net/http: TLS handshake timeout',
    'i/o timeout',
    'context deadline exceeded',
    'etcdserver: request timed out',
    'etcdserver: leader changed',
    'the server is currently unable to handle the request',
    'temporarily unavailable',
    'too many requests',
    'error dialing backend',
    'Unable to upgrade connection: pod does not exist',
  ])('matches transient stderr: %s', (stderr) => {
    expect(isTransientKubectlError(stderr)).toBe(true)
  })

  it('matches case-insensitively', () => {
    expect(isTransientKubectlError('CONNECTION REFUSED')).toBe(true)
  })

  it('does not match permanent failures', () => {
    expect(isTransientKubectlError('Error from server (NotFound): jobs.batch "x" not found')).toBe(false)
    expect(isTransientKubectlError('permission denied')).toBe(false)
    expect(isTransientKubectlError('')).toBe(false)
  })
})

describe('isNotFoundKubectlError', () => {
  it('matches the apiserver (NotFound) reason', () => {
    expect(isNotFoundKubectlError('Error from server (NotFound): secrets "x" not found')).toBe(true)
    expect(isNotFoundKubectlError('error: the server doesn\'t have a resource type "Foo" not found')).toBe(true)
  })

  it('does not match other errors', () => {
    expect(isNotFoundKubectlError('connection refused')).toBe(false)
    expect(isNotFoundKubectlError('')).toBe(false)
  })
})

describe('retryTransient', () => {
  const stderrOf = (err: unknown): string => (err as { stderr?: string })?.stderr ?? ''

  it('returns the first successful result without retrying', async () => {
    const run = vi.fn().mockResolvedValue('ok')
    await expect(retryTransient(run, {}, stderrOf)).resolves.toBe('ok')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('retries while stderrOf extracts a transient error, then succeeds', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(stderrError('connection refused'))
      .mockResolvedValue('finally')
    await expect(
      retryTransient(run, { baseDelay: 1, maxAttempts: 3 }, stderrOf),
    ).resolves.toBe('finally')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('rethrows non-transient errors immediately, preserving the original', async () => {
    const run = vi.fn().mockRejectedValue(stderrError('permission denied'))
    await expect(
      retryTransient(run, { baseDelay: 1, maxAttempts: 5 }, stderrOf),
    ).rejects.toThrow('kubectl failed')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('gives up after maxAttempts even when errors stay transient', async () => {
    const run = vi.fn().mockRejectedValue(stderrError('i/o timeout'))
    await expect(
      retryTransient(run, { baseDelay: 1, maxAttempts: 3 }, stderrOf),
    ).rejects.toThrow('kubectl failed')
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('classifies via the injected stderr extraction, not the error itself', async () => {
    // A transient message in the error text is NOT retried when stderrOf
    // does not surface it — the extraction seam is authoritative.
    const run = vi.fn().mockRejectedValue(new Error('connection refused'))
    await expect(
      retryTransient(run, { baseDelay: 1, maxAttempts: 5 }, () => ''),
    ).rejects.toThrow('connection refused')
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('kubectlWithRetry', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    stdinEndMock.mockReset()
  })

  it('returns stdout/stderr on first successful call', async () => {
    execFileMock.mockResolvedValue({ stdout: 'ok', stderr: '' })
    const result = await kubectlWithRetry(['get', 'pods'])
    expect(result.stdout).toBe('ok')
    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(execFileMock).toHaveBeenCalledWith('kubectl', ['get', 'pods'])
  })

  it('retries on transient errors and eventually succeeds', async () => {
    const transient = stderrError('connection refused')
    execFileMock
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockResolvedValue({ stdout: 'finally', stderr: '' })
    const result = await kubectlWithRetry(['get', 'pods'], { baseDelay: 1, maxAttempts: 5 })
    expect(result.stdout).toBe('finally')
    expect(execFileMock).toHaveBeenCalledTimes(3)
  })

  it('does not retry on non-transient errors', async () => {
    execFileMock.mockRejectedValue(stderrError('permission denied'))
    await expect(
      kubectlWithRetry(['get', 'pods'], { baseDelay: 1, maxAttempts: 5 }),
    ).rejects.toThrow('kubectl failed')
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('throws after maxAttempts even if errors remain transient', async () => {
    execFileMock.mockRejectedValue(stderrError('i/o timeout'))
    await expect(
      kubectlWithRetry(['get', 'pods'], { baseDelay: 1, maxAttempts: 3 }),
    ).rejects.toThrow('kubectl failed')
    expect(execFileMock).toHaveBeenCalledTimes(3)
  })

  it('pipes opts.input to kubectl stdin', async () => {
    execFileMock.mockResolvedValue({ stdout: '', stderr: '' })
    await kubectlWithRetry(['apply', '-f', '-'], { input: '{"kind":"Job"}' })
    expect(execFileMock).toHaveBeenCalledWith('kubectl', ['apply', '-f', '-'])
    expect(stdinEndMock).toHaveBeenCalledWith('{"kind":"Job"}')
  })
})

describe('shellKubectlWithRetry', () => {
  beforeEach(() => {
    execMock.mockReset()
  })

  it('returns stdout/stderr on first successful call', async () => {
    execMock.mockResolvedValue({ stdout: 'ok', stderr: '' })
    const result = await shellKubectlWithRetry('kubectl exec -n yaac job/x -- true')
    expect(result.stdout).toBe('ok')
    expect(execMock).toHaveBeenCalledTimes(1)
    expect(execMock).toHaveBeenCalledWith('kubectl exec -n yaac job/x -- true')
  })

  it('retries on transient stderr and eventually succeeds', async () => {
    execMock
      .mockRejectedValueOnce(stderrError('error dialing backend'))
      .mockResolvedValue({ stdout: 'finally', stderr: '' })
    const result = await shellKubectlWithRetry('kubectl exec job/x -- true', {
      baseDelay: 1,
      maxAttempts: 5,
    })
    expect(result.stdout).toBe('finally')
    expect(execMock).toHaveBeenCalledTimes(2)
  })

  it('also classifies via the error message when stderr is empty', async () => {
    execMock
      .mockRejectedValueOnce(new Error('net dial: i/o timeout'))
      .mockResolvedValue({ stdout: 'back', stderr: '' })
    const result = await shellKubectlWithRetry('kubectl get pods', {
      baseDelay: 1,
      maxAttempts: 3,
    })
    expect(result.stdout).toBe('back')
    expect(execMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry on non-transient errors', async () => {
    execMock.mockRejectedValue(stderrError('permission denied'))
    await expect(
      shellKubectlWithRetry('kubectl get pods', { baseDelay: 1, maxAttempts: 5 }),
    ).rejects.toThrow('kubectl failed')
    expect(execMock).toHaveBeenCalledTimes(1)
  })
})

describe('kubectlGetJson', () => {
  beforeEach(() => {
    execFileMock.mockReset()
  })

  it('appends -o json and parses the result', async () => {
    execFileMock.mockResolvedValue({ stdout: '{"items":[1,2]}', stderr: '' })
    const result = await kubectlGetJson<{ items: number[] }>(['get', 'pods', '-n', 'yaac'])
    expect(result).toEqual({ items: [1, 2] })
    expect(execFileMock).toHaveBeenCalledWith('kubectl', ['get', 'pods', '-n', 'yaac', '-o', 'json'])
  })

  it('returns null when the object does not exist', async () => {
    execFileMock.mockRejectedValue(
      stderrError('Error from server (NotFound): secrets "yaac-proxy-auth" not found'),
    )
    await expect(kubectlGetJson(['get', 'secret', 'yaac-proxy-auth'])).resolves.toBeNull()
  })

  it('rethrows other errors', async () => {
    execFileMock.mockRejectedValue(stderrError('forbidden'))
    await expect(kubectlGetJson(['get', 'secret', 'x'])).rejects.toThrow('kubectl failed')
  })
})

describe('kubectlApply', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    stdinEndMock.mockReset()
  })

  it('pipes the JSON-serialized manifest into kubectl apply -f -', async () => {
    execFileMock.mockResolvedValue({ stdout: 'job created', stderr: '' })
    const manifest = { apiVersion: 'batch/v1', kind: 'Job' }
    await kubectlApply(manifest)
    expect(execFileMock).toHaveBeenCalledWith('kubectl', ['apply', '-f', '-'])
    expect(stdinEndMock).toHaveBeenCalledWith(JSON.stringify(manifest))
  })
})

describe('ensureKubernetes', () => {
  beforeEach(() => {
    execFileMock.mockReset()
  })

  it('resolves when the API server answers kubectl version', async () => {
    execFileMock.mockResolvedValue({ stdout: '{}', stderr: '' })
    await expect(ensureKubernetes()).resolves.toBeUndefined()
    expect(execFileMock).toHaveBeenCalledWith('kubectl', ['version', '--output', 'json'])
  })

  it('throws a pointed setup error when the cluster is unreachable', async () => {
    execFileMock.mockRejectedValue(stderrError('was refused - did you specify the right host?'))
    await expect(ensureKubernetes()).rejects.toThrow(/yaac cluster check/)
  })
})

describe('execFileAsync', () => {
  it('is exported as a function', () => {
    expect(typeof execFileAsync).toBe('function')
  })
})
