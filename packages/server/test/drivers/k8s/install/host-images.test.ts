// host-images.ts's barrel functions against a real temp data dir, so the
// tracked-pid state file is asserted on disk. Fakes stop at the process
// boundary: `spawn` (podman and the registry's kubectl port-forward),
// `execFile` (`podman image inspect`), `fetch` (the registry) and the
// cluster (the grant key).
import crypto from 'node:crypto'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'

type ExecResult = { stdout: string; stderr: string }
type ExecCallback = (err: unknown, res?: ExecResult) => void
const execFileMock = vi.fn<(file: string, args: readonly string[]) => Promise<ExecResult>>()

interface FakeChild extends EventEmitter {
  pid: number
  stdout: PassThrough
  stderr: PassThrough
  exitCode: number | null
  signalCode: string | null
}
interface Spawned {
  file: string
  args: string[]
  child: FakeChild
  /** The `--authfile` as the child saw it: content and mode, read at spawn. */
  authFile?: { path: string; content: string; mode: number }
}
const spawned: Spawned[] = []
/** Exit code every podman child closes with, unless held. */
let podmanExitCode = 0
/** Keep podman children running so the test drives their output and exit. */
let holdPodman = false
let nextPid = 5001
/** Local port the fake `kubectl port-forward` reports listening on. */
const FORWARD_PORT = 41234

vi.mock('node:child_process', () => ({
  // Other barrel modules promisify `exec` at load time; it is never called.
  exec: vi.fn(),
  execFile: (file: string, args: readonly string[], opts: unknown, cb?: ExecCallback) => {
    const done = (typeof opts === 'function' ? opts : cb) as ExecCallback
    void execFileMock(file, args).then((res) => done(null, res), (err: unknown) => done(err))
  },
  spawn: (file: string, args: string[]) => {
    const pipe = (): PassThrough => Object.assign(new PassThrough(), { unref: vi.fn() })
    const child = Object.assign(new EventEmitter(), {
      pid: nextPid++,
      stdout: pipe(),
      stderr: pipe(),
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
      unref: vi.fn(),
    }) as FakeChild
    const authPath = args.includes('--authfile') ? args[args.indexOf('--authfile') + 1] : null
    spawned.push({
      file,
      args,
      child,
      authFile: authPath
        ? { path: authPath, content: fs.readFileSync(authPath, 'utf8'), mode: fs.statSync(authPath).mode & 0o777 }
        : undefined,
    })
    if (args[0] === 'port-forward') {
      // A live port-forward announces its listener and then stays up.
      process.nextTick(() => child.stdout.write(`Forwarding from 127.0.0.1:${FORWARD_PORT} -> 5000\n`))
    } else if (!holdPodman) {
      process.nextTick(() => child.emit('close', podmanExitCode))
    }
    return child
  },
}))

vi.mock('#lib/log', () => ({
  serverLog: vi.fn(),
  pipeToServerLog: vi.fn(),
}))

import { pipeToServerLog } from '#lib/log'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { clientLocalPath } from '@yaac/shared/paths'
import { ensureImageByTag, imageExists, pushImageToRegistry } from '#drivers/k8s/install'
// State-reset hooks, not units under test.
import { _clearTrackedPodmanProcsForTests } from '#drivers/k8s/install/host-procs'
import { _resetPortForwardsForTests } from '#drivers/k8s/substrate/port-forward'
import { _resetRegistryGrantKeyForTests } from '#drivers/k8s/cluster/registry-grant'

/** The cluster's grant key, seeded into the fake cluster before each test. */
const GRANT_KEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
/** The install's registry ref prefix. */
const CLUSTER_HOST = 'yaac-registry.yaac.svc.cluster.local:5000'
/** Where this process reaches the registry: the fake port-forward's local end. */
const ENDPOINT = `127.0.0.1:${FORWARD_PORT}`
/** Where podman reaches it under podman machine: the VM's alias for the host. */
const VM_ENDPOINT = `host.containers.internal:${FORWARD_PORT}`

const fetchMock = vi.fn<typeof fetch>()
const realPlatform = process.platform
let dataDir: string

/** The records an interrupted install leaves for the next one to reap. */
function readState(): Array<{ pid: number; tag: string; verb: string }> {
  return JSON.parse(fs.readFileSync(clientLocalPath('host-podman.json'), 'utf8')) as Array<{
    pid: number
    tag: string
    verb: string
  }>
}

function podmanChildren(): Spawned[] {
  return spawned.filter((s) => s.file === 'podman')
}

function forwards(): Spawned[] {
  return spawned.filter((s) => s.args[0] === 'port-forward')
}

/**
 * Pin the host platform, which decides whether podman shares this process's
 * network (Linux) or runs in a VM (macOS), and so which push address it gets.
 */
function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

function fetchResponse(init: { ok: boolean; status?: number }): Response {
  return { ok: init.ok, status: init.status ?? (init.ok ? 200 : 500) } as Response
}

/**
 * Check a push's `--authfile` the way the registry's write gate checks a
 * grant: for the engine's endpoint, signed by the cluster key, unexpired,
 * and for every repo (`*`). The file is mode 0600 and deleted after the push.
 */
function expectAdminAuthFile(push: Spawned, endpoint: string): void {
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
function withoutAuthFile(push: Spawned, endpoint = ENDPOINT): string[] {
  expectAdminAuthFile(push, endpoint)
  const i = push.args.indexOf('--authfile')
  return [...push.args.slice(0, i), ...push.args.slice(i + 2)]
}

beforeEach(async () => {
  dataDir = await createTempDataDir()
  spawned.length = 0
  podmanExitCode = 0
  holdPodman = false
  _clearTrackedPodmanProcsForTests()
  execFileMock.mockReset()
  execFileMock.mockRejectedValue(new Error('no such image'))
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  _resetPortForwardsForTests()
  fakeCluster.seed({
    apiVersion: 'v1', kind: 'Secret',
    metadata: { name: 'yaac-registry-grant-key', namespace: 'yaac-registry-keys' },
    data: { 'key.pem': Buffer.from(GRANT_KEY.export({ type: 'pkcs8', format: 'pem' })).toString('base64') },
  })
  _resetRegistryGrantKeyForTests()
  stubPlatform('linux')
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  _resetPortForwardsForTests()
  stubPlatform(realPlatform)
  await cleanupTempDir(dataDir)
})

describe('imageExists', () => {
  it('returns true when podman image inspect succeeds', async () => {
    execFileMock.mockResolvedValue({ stdout: '[]', stderr: '' })
    expect(await imageExists('yaac-tools:abc')).toBe(true)
    expect(execFileMock).toHaveBeenCalledWith('podman', ['image', 'inspect', 'yaac-tools:abc'])
  })

  it('returns false when inspect fails (image absent)', async () => {
    expect(await imageExists('missing:tag')).toBe(false)
  })
})

describe('ensureImageByTag', () => {
  it('builds a missing image, recording the build for the next install to reap until it exits', async () => {
    holdPodman = true
    const done = ensureImageByTag('img:tag', '/some/Dockerfile', '/some', { K: 'v' })
    await vi.waitFor(() => expect(podmanChildren()).toHaveLength(1))

    const [build] = podmanChildren()
    expect(build.args).toEqual(['build', '-t', 'img:tag', '-f', '/some/Dockerfile', '--build-arg', 'K=v', '/some'])
    // Written synchronously at spawn, so a SIGKILL on the next tick still
    // leaves a record to reap.
    expect(readState()).toEqual([{ pid: build.child.pid, tag: 'img:tag', verb: 'build' }])
    expect(vi.mocked(pipeToServerLog)).toHaveBeenCalledWith(
      expect.anything(), '[build img:tag] ', expect.any(Function),
    )

    build.child.emit('close', 0)
    await expect(done).resolves.toBeUndefined()
    expect(readState()).toEqual([])
  })

  it('skips the build when the tag is already in the host store', async () => {
    execFileMock.mockResolvedValue({ stdout: '[]', stderr: '' })
    await ensureImageByTag('img:tag', '/some/Dockerfile', '/some')
    expect(podmanChildren()).toEqual([])
  })

  it('rejects with the exit code, or a failed spawn, and stops tracking', async () => {
    podmanExitCode = 125
    await expect(ensureImageByTag('a:1', '/d', '/c')).rejects.toThrow('podman build exited with code 125')
    expect(readState()).toEqual([])

    holdPodman = true
    const done = ensureImageByTag('b:2', '/d', '/c')
    await vi.waitFor(() => expect(podmanChildren()).toHaveLength(2))
    podmanChildren()[1].child.emit('error', new Error('ENOENT podman'))
    await expect(done).rejects.toThrow('ENOENT podman')
    expect(readState()).toEqual([])
  })

  describe('build budgets', () => {
    /** Signals sent to each held build's process group. */
    let signals: string[]

    beforeEach(() => {
      holdPodman = true
      signals = []
      vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal: string) => {
        const child = podmanChildren().find((s) => -s.child.pid === pid)?.child
        if (!child) throw new Error(`ESRCH: unexpected process.kill(${pid})`)
        signals.push(signal)
        // Emits `exit` but never `close`, as when a grandchild holds the
        // pipes open. The run must settle on exit alone.
        child.signalCode = signal
        child.emit('exit', null, signal)
        return true
      }) as typeof process.kill)
    })

    async function startBuild(): Promise<{ build: Promise<void>; log: (line: string) => void; settled: () => boolean }> {
      // Faked before the spawn, so the budgets are armed on the fake clock.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const build = ensureImageByTag('img:tag', '/some/Dockerfile', '/some')
      await vi.waitFor(() => expect(podmanChildren()).toHaveLength(1))
      let done = false
      void build.then(() => { done = true }, () => { done = true })
      const { child } = podmanChildren()[0]
      return { build, log: (line) => { child.stdout.write(`${line}\n`) }, settled: () => done }
    }

    it('lets a build run past ten minutes while it keeps logging, and stops one silent for ten', async () => {
      const { build, log, settled } = await startBuild()
      for (let step = 1; step <= 4; step++) {
        await vi.advanceTimersByTimeAsync(9 * 60_000)
        log(`STEP ${step}/4: RUN make`)
        await vi.advanceTimersByTimeAsync(0)
      }
      expect(settled()).toBe(false) // 36 minutes in, never killed
      expect(signals).toEqual([])

      await vi.advanceTimersByTimeAsync(10 * 60_000)
      await expect(build).rejects.toThrow('podman build produced no output for 600s')
      expect(signals).toEqual(['SIGTERM'])
    })

    // A build stuck in a retry loop keeps printing, so it never goes idle
    // and would hold the image-store lock indefinitely.
    it('stops a wedged but chatty build at the one-hour backstop', async () => {
      const { build, log, settled } = await startBuild()
      for (let i = 0; i < 11; i++) {
        await vi.advanceTimersByTimeAsync(5 * 60_000)
        log(`retrying (attempt ${i})`)
        await vi.advanceTimersByTimeAsync(0)
      }
      expect(settled()).toBe(false)

      await vi.advanceTimersByTimeAsync(10 * 60_000)
      await expect(build).rejects.toThrow('podman build still running after 3600s')
      expect(signals).toEqual(['SIGTERM'])
    })
  })
})

describe('pushImageToRegistry', () => {
  it('skips the push when the immutable tag already exists', async () => {
    fetchMock.mockResolvedValue(fetchResponse({ ok: true })) // manifest HEAD hit
    await expect(pushImageToRegistry('yaac-tools:abc')).resolves.toBe(`${CLUSTER_HOST}/yaac-tools:abc`)
    expect(podmanChildren()).toHaveLength(0)
  })

  it('pushes through the forwarded endpoint with an admin grant, tracked, and returns the CLUSTER ref', async () => {
    fetchMock.mockResolvedValue(fetchResponse({ ok: false, status: 404 }))
    holdPodman = true
    const done = pushImageToRegistry('yaac-tools:abc')
    await vi.waitFor(() => expect(podmanChildren()).toHaveLength(1))
    const [push] = podmanChildren()
    expect(readState()).toEqual([{ pid: push.child.pid, tag: 'yaac-tools:abc', verb: 'push' }])
    push.child.emit('close', 0)

    // podman uploads through the forwarded loopback port; pods pull by the
    // Service FQDN. Both name the same repository path.
    await expect(done).resolves.toBe(`${CLUSTER_HOST}/yaac-tools:abc`)
    expect(readState()).toEqual([])
    // The write gate needs an admin grant. It goes in a file, not argv,
    // where `ps` would show it.
    expect(push.args.join(' ')).not.toContain('--creds')
    expect(withoutAuthFile(push)).toEqual([
      'push', '--tls-verify=false', 'yaac-tools:abc', `${ENDPOINT}/yaac-tools:abc`,
    ])
    expect(forwards().map((f) => f.args)).toEqual([[
      'port-forward', '-n', 'yaac', 'deploy/yaac-registry', '0:5000',
    ]])
  })

  it('targets the VM alias under podman machine, keeping the forwarded port', async () => {
    // Under podman machine the push runs inside the VM, where 127.0.0.1 is
    // the VM's own loopback, so podman needs a different address.
    stubPlatform('darwin')
    fetchMock.mockResolvedValue(fetchResponse({ ok: false, status: 404 }))
    await expect(pushImageToRegistry('yaac-tools:abc')).resolves.toBe(`${CLUSTER_HOST}/yaac-tools:abc`)
    expect(withoutAuthFile(podmanChildren()[0], VM_ENDPOINT)).toEqual([
      'push', '--tls-verify=false', 'yaac-tools:abc', `${VM_ENDPOINT}/yaac-tools:abc`,
    ])
    // One forward serves both the tag check and the push.
    expect(forwards()).toHaveLength(1)
    expect(fetchMock.mock.calls[0][0]).toContain(ENDPOINT)
  })

  it('rejects when podman push exits non-zero, still removing the grant file', async () => {
    fetchMock.mockResolvedValue(fetchResponse({ ok: false, status: 404 }))
    podmanExitCode = 125
    await expect(pushImageToRegistry('yaac-tools:abc')).rejects.toThrow('podman push exited with code 125')
    expect(fs.existsSync(podmanChildren()[0].authFile!.path)).toBe(false)
    expect(readState()).toEqual([])
  })

  it('passes --compression-format through (trust-split zstd parent pushes)', async () => {
    fetchMock.mockResolvedValue(fetchResponse({ ok: false, status: 404 }))
    await pushImageToRegistry('yaac-tools:abc', { compressionFormat: 'zstd' })
    expect(withoutAuthFile(podmanChildren()[0])).toEqual([
      'push', '--tls-verify=false', '--compression-format', 'zstd',
      'yaac-tools:abc', `${ENDPOINT}/yaac-tools:abc`,
    ])
  })
})
