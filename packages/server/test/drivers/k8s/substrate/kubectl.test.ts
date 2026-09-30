import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// node:child_process is mocked so the promisified execFile/exec are
// controllable.
type ExecResult = { stdout: string; stderr: string }
type ExecCallback = (err: unknown, res?: ExecResult) => void
const execFileMock = vi.fn<(file: string, args: readonly string[], opts: unknown) => Promise<ExecResult>>()
const execMock = vi.fn<(command: string) => Promise<ExecResult>>()
const stdinEndMock = vi.fn<(input?: string) => void>()
const stdinOnMock = vi.fn<(event: string, listener: () => void) => void>()
vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: readonly string[],
    opts: unknown,
    cb?: ExecCallback,
  ) => {
    const actualCb = (typeof opts === 'function' ? opts : cb) as ExecCallback
    void execFileMock(file, args, typeof opts === 'function' ? undefined : opts).then(
      (res) => actualCb(null, res),
      (err: unknown) => actualCb(err),
    )
    // The caller subscribes to stdin 'error', so the fake needs `on` too.
    return { stdin: { end: stdinEndMock, on: stdinOnMock } }
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
  isKubectlAbsentError,
  k8sNamespace,
  kubectlApply,
  kubectlErrorSummary,
  kubectlGetJson,
  kubectlWithRetry,
} from '#drivers/k8s/substrate'
import { getDataDir, setDataDir } from '@yaac/shared/paths'

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

describe('kubectlWithRetry', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    stdinEndMock.mockReset()
    stdinOnMock.mockReset()
  })

  it('returns stdout/stderr on first successful call', async () => {
    execFileMock.mockResolvedValue({ stdout: 'ok', stderr: '' })
    const result = await kubectlWithRetry(['get', 'pods'])
    expect(result.stdout).toBe('ok')
    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(execFileMock).toHaveBeenCalledWith('kubectl', ['get', 'pods'], expect.objectContaining({ maxBuffer: 64 << 20 }))
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
    expect(execFileMock).toHaveBeenCalledWith('kubectl', ['apply', '-f', '-'], expect.objectContaining({ maxBuffer: 64 << 20 }))
    expect(stdinEndMock).toHaveBeenCalledWith('{"kind":"Job"}')
    // Subscribed before the write: on shutdown the child may die before
    // reading, and the resulting EPIPE would otherwise be an uncaught error
    // that skips the shutdown handler.
    expect(stdinOnMock).toHaveBeenCalledWith('error', expect.any(Function))
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
    expect(execFileMock).toHaveBeenCalledWith('kubectl', ['get', 'pods', '-n', 'yaac', '-o', 'json'], expect.anything())
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

describe('isKubectlAbsentError', () => {
  // `--byo` treats "no FelixConfiguration" as meaning Felix's iptables
  // defaults, so a failure misread as absence would let an eBPF cluster
  // through and silently break egress.
  it('accepts kubectl\'s own absence shapes, for an object or a whole resource type', () => {
    for (const stderr of [
      'Error from server (NotFound): daemonsets.apps "calico-node" not found',
      'error: the server doesn\'t have a resource type "felixconfigurations"',
      'error: no matches for kind "FelixConfiguration" in version "crd.projectcalico.org/v1"',
      'Error from server (NotFound): the server could not find the requested resource',
    ]) {
      expect(isKubectlAbsentError(stderrError(stderr))).toBe(true)
    }
  })

  it('rejects a failure of the machinery in FRONT of the object', () => {
    // A broken webhook's error says "not found" about its own Service; a
    // substring match would misread that as the object being absent.
    expect(isKubectlAbsentError(stderrError(
      'Error from server (InternalError): Internal error occurred: failed calling webhook '
      + '"conversion.projectcalico.org": service "calico-apiserver" not found',
    ))).toBe(false)

    // Ordinary errors are not absence either.
    for (const stderr of [
      'Error from server (Forbidden): felixconfigurations.crd.projectcalico.org is forbidden',
      'The connection to the server localhost:8080 was refused',
      'error: context deadline exceeded',
    ]) {
      expect(isKubectlAbsentError(stderrError(stderr))).toBe(false)
    }
  })
})

describe('kubectlErrorSummary', () => {
  it('skips klog retry narration for kubectl\'s own diagnosis', () => {
    // kubectl prints client-go retry noise first and the useful sentence
    // last, so the summary takes the last line.
    const summary = kubectlErrorSummary(stderrError(
      'E0806 15:53:50.959713 19874 memcache.go:265] "Unhandled Error" err="couldn\'t get '
      + 'current server API group list: Get \\"http://localhost:8080/api\\": dial tcp"\n'
      + 'The connection to the server localhost:8080 was refused - did you specify the '
      + 'right host or port?',
    ))
    expect(summary).toBe(
      'The connection to the server localhost:8080 was refused - did you specify the '
      + 'right host or port?',
    )
  })

  it('falls back rather than returning nothing, and caps the length', () => {
    // Only klog lines: show them rather than an empty string.
    const klogOnly = Object.assign(new Error(''), {
      stderr: 'E0806 12:00:00.0 1 x.go:1] only klog here',
    })
    expect(kubectlErrorSummary(klogOnly)).toContain('only klog here')
    expect(kubectlErrorSummary(new Error('plain failure'))).toBe('plain failure')
    // Capped, with an ellipsis.
    expect(kubectlErrorSummary(stderrError('x'.repeat(400)))).toHaveLength(141)
  })
})

describe('kubectlApply', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    stdinEndMock.mockReset()
    stdinOnMock.mockReset()
  })

  it('pipes the JSON-serialized manifest into kubectl apply -f -', async () => {
    execFileMock.mockResolvedValue({ stdout: 'job created', stderr: '' })
    const manifest = { apiVersion: 'batch/v1', kind: 'Job' }
    await kubectlApply(manifest)
    expect(execFileMock).toHaveBeenCalledWith('kubectl', ['apply', '-f', '-'], expect.anything())
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
    expect(execFileMock).toHaveBeenCalledWith('kubectl', ['version', '--output', 'json'], expect.anything())
  })

  it('throws a pointed setup error when the cluster is unreachable', async () => {
    execFileMock.mockRejectedValue(stderrError('was refused - did you specify the right host?'))
    await expect(ensureKubernetes()).rejects.toThrow(/yaac cluster check/)
  })
})

describe('execFileAsync', () => {
  beforeEach(() => {
    execFileMock.mockReset()
  })

  // The plain runner used for kind and podman: no namespace, no retries.
  it('runs a binary with its argv and resolves stdout/stderr', async () => {
    execFileMock.mockResolvedValue({ stdout: 'kind v0.30.0', stderr: '' })
    await expect(execFileAsync('kind', ['version'])).resolves.toEqual({
      stdout: 'kind v0.30.0', stderr: '',
    })
    expect(execFileMock).toHaveBeenCalledWith('kind', ['version'], expect.objectContaining({ maxBuffer: 64 << 20 }))
  })

  it('rejects without retrying when the binary fails', async () => {
    execFileMock.mockRejectedValue(stderrError('connection refused'))
    await expect(execFileAsync('kind', ['get', 'clusters'])).rejects.toThrow('kubectl failed')
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })
})
