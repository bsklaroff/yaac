/**
 * Shared harness for the two `*-stacking` test files. They run the real image
 * code (chain resolution, tag hashing, engine routing) against a temp data
 * dir, faking only podman (via `node:child_process`), the local registry and
 * the builder pod. Host builds and builder-pod builds both record a
 * `build <tag> [args]` row in `operations`.
 */
import { beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
// Type-only: `load` imports the values after vi.resetModules().
import type * as imageBuilder from '#drivers/k8s/image-engine/image-builder'
import type * as buildCoordinator from '#drivers/k8s/images/build-coordinator'

/** The 16-hex-char content hash every layer tag ends in. */
export const HASH_RE = '[0-9a-f]{16}'

type ImagesModules = typeof imageBuilder & typeof buildCoordinator

/** A podman build the fake is holding open, for tests that drive its clock. */
export interface HeldBuild {
  /** Write a line of build output, which resets the idle timeout. */
  log(line: string): void
  /** Signals the runner has sent this child's process group, in order. */
  readonly signals: string[]
}

export interface StackingHarness {
  /** Real temp data dir for this test; write Dockerfiles under it before `load`. */
  readonly dataDir: string
  /** Ordered `build <tag> [k=v,…]` rows in build order. */
  readonly operations: string[]
  /**
   * Declare which tags the local registry holds. `yaac cluster install`
   * builds the yaac-shipped layers, so a build expected to succeed must
   * stage them.
   */
  stageRegistry(tags: readonly string[]): void
  /**
   * Keep the podman fake from exiting on its own, so the test controls its
   * output. Held builds land in `heldBuilds`. Call before `load`.
   */
  holdBuilds(): void
  readonly heldBuilds: HeldBuild[]
  /** Import the feature fresh against the fakes below. Call after staging files. */
  load(): Promise<ImagesModules>
}

/** Fake pids; the process.kill spy keeps them from reaching the OS. */
const FAKE_PID_BASE = 990_001

/**
 * Register the per-test data dir and process fakes, and return the handle the
 * test drives. Call once inside a `describe`.
 */
export function setupStackingHarness(): StackingHarness {
  const operations: string[] = []
  const heldBuilds: HeldBuild[] = []
  /** Group pid (negative) -> what the fake child does when signalled. */
  const killedGroups = new Map<number, (signal: string) => void>()
  const state = { dataDir: '', hold: false, registryTags: new Set<string>() }

  beforeEach(async () => {
    operations.length = 0
    heldBuilds.length = 0
    killedGroups.clear()
    state.hold = false
    state.registryTags.clear()
    state.dataDir = await createTempDataDir()
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.doUnmock('node:child_process')
    vi.doUnmock('#drivers/k8s/container/registry')
    vi.doUnmock('#drivers/k8s/images/builder-pod')
    await cleanupTempDir(state.dataDir)
  })

  async function load(): Promise<ImagesModules> {
    // Reset modules so `promisify(execFile)` binds to the mock below;
    // otherwise imageExists could hit real podman and skip layers that
    // exist on the dev machine. The reset also clears the data-dir setting,
    // so it is re-applied below.
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
        operations.push(`build ${imageName}${suffix}`)
        // Real streams, because the idle timeout watches them. `killGroup`
        // checks exitCode/signalCode and signals -pid (the group).
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
          // Emits `exit` but never `close`, as when a grandchild holds the
          // pipes open. The runner must settle on exit alone.
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

    // Untrusted layers build in a builder pod; the fake records the same
    // rows as host builds. The registry fake answers from `stageRegistry`.
    vi.doMock('#drivers/k8s/container/registry', () => ({
      registryHasTag: vi.fn((tag: string) => Promise.resolve(state.registryTags.has(tag))),
      registryRef: (tag: string) => `localhost:5001/${tag}`,
      pushImageToRegistry: vi.fn().mockResolvedValue('pushed'),
    }))
    vi.doMock('#drivers/k8s/images/builder-pod', () => ({
      BuilderPodLease: class {
        acquire(): Promise<string> { return Promise.resolve('builder-pod') }
        release(): Promise<void> { return Promise.resolve() }
      },
      buildLayerInPod: vi.fn(
        (layer: { tag: string; buildArgs?: Record<string, string> }) => {
          const pairs = Object.entries(layer.buildArgs ?? {}).map(([k, v]) => `${k}=${v}`)
          const suffix = pairs.length ? ` [${pairs.join(',')}]` : ''
          operations.push(`build ${layer.tag}${suffix}`)
          return Promise.resolve()
        },
      ),
    }))

    // Dynamic imports, so the fresh modules pick up the doMocks above.
    // eslint-disable-next-line no-restricted-syntax
    const paths = await import('@yaac/shared/project-paths')
    paths.setDataDir(state.dataDir)
    // eslint-disable-next-line no-restricted-syntax
    const builder = await import('#drivers/k8s/image-engine/image-builder')
    // eslint-disable-next-line no-restricted-syntax
    const coordinator = await import('#drivers/k8s/images/build-coordinator')
    return { ...builder, ...coordinator }
  }

  return {
    get dataDir() { return state.dataDir },
    operations,
    heldBuilds,
    stageRegistry(tags: readonly string[]) {
      for (const tag of tags) state.registryTags.add(tag)
    },
    holdBuilds() {
      state.hold = true
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
