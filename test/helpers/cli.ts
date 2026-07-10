import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setDataDir } from '@/shared/paths'
import { readLock, type DaemonLock } from '@/shared/lock'
import { TEST_NAMESPACE } from '@test/helpers/setup'
import { e2eMkdtemp } from '@test/helpers/tmp'

const TSX_CLI = path.resolve(__dirname, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')
const ENTRY = path.resolve(__dirname, '..', '..', 'src', 'cli.ts')

/**
 * Cross-worker mutex so only one `yaac daemon run` is live at a time
 * across all vitest workers. Multiple daemons hammering the shared
 * cluster API server and the podman build engine concurrently starves
 * both, so daemon-backed suites serialize on this lock.
 *
 * Lock file holds the owner's PID so a crashed holder doesn't wedge
 * the suite forever. fs.open(wx) is atomic across processes.
 */
const DAEMON_LOCK_FILE = path.join(os.tmpdir(), 'yaac-test-daemon-mutex.lock')

/**
 * Base for the per-worker daemon port set via `YAAC_DAEMON_PORT`. Chosen well
 * clear of the real default (DEFAULT_DAEMON_PORT = 8787) so the fixed-port
 * `daemon start`/`restart` suites never collide with a developer's own daemon
 * on 8787. `spawnYaacDaemon` passes `--port 0` and ignores this; only suites
 * that bind the default port (no `--port`) observe it.
 */
const TEST_DAEMON_PORT_BASE = 18800

// Process-reentrant: if this worker already owns the file lock, a
// nested acquire just bumps a refcount. The file lock is only released
// when the refcount drops back to zero. Prevents a file-level mutex
// (e.g. daemon.test.ts's beforeAll) from deadlocking against per-test
// spawnYaacDaemon acquires in the same worker.
let localDepth = 0
let pendingFileUnlink: Promise<void> | null = null

export async function acquireDaemonMutex(): Promise<() => Promise<void>> {
  if (localDepth > 0) {
    localDepth += 1
    let released = false
    return async (): Promise<void> => {
      if (released) return
      released = true
      localDepth -= 1
      if (localDepth === 0 && pendingFileUnlink) {
        await pendingFileUnlink
        pendingFileUnlink = null
      }
    }
  }

  for (;;) {
    try {
      const fh = await fs.open(DAEMON_LOCK_FILE, 'wx')
      await fh.writeFile(String(process.pid))
      await fh.close()
      localDepth = 1
      let released = false
      return async (): Promise<void> => {
        if (released) return
        released = true
        localDepth -= 1
        if (localDepth === 0) {
          pendingFileUnlink = fs.unlink(DAEMON_LOCK_FILE).catch(() => { /* already gone */ })
          await pendingFileUnlink
          pendingFileUnlink = null
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // Existing lock — check if the holder is still alive.
      try {
        const raw = await fs.readFile(DAEMON_LOCK_FILE, 'utf8')
        const holderPid = parseInt(raw.trim(), 10)
        if (!Number.isNaN(holderPid)) {
          try {
            process.kill(holderPid, 0)
          } catch {
            // Holder is gone — steal the lock.
            await fs.unlink(DAEMON_LOCK_FILE).catch(() => { /* raced */ })
            continue
          }
        }
      } catch { /* lock vanished between readdir and read; retry */ }
      await new Promise((r) => setTimeout(r, 50))
    }
  }
}

export interface YaacTestEnv {
  scratchDir: string
  dataDir: string
  gitConfigPath: string
  /** Port the daemon binds when started without `--port` (via YAAC_DAEMON_PORT). */
  daemonPort: number
  env: NodeJS.ProcessEnv
  cleanup: () => Promise<void>
}

/**
 * Per-test isolation. We use `YAAC_DATA_DIR` (daemon) + `setDataDir()`
 * (test process) to redirect the yaac data dir, rather than
 * overriding HOME — overriding HOME breaks podman, which reads its
 * config from `$HOME/.config/containers/`. `GIT_CONFIG_GLOBAL`
 * redirects git's global config for the same reason: tests that need
 * a user identity write to `gitConfigPath` and leave the real
 * `~/.gitconfig` untouched.
 *
 * Test-only daemon hooks are preset here so container-backed tests
 * land on pre-built images and a worker-isolated kubernetes namespace;
 * tests that do not touch containers just ignore them.
 */
export async function createYaacTestEnv(): Promise<YaacTestEnv> {
  const scratchDir = await e2eMkdtemp('yaac-e2ecli-')
  const dataDir = path.join(scratchDir, 'data')
  const gitConfigPath = path.join(scratchDir, 'gitconfig')
  await fs.mkdir(path.join(dataDir, 'projects'), { recursive: true })
  await fs.writeFile(gitConfigPath, '')
  setDataDir(dataDir)
  // Mirror the namespace into the test process so src helpers used by
  // assertions (listSessionPods, containerExec, ...) hit the same
  // namespace as the daemon subprocess.
  process.env.YAAC_K8S_NAMESPACE = TEST_NAMESPACE

  // Per-worker default port so a fixed-port `daemon start`/`restart` daemon
  // lands clear of 8787 — both another worker's daemon and any real daemon
  // a developer is running locally.
  const workerId = Number.parseInt(process.env.VITEST_WORKER_ID ?? '1', 10)
  const daemonPort = TEST_DAEMON_PORT_BASE + (Number.isNaN(workerId) ? 0 : workerId)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    YAAC_DATA_DIR: dataDir,
    GIT_CONFIG_GLOBAL: gitConfigPath,
    YAAC_DAEMON_PORT: String(daemonPort),
    YAAC_BUILD_ID: 'test-build-id',
    YAAC_IMAGE_PREFIX: 'yaac-test',
    YAAC_PROXY_IMAGE: 'yaac-test-proxy',
    YAAC_K8S_NAMESPACE: TEST_NAMESPACE,
    YAAC_REQUIRE_PREBUILT_IMAGES: '1',
    // Prewarming is on by default in production, but a background pool that
    // spawns spares (and vcluster stacks) under every e2e suite would burn
    // cluster resources and perturb assertions. Off by default; the dedicated
    // prewarm suite re-enables it with `{ ...env, YAAC_PREWARM_POOL_SIZE: '1' }`.
    YAAC_PREWARM_POOL_SIZE: '0',
    // Same reasoning for the background image-prewarm sweep — e2e images are
    // prebuilt by the global setup and workers must never race a podman build.
    YAAC_IMAGE_PREWARM: '0',
    // Auto-titling would pull the llama.cpp binary + a ~114MB model under
    // every e2e daemon (and retitle sessions mid-assertion); the feature is
    // unit-tested with a stubbed runner instead.
    YAAC_AUTO_TITLES: '0',
  }

  const cleanup = async (): Promise<void> => {
    await fs.rm(scratchDir, { recursive: true, force: true })
  }

  return { scratchDir, dataDir, gitConfigPath, daemonPort, env, cleanup }
}

export interface SpawnedDaemon {
  child: ChildProcess
  lock: DaemonLock
  stop: () => Promise<void>
}

/**
 * Spawn a real `yaac daemon run` subprocess under the given env. Polls
 * for the lock file (5s budget) so the caller can read `.lock.port`
 * without races. The daemon leads its own process group; `stop()`
 * SIGTERMs that group, falling back to a group SIGKILL after 15s so the
 * daemon's forked children are reaped rather than orphaned.
 *
 * Acquires the cross-worker daemon mutex before spawning so only one
 * yaac daemon exists across all parallel vitest workers at any time.
 * `stop()` releases it after the child has exited.
 */
export async function spawnYaacDaemon(env: NodeJS.ProcessEnv): Promise<SpawnedDaemon> {
  const releaseMutex = await acquireDaemonMutex()
  let mutexReleased = false
  const releaseOnce = async (): Promise<void> => {
    if (mutexReleased) return
    mutexReleased = true
    await releaseMutex()
  }

  let child: ChildProcess
  let lock: DaemonLock
  try {
    child = spawn(process.execPath, [TSX_CLI, ENTRY, 'daemon', 'run', '--port', '0'], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
      // Make the daemon its own process-group leader (setsid) so `stop()`
      // can signal the whole group. The daemon forks long-lived children
      // (`kubectl port-forward`/`exec` relays) that inherit this pgid; a
      // group kill reaps them even on the SIGKILL path, instead of leaving
      // them orphaned to accumulate across the serialized e2e files until
      // the cgroup pid ceiling is hit and `fork()` starts returning EAGAIN.
      detached: true,
    })

    // Forward daemon stderr to the test worker's stderr when the debug
    // flag is set — invaluable when a daemon subprocess dies before the
    // CLI can observe a coherent error.
    if (process.env.YAAC_TEST_DEBUG_DAEMON === '1') {
      child.stderr?.on('data', (chunk: Buffer) => {
        process.stderr.write(`[daemon] ${chunk.toString()}`)
      })
    }

    lock = await waitForLock(5000)
  } catch (err) {
    await releaseOnce()
    throw err
  }

  const stop = async (): Promise<void> => {
    try {
      if (child.exitCode === null) {
        // SIGTERM the whole group: the daemon runs its shutdown handler
        // (which calls `removeLock()`, so lock-cleanup assertions stay
        // green), and its `kubectl port-forward`/`exec` children get the
        // signal directly rather than waiting on the daemon to tear them
        // down.
        killGroup(child, 'SIGTERM')
        await new Promise<void>((resolve) => {
          // Give the daemon up to 15s to finish its current background-loop
          // tick (session reconcile, blocked-host persist) before we
          // force-kill. SIGKILL bypasses the shutdown handler's
          // `removeLock()` call, so a too-short timeout leaves stale lock
          // files and flakes tests that assert on lock cleanup.
          const t = setTimeout(() => {
            // SIGKILL the group, not just the daemon: a force-killed daemon
            // never reaps its children, so without this they orphan and
            // leak across the serialized e2e files.
            killGroup(child, 'SIGKILL')
            resolve()
          }, 15000)
          child.once('exit', () => {
            clearTimeout(t)
            resolve()
          })
        })
      }
    } finally {
      await releaseOnce()
    }
  }

  return { child, lock, stop }
}

/**
 * Signal a daemon's entire process group (negative PID). The daemon is
 * spawned `detached`, so it leads its own group and a group-directed
 * signal reaches every child it forked. Falls back to signalling just the
 * daemon if the group is already gone (ESRCH) or the PID is unknown.
 */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    // Group already exited (ESRCH) or can't be addressed — try the lone
    // child as a best effort; ignore if it's gone too.
    try {
      child.kill(signal)
    } catch {
      // Already dead; nothing to clean up.
    }
  }
}

async function waitForLock(timeoutMs: number): Promise<DaemonLock> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const lock = await readLock()
    if (lock) return lock
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('daemon did not write the lock within timeout')
}

export interface RunYaacResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

export interface RunYaacOptions {
  /**
   * Data to write to stdin. Pipes stdin instead of /dev/null.
   *
   * As a single string, the whole payload is written and stdin is
   * closed immediately. That works for commands that use a single
   * readline interface, but fails for `auth update` / `auth clear` /
   * `session stream` which open a fresh readline per prompt: once the
   * stream ends, the first readline's flowing-mode reader eats all
   * remaining bytes before the next interface can see them.
   *
   * Pass an array of chunks to insert a delay between prompts — the
   * helper writes each chunk, waits `chunkDelayMs`, then writes the
   * next. That gives each close()→createInterface() cycle time to hand
   * off the stream. Stdin is closed after the final chunk.
   */
  stdin?: string | string[]
  /**
   * Delay between chunks when `stdin` is an array. Default 1500 ms.
   * Needs to be long enough that the CLI has closed one readline
   * interface and opened the next before the chunk arrives, including
   * daemon-RPC round-trips and parallel-test-worker jitter.
   *
   * Prefer `stdinOnPrompt` for multi-prompt flows — a fixed delay races
   * the readline handoff under CPU load (observed flaking whenever tsc
   * or another suite ran concurrently).
   */
  chunkDelayMs?: number
  /**
   * Prompt-driven stdin: write each `send` only once its `when` pattern
   * appears in stdout past the previous match. Deterministic replacement
   * for the timer-based array mode: `rl.question` prints the prompt from
   * the SAME readline interface that consumes the answer, so seeing the
   * prompt guarantees a listener is attached — no handoff race at any
   * load. Stdin is closed after the final send.
   */
  stdinOnPrompt?: Array<{ when: RegExp; send: string }>
}

/**
 * Spawn a `yaac <args>` CLI subprocess with the given env, capture
 * stdout/stderr, and resolve once it exits. The caller is responsible
 * for starting a daemon first (via `spawnYaacDaemon`) unless the
 * command under test is itself a daemon-lifecycle command.
 */
export async function runYaac(
  env: NodeJS.ProcessEnv,
  ...argsWithOpts: (string | RunYaacOptions)[]
): Promise<RunYaacResult> {
  const last = argsWithOpts[argsWithOpts.length - 1]
  const opts: RunYaacOptions =
    typeof last === 'object' && last !== null ? (argsWithOpts.pop() as RunYaacOptions) : {}
  const args = argsWithOpts as string[]

  const wantsStdin = opts.stdin !== undefined || opts.stdinOnPrompt !== undefined
  const child = spawn(process.execPath, [TSX_CLI, ENTRY, ...args], {
    env,
    stdio: [wantsStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  })
  if (opts.stdin !== undefined && child.stdin) {
    const delay = opts.chunkDelayMs ?? 1500
    if (Array.isArray(opts.stdin)) {
      void (async () => {
        for (let i = 0; i < opts.stdin!.length; i++) {
          if (i > 0) await new Promise((r) => setTimeout(r, delay))
          child.stdin!.write(opts.stdin![i])
        }
        child.stdin!.end()
      })()
    } else {
      child.stdin.end(opts.stdin)
    }
  }
  let stdout = ''
  let stderr = ''
  // Prompt-driven stdin (see RunYaacOptions.stdinOnPrompt): scan stdout
  // forward, one step at a time, writing each answer only after its prompt
  // has been printed by the readline that will consume it.
  let promptIdx = 0
  let promptScanFrom = 0
  const feedPrompts = (): void => {
    const steps = opts.stdinOnPrompt
    if (!steps || !child.stdin) return
    while (promptIdx < steps.length) {
      const m = steps[promptIdx].when.exec(stdout.slice(promptScanFrom))
      if (!m) return
      promptScanFrom += m.index + m[0].length
      child.stdin.write(steps[promptIdx].send)
      promptIdx += 1
      if (promptIdx === steps.length) child.stdin.end()
    }
  }
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
    feedPrompts()
  })
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const exitCode = await new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code))
  })
  return { stdout, stderr, exitCode }
}
