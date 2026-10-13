/**
 * The image part of `yaac cluster install`: what it builds, mirrors and
 * skips, the orphaned podman processes it reaps first, and the host store
 * sweep it ends with. Fakes stop at the process boundary: podman (`spawn`
 * for builds and pushes, `execFile` for the rest), `ps`, `process.kill`,
 * the registry (`fetch`) and the cluster (the grant key). Real tag
 * resolution runs, so the tests assert the tags a workspace create looks up.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'
import { fakeRegistry } from '#test/support/fake-registry'

type ExecResult = { stdout: string; stderr: string }
type ExecCallback = (err: unknown, res?: ExecResult) => void
const mockExecFile = vi.hoisted(() => vi.fn<(file: string, args: string[]) => Promise<ExecResult>>())
/** Every spawned podman command's argv, in order. */
const spawned = vi.hoisted((): string[][] => [])
/** The exit code a spawned podman command closes with. */
const spawnExit = vi.hoisted(() => ({ code: (_args: string[]): number => 0 }))
/** Process events in order, to check the reap precedes every build. */
const events = vi.hoisted((): string[] => [])

vi.mock('node:child_process', () => ({
  exec: vi.fn(),
  execFile: (file: string, args: string[], opts: unknown, cb?: ExecCallback) => {
    const done = (typeof opts === 'function' ? opts : cb) as ExecCallback
    void mockExecFile(file, args).then((res) => done(null, res), (err: unknown) => done(err))
  },
  spawn: (_file: string, args: string[]) => {
    spawned.push(args)
    events.push(`spawn ${args[0]}`)
    const child = Object.assign(new EventEmitter(), {
      pid: 7000 + spawned.length,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
    })
    process.nextTick(() => child.emit('close', spawnExit.code(args)))
    return child
  },
}))

import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { clientLocalPath } from '@yaac/shared/paths'
import { buildBuiltinImages } from '#drivers/k8s/install'
import { BUILDER_LOCAL_TAG, resolveTrustedLayers } from '#drivers/k8s/cluster'
// Setup values and state-reset hooks, not units under test.
import { TRUSTED_PARENT_COMPRESSION } from '#drivers/k8s/install/builtin-images'
import { _clearTrackedPodmanProcsForTests } from '#drivers/k8s/install/host-procs'
import { HOST_PRUNE_UNTIL } from '#drivers/k8s/install/image-gc'
import { _resetRegistryGrantKeyForTests } from '#drivers/k8s/cluster/registry-grant'

const GRANT_KEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey

/** The tag of every `podman build` this run performed, in order. */
const built = (): string[] =>
  spawned.filter((a) => a[0] === 'build').map((a) => a[a.indexOf('-t') + 1])

/** Each pushed local tag, with the compression it was pushed with. */
const pushes = (): Array<{ tag: string; compression?: string }> =>
  spawned.filter((a) => a[0] === 'push').map((a) => {
    const c = a.indexOf('--compression-format')
    return { tag: a.at(-2)!, ...(c >= 0 ? { compression: a[c + 1] } : {}) }
  })

const podmanCalls = (sub: string): string[][] =>
  mockExecFile.mock.calls.filter(([f, a]) => f === 'podman' && a[0] === sub).map(([, a]) => a)

/** What an interrupted install leaves for the next one to reap. */
const statePath = (): string => clientLocalPath('host-podman.json')
const readState = (): Array<{ pid: number; tag: string; verb: string }> =>
  JSON.parse(fs.readFileSync(statePath(), 'utf8')) as Array<{ pid: number; tag: string; verb: string }>
const writeState = (records: Array<{ pid: number; tag: string; verb: string }>): void => {
  fs.writeFileSync(statePath(), JSON.stringify(records))
}

/**
 * A host engine with nothing built: `image inspect` misses, `ps` finds no
 * such process, and every other podman call succeeds with no output.
 */
function emptyEngine(file: string, args: string[]): Promise<ExecResult> {
  if (file === 'podman' && args[0] === 'image' && args[1] === 'inspect' && !args.includes('--format')) {
    return Promise.reject(new Error('no such image'))
  }
  if (file === 'ps') return Promise.reject(new Error('ps: no such process'))
  return Promise.resolve({ stdout: '', stderr: '' })
}

let dataDir: string

beforeEach(async () => {
  dataDir = await createTempDataDir()
  spawned.length = 0
  events.length = 0
  spawnExit.code = () => 0
  _clearTrackedPodmanProcsForTests()
  mockExecFile.mockReset()
  mockExecFile.mockImplementation(emptyEngine)
  fakeRegistry.install()
  fakeCluster.seed({
    apiVersion: 'v1', kind: 'Secret',
    metadata: { name: 'yaac-registry-grant-key', namespace: 'yaac-registry-keys' },
    data: { 'key.pem': Buffer.from(GRANT_KEY.export({ type: 'pkcs8', format: 'pem' })).toString('base64') },
  })
  _resetRegistryGrantKeyForTests()
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await cleanupTempDir(dataDir)
})

describe('buildBuiltinImages', () => {
  it('builds the whole trusted chain and pushes it under the tags a create looks up', async () => {
    await buildBuiltinImages({ log: vi.fn() })

    // The tags a create looks up, derived from content alone.
    const { base, tools, nestable } = await resolveTrustedLayers('yaac')
    // In dependency order: each layer is the next one's FROM.
    expect(built().slice(0, 3)).toEqual([base.tag, tools.tag, nestable.tag])
    // Pushed with zstd, since builder pods pull these as parents.
    for (const layer of [base, tools, nestable]) {
      expect(pushes()).toContainEqual({ tag: layer.tag, compression: TRUSTED_PARENT_COMPRESSION })
    }
  })

  it('builds the proxy and netd images, and mirrors every pinned upstream', async () => {
    await buildBuiltinImages({ log: vi.fn() })

    // The other yaac-built images, also content-hash tagged.
    expect(built().some((t) => t.startsWith('yaac-proxy:'))).toBe(true)
    expect(built().some((t) => t.startsWith('yaac-netd:'))).toBe(true)
    // Digest-pinned upstreams are pulled, retagged and pushed, so nodes
    // never pull from upstream.
    const pulls = podmanCalls('pull').map((a) => a[1])
    expect(pulls.some((r) => r.includes('library/registry@sha256:'))).toBe(true)
    expect(pulls.some((r) => r.includes('envoyproxy/envoy@sha256:'))).toBe(true)
    expect(pulls.some((r) => r.includes('podman/stable@sha256:'))).toBe(true)
    expect(pulls.some((r) => r.includes('curlimages/curl@sha256:'))).toBe(true)
    expect(podmanCalls('tag').map((a) => a[2])).toContain(BUILDER_LOCAL_TAG)
    expect(pushes().map((p) => p.tag)).toContain(BUILDER_LOCAL_TAG)
  })

  it('is a no-op when the registry already holds every tag', async () => {
    // With content-hash tags, re-running install with no changes costs
    // only registry lookups.
    fakeRegistry.holdsAll = true

    await buildBuiltinImages({ log: vi.fn() })

    expect(spawned).toEqual([])
    // The mirrors skip on the same check.
    expect(podmanCalls('pull')).toEqual([])
  })

  it('fails the install when a shipped image fails to build', async () => {
    spawnExit.code = (args) => args[0] === 'build' && args[2].startsWith('yaac-proxy:') ? 1 : 0

    await expect(buildBuiltinImages({ log: vi.fn() }))
      .rejects.toThrow('podman build exited with code 1')
  })

  it('refuses an upstream mirror built for another architecture', async () => {
    // A digest pinned to one platform's manifest would crashloop on other
    // hosts with `exec format error`. The arch check fails at mirror time.
    const realArch = process.arch
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
    try {
      mockExecFile.mockImplementation((file, args) => args.includes('{{.Architecture}}')
        ? Promise.resolve({ stdout: 'arm64', stderr: '' })
        : emptyEngine(file, args))
      await expect(buildBuiltinImages({ log: vi.fn() }))
        .rejects.toThrow(/is a arm64 image but this host is amd64/)
    } finally {
      Object.defineProperty(process, 'arch', { value: realArch, configurable: true })
    }
  })

  describe('host store sweep', () => {
    // Newest first, as `podman image ls --sort created` prints. Four
    // yaac-base generations (two over the budget), one registry-staged yaac
    // ref, three e2e-suite generations, three non-yaac tags, a dangling row
    // and a blank row.
    const LS_OUTPUT = [
      'localhost/yaac-base|localhost/yaac-base:new1',
      'localhost/yaac-base|localhost/yaac-base:new2',
      'localhost/yaac-base|localhost/yaac-base:old1',
      'localhost/yaac-base|localhost/yaac-base:old2',
      'localhost:5001/yaac-user-demo|localhost:5001/yaac-user-demo:a',
      'localhost/yaac-test-server|localhost/yaac-test-server:t1',
      'localhost/yaac-test-server|localhost/yaac-test-server:t2',
      'localhost/yaac-test-server|localhost/yaac-test-server:t3',
      'docker.io/library/ubuntu|docker.io/library/ubuntu:26.04',
      'docker.io/library/ubuntu|docker.io/library/ubuntu:24.04',
      'docker.io/library/ubuntu|docker.io/library/ubuntu:22.04',
      '<none>|<none>:<none>',
      '',
    ].join('\n')

    beforeEach(() => {
      fakeRegistry.holdsAll = true
      mockExecFile.mockImplementation((file, args) => {
        if (args[0] === 'image' && args[1] === 'ls') return Promise.resolve({ stdout: LS_OUTPUT, stderr: '' })
        if (args[1] === 'prune') {
          return Promise.resolve({ stdout: `${'a'.repeat(64)}\n${'b'.repeat(64)}\n`, stderr: '' })
        }
        return emptyEngine(file, args)
      })
    })

    it('retires stale yaac generations, then prunes dangling images past the age floor', async () => {
      const log = vi.fn()
      await buildBuiltinImages({ log })

      // No -f: a tag in use by a container or a running build must fail rmi
      // and wait for the next sweep. The registry-staged ref is within
      // budget, ubuntu is not a yaac repo, and yaac-test-* belongs to the
      // e2e suite, which may be using it on another rig.
      expect(podmanCalls('rmi')).toEqual([
        ['rmi', 'localhost/yaac-base:old1'],
        ['rmi', 'localhost/yaac-base:old2'],
      ])
      expect(podmanCalls('image').filter((a) => a[1] === 'prune')).toEqual([
        ['image', 'prune', '-f', '--filter', `until=${HOST_PRUNE_UNTIL}`],
      ])
      expect(log).toHaveBeenCalledWith(
        'Reclaimed 2 stale image tag(s) and 2 dangling image(s) from the host build store.',
      )
    })

    it('finishes the install even when the sweep fails', async () => {
      mockExecFile.mockImplementation((file, args) => args[0] === 'image' && args[1] === 'ls'
        ? Promise.reject(new Error('cannot connect to podman'))
        : emptyEngine(file, args))
      const log = vi.fn()

      await expect(buildBuiltinImages({ log })).resolves.toBeUndefined()

      expect(log.mock.calls.map((c) => String(c[0])).join('\n'))
        .toMatch(/could not sweep the host image store/)
    })
  })

  describe('orphaned podman processes', () => {
    /** `ps` sees `cmdline` at each pid listed; any other pid is gone. */
    function psSees(cmdlines: Record<number, string | string[]>): void {
      const seen = new Map(Object.entries(cmdlines).map(([pid, c]) => [pid, [c].flat()]))
      mockExecFile.mockImplementation((file, args) => {
        if (file !== 'ps') return emptyEngine(file, args)
        events.push(`ps ${args[1]}`)
        const lines = seen.get(args[1])
        if (!lines) return Promise.reject(new Error('ps: no such process'))
        // Each call consumes one answer; the last one sticks.
        const line = lines.length > 1 ? lines.shift()! : lines[0]
        return Promise.resolve({ stdout: `${line}\n`, stderr: '' })
      })
    }

    /** Record kills; a pid dies on SIGTERM unless `survives` is set. */
    function spyKill(survives = false): MockInstance<typeof process.kill> {
      return vi.spyOn(process, 'kill').mockImplementation((pid: number, sig?: string | number) => {
        if (sig === 0 && !survives) throw new Error('ESRCH')
        if (sig !== 0) events.push(`kill ${pid} ${String(sig)}`)
        return true
      })
    }

    it('kills a previous install\'s surviving build before building, and clears the record', async () => {
      writeState([{ pid: 9001, tag: 'yaac-tools:abc', verb: 'build' }])
      psSees({ 9001: 'podman build -t yaac-tools:abc /home/u/.yaac/dockerfiles' })
      const kill = spyKill()

      await buildBuiltinImages({ log: vi.fn() })

      expect(kill).toHaveBeenCalledWith(9001, 'SIGTERM')
      expect(kill).not.toHaveBeenCalledWith(9001, 'SIGKILL')
      // Before the first build, which would fight the orphan for the
      // image-store lock.
      expect(events.indexOf('kill 9001 SIGTERM')).toBeLessThan(events.indexOf('spawn build'))
      expect(readState()).toEqual([])
    })

    it('skips records whose pid could signal a process group', async () => {
      // `process.kill(0)` signals our own process group and `process.kill(-n)`
      // all of group n, so these must be rejected before `ps` runs.
      fakeRegistry.holdsAll = true
      writeState([
        { pid: 0, tag: 'a:1', verb: 'build' },
        { pid: -4242, tag: 'b:2', verb: 'build' },
        { pid: NaN, tag: 'c:3', verb: 'build' },
        { pid: 1.5, tag: 'd:4', verb: 'build' },
      ])
      psSees({})
      const kill = spyKill()

      await buildBuiltinImages({ log: vi.fn() })

      expect(events.filter((e) => e.startsWith('ps'))).toEqual([])
      expect(kill).not.toHaveBeenCalled()
    })

    it('leaves a reused pid alone when it is no longer our podman build', async () => {
      fakeRegistry.holdsAll = true
      writeState([
        { pid: 9001, tag: 'yaac-tools:abc', verb: 'build' },
        { pid: 9002, tag: 'yaac-base:def', verb: 'build' },
      ])
      // 9001 exited and the pid was handed to something else; 9002 is gone.
      psSees({ 9001: 'vim notes.md' })
      const kill = spyKill()

      await buildBuiltinImages({ log: vi.fn() })

      expect(kill).not.toHaveBeenCalled()
      expect(readState()).toEqual([])
    })

    it('escalates to SIGKILL when the orphan ignores SIGTERM, keeping the record until then', async () => {
      fakeRegistry.holdsAll = true
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      writeState([{ pid: 9001, tag: 'yaac-tools:abc', verb: 'build' }])
      psSees({ 9001: 'podman build -t yaac-tools:abc .' })
      const kill = spyKill(true)

      const done = buildBuiltinImages({ log: vi.fn() })
      // The record stays on disk through the grace period, so an install
      // that dies mid-kill leaves it for the next one.
      await vi.advanceTimersByTimeAsync(2000)
      expect(readState().map((r) => r.pid)).toEqual([9001])

      // 25 chained 200ms polls, each scheduled as the previous resolves.
      await vi.advanceTimersByTimeAsync(6000)
      await done

      expect(kill).toHaveBeenCalledWith(9001, 'SIGTERM')
      expect(kill).toHaveBeenCalledWith(9001, 'SIGKILL')
      expect(readState()).toEqual([])
    })

    it('does not SIGKILL a pid that stopped being ours during the grace period', async () => {
      fakeRegistry.holdsAll = true
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      writeState([{ pid: 9001, tag: 'yaac-tools:abc', verb: 'build' }])
      psSees({ 9001: ['podman build -t yaac-tools:abc .', 'psql -h localhost'] })
      const kill = spyKill(true)

      const done = buildBuiltinImages({ log: vi.fn() })
      await vi.advanceTimersByTimeAsync(6000)
      await done

      expect(kill).toHaveBeenCalledWith(9001, 'SIGTERM')
      expect(kill).not.toHaveBeenCalledWith(9001, 'SIGKILL')
    })

    it('starts no state file when there was none, and clears a torn one', async () => {
      fakeRegistry.holdsAll = true
      const kill = spyKill()
      await buildBuiltinImages({ log: vi.fn() })
      expect(fs.existsSync(statePath())).toBe(false)

      fs.writeFileSync(statePath(), '[{"pid":90')
      await buildBuiltinImages({ log: vi.fn() })
      expect(kill).not.toHaveBeenCalled()
      // Rewritten, so the garbage is not re-read on every install.
      expect(readState()).toEqual([])
    })
  })
})
