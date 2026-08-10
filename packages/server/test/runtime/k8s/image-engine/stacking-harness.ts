/**
 * Shared harness for the two `*-stacking` test files. They drive the real
 * image feature — chain resolution, tag hashing, engine routing — against a
 * real temp data dir, faking only the process boundary: podman (through
 * `node:child_process`), the local registry, and the builder pod. Host builds
 * and untrusted-layer pod builds both record one `build <tag> [args]` row in
 * `operations`, so a stacking assertion reads a single uniform log.
 */
import { beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
// Type-only: the values come from the dynamic imports in `load`, which must
// run after vi.resetModules() to pick up the mocks below.
import type * as imageBuilder from '#runtime/k8s/image-engine/image-builder'
import type * as buildCoordinator from '#runtime/k8s/images/build-coordinator'

/** The 16-hex-char content hash every layer tag ends in. */
export const HASH_RE = '[0-9a-f]{16}'

type ImagesModules = typeof imageBuilder & typeof buildCoordinator

/** A podman build the fake is holding open, for tests that drive its clock. */
export interface HeldBuild {
  /** Write a line of build output — the idle timeout's only "still alive" signal. */
  log(line: string): void
  /** Signals the runner has sent this child's process group, in order. */
  readonly signals: string[]
}

export interface StackingHarness {
  /** Real temp data dir for this test; write Dockerfiles under it before `load`. */
  readonly dataDir: string
  /** Ordered `build <tag> [k=v,…][ --no-cache]` rows in build order. */
  readonly operations: string[]
  /**
   * Stop the podman fake from exiting on its own, so a test owns when (and
   * whether) a build produces output. Held builds land in `heldBuilds`.
   * Call before `load`.
   */
  holdBuilds(): void
  readonly heldBuilds: HeldBuild[]
  /** Import the feature fresh against the fakes below. Call after staging files. */
  load(): Promise<ImagesModules>
}

/**
 * Register the per-test data dir and process-boundary fakes, and return the
 * handle the test drives. Call once inside a `describe`.
 */
/** Fictional pids: the process.kill spy below never lets one reach the OS. */
const FAKE_PID_BASE = 990_001

export function setupStackingHarness(): StackingHarness {
  const operations: string[] = []
  const heldBuilds: HeldBuild[] = []
  /** Group pid (negative) -> what the fake child does when signalled. */
  const killedGroups = new Map<number, (signal: string) => void>()
  const state = { dataDir: '', hold: false }

  beforeEach(async () => {
    operations.length = 0
    heldBuilds.length = 0
    killedGroups.clear()
    state.hold = false
    state.dataDir = await createTempDataDir()
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.doUnmock('node:child_process')
    vi.doUnmock('#platform/container/registry')
    vi.doUnmock('#runtime/k8s/images/builder-pod')
    await cleanupTempDir(state.dataDir)
  })

  async function load(): Promise<ImagesModules> {
    // Reset the module cache so runtime.ts re-evaluates `promisify(execFile)`
    // against the mocked child_process below. Without this, execFileAsync keeps
    // the real execFile captured on first load and imageExists hits real podman
    // — which can return true for yaac-base:<hash> images that exist on the
    // dev machine, causing layers to be silently skipped. The reset also
    // wipes the paths.ts data-dir singleton, so we re-apply setDataDir on the
    // freshly-imported module below.
    vi.resetModules()
    vi.doMock('node:child_process', () => ({
      execFile: vi.fn((...allArgs: unknown[]) => {
        const args = allArgs[1] as string[]
        const cb = allArgs[allArgs.length - 1] as (...cbArgs: unknown[]) => void

        if (args[0] === 'image' && args[1] === 'inspect') {
          cb(new Error('no such image'), { stdout: '', stderr: '' })
          return
        }
        cb(null, { stdout: '', stderr: '' })
      }),
      exec: vi.fn((_cmd: string, optsOrCb: unknown, maybeCb?: unknown) => {
        const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (...cbArgs: unknown[]) => void
        cb(null, { stdout: '', stderr: '' })
      }),
      spawn: vi.fn((_cmd: string, args: string[]) => {
        const tIdx = args.indexOf('-t')
        const imageName = tIdx >= 0 ? args[tIdx + 1] : 'unknown'
        const buildArgPairs: string[] = []
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '--build-arg') buildArgPairs.push(args[i + 1])
        }
        const suffix = buildArgPairs.length ? ` [${buildArgPairs.join(',')}]` : ''
        const noCache = args.includes('--no-cache') ? ' --no-cache' : ''
        operations.push(`build ${imageName}${suffix}${noCache}`)
        // Real streams: the idle timeout watches them for output, so a
        // stubbed `on` would make every build look permanently silent.
        // `exitCode`/`signalCode` are what `killGroup` checks before
        // signalling, and the pid is what it signals (negated: the group).
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          pid: FAKE_PID_BASE + heldBuilds.length,
          exitCode: null as number | null,
          signalCode: null as string | null,
          kill: vi.fn(),
        })
        if (!state.hold) {
          process.nextTick(() => child.emit('close', 0))
          return child
        }
        const signals: string[] = []
        killedGroups.set(-child.pid, (signal) => {
          signals.push(signal)
          // The process dies, but `close` never comes: a grandchild
          // inherited the stdio pipes and holds them open. A killed run must
          // settle on the process being gone, not on the pipes draining.
          child.exitCode = null
          child.signalCode = signal
          child.emit('exit', null, signal)
        })
        heldBuilds.push({
          signals,
          log: (line: string) => { child.stdout.write(`${line}\n`) },
        })
        return child
      }),
    }))

    // Untrusted layers route to the builder-pod engine (trust-split is
    // always on). Mock it to record the same `build <tag> [args]` rows the
    // spawn fake records for host builds; registry mocked so the
    // untrusted-layer exists-check (registryHasTag) never touches the network.
    vi.doMock('#platform/container/registry', () => ({
      registryHasTag: vi.fn().mockResolvedValue(false),
      registryRef: (tag: string) => `localhost:5001/${tag}`,
      pushImageToRegistry: vi.fn().mockResolvedValue('pushed'),
    }))
    vi.doMock('#runtime/k8s/images/builder-pod', () => ({
      BuilderPodLease: class {
        acquire(): Promise<string> { return Promise.resolve('builder-pod') }
        release(): Promise<void> { return Promise.resolve() }
      },
      buildLayerInPod: vi.fn(
        (
          layer: { tag: string; buildArgs?: Record<string, string> },
          ctx: { noCache: boolean },
        ) => {
          const pairs = Object.entries(layer.buildArgs ?? {}).map(([k, v]) => `${k}=${v}`)
          const suffix = pairs.length ? ` [${pairs.join(',')}]` : ''
          operations.push(`build ${layer.tag}${suffix}${ctx.noCache ? ' --no-cache' : ''}`)
          return Promise.resolve()
        },
      ),
    }))

    // Dynamic imports are required: vi.resetModules() above invalidates the
    // module cache, and we need these fresh imports to pick up the doMock
    // above — static imports would keep the stale, pre-reset bindings.
    // eslint-disable-next-line no-restricted-syntax
    const paths = await import('@yaac/shared/project-paths')
    paths.setDataDir(state.dataDir)
    // eslint-disable-next-line no-restricted-syntax
    const builder = await import('#runtime/k8s/image-engine/image-builder')
    // eslint-disable-next-line no-restricted-syntax
    const coordinator = await import('#runtime/k8s/images/build-coordinator')
    return { ...builder, ...coordinator }
  }

  return {
    get dataDir() { return state.dataDir },
    operations,
    heldBuilds,
    holdBuilds() {
      state.hold = true
      // Held children are killed by pid — spied, so a fictional pid can
      // never reach a real process group.
      vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal: string) => {
        const die = killedGroups.get(pid)
        if (!die) throw new Error(`ESRCH: unexpected process.kill(${pid})`)
        die(signal)
        return true
      }) as typeof process.kill)
    },
    load,
  }
}
