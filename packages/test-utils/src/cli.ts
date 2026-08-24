import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setDataDir, findRepoRoot } from '@yaac/shared/paths'
import { readLock } from '@yaac/shared/lock'
import { isLockReady, type ServerLock } from '@yaac/shared/server-lock-file'
import { TEST_NAMESPACE } from '#setup'
import { e2eMkdtemp, removeScratchTree } from '#tmp'

const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)))

/**
 * The suite's own copy of the built CLI, taken from dist/ by
 * `buildCliBundle` (test/global-setup.ts) before any worker starts.
 *
 * A copy rather than dist/ itself because `pnpm watch` builds into dist/ on
 * every save, with `clean: true` — a save landing mid-run would otherwise
 * delete the binary these suites are spawning. Snapshotting once per run
 * decouples them: the watcher can rebuild dist/ as often as it likes and an
 * in-flight run keeps the bundle it started with. 7MB, so the copy costs
 * nothing next to what it buys.
 */
export const TEST_CLI_DIR = path.join(REPO_ROOT, 'dist-test')

/**
 * The built CLI, not `packages/cli/src/cli.ts` under tsx — every
 * `runYaac`/`spawnYaacServer` here is a fresh process, and tsx re-transpiles
 * the whole graph in each one: 1.3s for a CLI command, 16.4s for a server to
 * report ready, against 0.36s and 5.4s from the bundle. Across the suite's
 * ~160 CLI spawns and ~17 server spawns that is minutes per run.
 *
 * Rebuilt from source before every run, so this can never test a stale
 * bundle. It also means these suites exercise the artifact users actually
 * run — including its bundled-mode paths, where PACKAGE_ROOT is the
 * directory holding cli.js and the migrations, k8s manifests, builtin skills
 * and worktree-bin scripts are read from the copies beside it. That is why
 * the snapshot is the whole of dist/ and not just cli.js.
 */
export const TEST_CLI_ENTRY = path.join(TEST_CLI_DIR, 'cli.js')

/** Local alias — every spawn below runs `node TEST_CLI_ENTRY <args>`. */
const ENTRY = TEST_CLI_ENTRY

/**
 * Cross-worker mutex so only one `yaac server run` is live at a time
 * across all vitest workers. Multiple servers hammering the shared
 * cluster API server and the podman build engine concurrently starves
 * both, so server-backed suites serialize on this lock.
 *
 * Lock file holds the owner's PID so a crashed holder doesn't wedge
 * the suite forever. fs.open(wx) is atomic across processes.
 */
const SERVER_LOCK_FILE = path.join(os.tmpdir(), 'yaac-test-server-mutex.lock')

/**
 * Base for the per-worker server port set via `YAAC_SERVER_PORT`. Chosen well
 * clear of the real default (DEFAULT_SERVER_PORT = 8787) so the fixed-port
 * `server start`/`restart` suites never collide with a developer's own server
 * on 8787. `spawnYaacServer` passes `--port 0` and ignores this; only suites
 * that bind the default port (no `--port`) observe it.
 */
const TEST_SERVER_PORT_BASE = 18800

// Process-reentrant: if this worker already owns the file lock, a
// nested acquire just bumps a refcount. The file lock is only released
// when the refcount drops back to zero. Prevents a file-level mutex
// (e.g. server.test.ts's beforeAll) from deadlocking against per-test
// spawnYaacServer acquires in the same worker.
let localDepth = 0
let pendingFileUnlink: Promise<void> | null = null

export async function acquireServerMutex(): Promise<() => Promise<void>> {
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
      const fh = await fs.open(SERVER_LOCK_FILE, 'wx')
      await fh.writeFile(String(process.pid))
      await fh.close()
      localDepth = 1
      let released = false
      return async (): Promise<void> => {
        if (released) return
        released = true
        localDepth -= 1
        if (localDepth === 0) {
          pendingFileUnlink = fs.unlink(SERVER_LOCK_FILE).catch(() => { /* already gone */ })
          await pendingFileUnlink
          pendingFileUnlink = null
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // Existing lock — check if the holder is still alive.
      try {
        const raw = await fs.readFile(SERVER_LOCK_FILE, 'utf8')
        const holderPid = parseInt(raw.trim(), 10)
        if (!Number.isNaN(holderPid)) {
          try {
            process.kill(holderPid, 0)
          } catch {
            // Holder is gone — steal the lock.
            await fs.unlink(SERVER_LOCK_FILE).catch(() => { /* raced */ })
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
  /** Port the server binds when started without `--port` (via YAAC_SERVER_PORT). */
  serverPort: number
  env: NodeJS.ProcessEnv
  cleanup: () => Promise<void>
}

/**
 * Per-test isolation. We use `YAAC_DATA_DIR` (server) + `setDataDir()`
 * (test process) to redirect the yaac data dir, rather than
 * overriding HOME — overriding HOME breaks podman, which reads its
 * config from `$HOME/.config/containers/`. `GIT_CONFIG_GLOBAL`
 * redirects git's global config for the same reason: tests that need
 * a user identity write to `gitConfigPath` and leave the real
 * `~/.gitconfig` untouched.
 *
 * Test-only server hooks are preset here so container-backed tests
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
  // assertions (listWorktreePods, containerExec, ...) hit the same
  // namespace as the server subprocess.
  process.env.YAAC_K8S_NAMESPACE = TEST_NAMESPACE

  // Per-worker default port so a fixed-port `server start`/`restart` server
  // lands clear of 8787 — both another worker's server and any real server
  // a developer is running locally.
  const workerId = Number.parseInt(process.env.VITEST_WORKER_ID ?? '1', 10)
  const serverPort = TEST_SERVER_PORT_BASE + (Number.isNaN(workerId) ? 0 : workerId)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    YAAC_DATA_DIR: dataDir,
    // Spelled out rather than left to the spread. A spawned server is a fresh
    // process that loads none of the suite's setup files, so this flag is the
    // only thing standing between it and a real refresh grant — and a grant
    // from behind a worktree's proxy rotates the hosting install's live
    // credential whatever token the request carried (see vitest-setup). Too
    // load-bearing to depend on an ambient var being present.
    YAAC_E2E_NO_TOKEN_REFRESH: '1',
    GIT_CONFIG_GLOBAL: gitConfigPath,
    YAAC_SERVER_PORT: String(serverPort),
    YAAC_BUILD_ID: 'test-build-id',
    YAAC_IMAGE_PREFIX: 'yaac-test',
    YAAC_PROXY_IMAGE: 'yaac-test-proxy',
    YAAC_NETD_IMAGE: 'yaac-test-netd',
    YAAC_K8S_NAMESPACE: TEST_NAMESPACE,
    YAAC_REQUIRE_PREBUILT_IMAGES: '1',
    // Prewarming is on by default in production, but a background pool that
    // spawns spares under every e2e suite would burn
    // cluster resources and perturb assertions. Off by default; the dedicated
    // prewarm suite re-enables it with `{ ...env, YAAC_PREWARM_POOL_SIZE: '1' }`.
    YAAC_PREWARM_POOL_SIZE: '0',
    // Same reasoning for the background image-prewarm sweep — e2e images are
    // prebuilt by the global setup and workers must never race a podman build.
    YAAC_IMAGE_PREWARM: '0',
    // Auto-titling would pull the llama.cpp binary + a ~114MB model under
    // every e2e server (and retitle worktrees mid-assertion); the feature is
    // unit-tested with a stubbed runner instead.
    YAAC_AUTO_TITLES: '0',
    // Keep the credential gate on for spawned servers. A loopback server is
    // credential-optional by default, but e2e/api suites assert the
    // authenticated behavior (the CLI authenticates with the lock secret),
    // so spawned servers stay auth-on exactly as in production remote use.
    YAAC_REQUIRE_AUTH: '1',
  }

  const cleanup = async (): Promise<void> => {
    // Reap any auth server a test (or `yaac open`/`auth update`) spawned
    // against this data dir — it reconnects forever and would leak.
    try {
      const raw = await fs.readFile(path.join(dataDir, '.auth-daemon.lock'), 'utf8')
      const lock = JSON.parse(raw) as { pid?: number }
      if (typeof lock.pid === 'number') process.kill(lock.pid, 'SIGTERM')
    } catch {
      // no auth server ran, or it's already gone
    }
    // removeScratchTree retries the teardown RACE — `force` swallows a
    // missing path but not ENOTEMPTY, and the scratch dir is still live when
    // this runs. A worktree's worktree is hostPath-mounted into its pod as
    // /workspace, so a container that has not finished terminating can create
    // a file in a directory the walk just emptied; the detached teardown
    // script (cleanupWorktreeDetached) outlives the server it was spawned from
    // and is deleting under the same tree. Both settle in well under a second.
    //
    // What it does NOT retry is a root-owned leftover, which no amount of
    // waiting fixes — those come back as paths for us to report.
    const stuck = await removeScratchTree(scratchDir)
    if (stuck.length > 0) {
      console.warn(
        `[yaac-test] left ${stuck.length} root-owned path(s) behind under `
        + `${scratchDir}; clearing them needs root:\n  ${stuck.join('\n  ')}`,
      )
    }
  }

  return { scratchDir, dataDir, gitConfigPath, serverPort, env, cleanup }
}

export interface SpawnedServer {
  child: ChildProcess
  lock: ServerLock
  stop: () => Promise<void>
}

/**
 * Spawn a real `yaac server run` subprocess under the given env. Polls
 * for the lock file (5s budget) so the caller can read `.lock.port`
 * without races. The server leads its own process group; `stop()`
 * SIGTERMs that group, falling back to a group SIGKILL after 15s so the
 * server's forked children are reaped rather than orphaned.
 *
 * Acquires the cross-worker server mutex before spawning so only one
 * yaac server exists across all parallel vitest workers at any time.
 * `stop()` releases it after the child has exited.
 */
export async function spawnYaacServer(env: NodeJS.ProcessEnv): Promise<SpawnedServer> {
  const releaseMutex = await acquireServerMutex()
  let mutexReleased = false
  const releaseOnce = async (): Promise<void> => {
    if (mutexReleased) return
    mutexReleased = true
    await releaseMutex()
  }

  const child = spawn(process.execPath, [ENTRY, 'server', 'run', '--port', '0'], {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
    // Make the server its own process-group leader (setsid) so `stop()`
    // can signal the whole group. The server forks long-lived children
    // (`kubectl port-forward`/`exec` relays) that inherit this pgid; a
    // group kill reaps them even on the SIGKILL path, instead of leaving
    // them orphaned to accumulate across the serialized e2e files until
    // the cgroup pid ceiling is hit and `fork()` starts returning EAGAIN.
    detached: true,
  })

  // Forward server stderr to the test worker's stderr when the debug
  // flag is set — invaluable when a server subprocess dies before the
  // CLI can observe a coherent error.
  if (process.env.YAAC_TEST_DEBUG_SERVER === '1') {
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[server] ${chunk.toString()}`)
    })
  }

  let lock: ServerLock
  try {
    // A cold `server run` needs ~12s to report ready on an idle machine (tsx
    // transpiles the dependency tree, then PGlite opens and runs first-boot
    // migrations against the fresh per-test data dir). 60s keeps a healthy
    // server inside the budget under the memory/CPU pressure of a full
    // parallel run, where 30s left too little headroom and timed out.
    lock = await waitForLock(60_000)
  } catch (err) {
    // Reap the spawned server before rethrowing. Without this, a readiness
    // timeout leaves the child (and its process group) running: it never
    // wrote a usable lock, no `stop()` is returned to the caller, and the
    // orphaned servers pile up across the serialized suites until the box
    // runs out of memory.
    killGroup(child, 'SIGKILL')
    await releaseOnce()
    throw err
  }

  const stop = async (): Promise<void> => {
    try {
      if (child.exitCode === null) {
        // SIGTERM the whole group: the server runs its shutdown handler
        // (which calls `removeLock()`, so lock-cleanup assertions stay
        // green), and its `kubectl port-forward`/`exec` children get the
        // signal directly rather than waiting on the server to tear them
        // down.
        killGroup(child, 'SIGTERM')
        await new Promise<void>((resolve) => {
          // Give the server up to 15s to finish its current background-loop
          // tick (worktree reconcile, blocked-host persist) before we
          // force-kill. SIGKILL bypasses the shutdown handler's
          // `removeLock()` call, so a too-short timeout leaves stale lock
          // files and flakes tests that assert on lock cleanup.
          const t = setTimeout(() => {
            // SIGKILL the group, not just the server: a force-killed server
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
 * Signal a server's entire process group (negative PID). The server is
 * spawned `detached`, so it leads its own group and a group-directed
 * signal reaches every child it forked. Falls back to signalling just the
 * server if the group is already gone (ESRCH) or the PID is unknown.
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

async function waitForLock(timeoutMs: number): Promise<ServerLock> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const lock = await readLock()
    // Wait for genuine readiness (`/health` reports ready), not just the
    // lock file: the port binds and the lock is written before the server
    // opens its DB and mints the start-banner one-time token, so a caller
    // that proceeds on the bare lock races those startup steps. Mirrors the
    // real `yaac server start`, which waits on `isLockReady` for the same
    // reason.
    if (lock && await isLockReady(lock)) return lock
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('server did not become ready within timeout')
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
   * `worktree stream` which open a fresh readline per prompt: once the
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
   * server-RPC round-trips and parallel-test-worker jitter.
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
 * for starting a server first (via `spawnYaacServer`) unless the
 * command under test is itself a server-lifecycle command.
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
  const child = spawn(process.execPath, [ENTRY, ...args], {
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
