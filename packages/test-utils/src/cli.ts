import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ensureDataDir, setDataDir } from '@yaac/shared/paths'
import { registerServer } from '@yaac/shared/server-config'
import { readLock } from '@yaac/shared/lock'
import { isLockReady, type ServerLock } from '@yaac/shared/server-lock-file'
import { TEST_NAMESPACE } from '#setup'
import { deployTestServer } from '#deployed-server'
import { TEST_CLI_DIR, TEST_CLI_ENTRY } from '#cli-bundle'
import { e2eMkdtemp, removeScratchTree, testTmpBase } from '#tmp'
import { freeLocalPort } from '#kubectl-forward'

export { TEST_CLI_DIR, TEST_CLI_ENTRY }

/** Local alias — every spawn below runs `node TEST_CLI_ENTRY <args>`. */
const ENTRY = TEST_CLI_ENTRY

/**
 * Cross-worker mutex so only one test server runs at a time; concurrent
 * servers starve the shared cluster API server. Scoped to the test scratch
 * base (one per test rig and cluster), not the host, so separate rigs don't
 * wait on each other.
 *
 * The lock file holds the owner's pid, so a crashed holder's lock can be
 * taken over. fs.open(wx) is atomic across processes.
 */
function serverLockFile(): string {
  return path.join(testTmpBase(), 'server-mutex.lock')
}

// Reentrant within a process: a nested acquire bumps a refcount, and the
// file lock is released when it drops to zero, so a file-level hold can't
// deadlock against a per-test acquire in the same worker.
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

  const lockFile = serverLockFile()
  await fs.mkdir(path.dirname(lockFile), { recursive: true })
  for (;;) {
    try {
      const fh = await fs.open(lockFile, 'wx')
      await fh.writeFile(String(process.pid))
      await fh.close()
      localDepth = 1
      let released = false
      return async (): Promise<void> => {
        if (released) return
        released = true
        localDepth -= 1
        if (localDepth === 0) {
          pendingFileUnlink = fs.unlink(lockFile).catch(() => { /* already gone */ })
          await pendingFileUnlink
          pendingFileUnlink = null
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // Existing lock — check if the holder is still alive.
      try {
        const raw = await fs.readFile(lockFile, 'utf8')
        const holderPid = parseInt(raw.trim(), 10)
        if (!Number.isNaN(holderPid)) {
          try {
            process.kill(holderPid, 0)
          } catch {
            // Holder is gone — steal the lock.
            await fs.unlink(lockFile).catch(() => { /* raced */ })
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
  /** Port the server binds when started without `--port` (via YAAC_SERVER_PORT). */
  serverPort: number
  env: NodeJS.ProcessEnv
  cleanup: () => Promise<void>
}

/**
 * An isolated test environment. The data dir is redirected with
 * `YAAC_DATA_DIR` and `setDataDir()` rather than by overriding HOME, which
 * would break podman's config lookup. `GIT_CONFIG_GLOBAL` keeps spawned
 * processes off the real `~/.gitconfig`.
 *
 * Also presets the test-only server settings: prebuilt images and the
 * file's k8s namespace.
 */
export async function createYaacTestEnv(): Promise<YaacTestEnv> {
  const scratchDir = await e2eMkdtemp('yaac-e2ecli-')
  const dataDir = path.join(scratchDir, 'data')
  const gitConfigPath = path.join(scratchDir, 'gitconfig')
  await fs.writeFile(gitConfigPath, '')
  setDataDir(dataDir)
  await ensureDataDir()
  // So helpers used by assertions hit the server's namespace.
  process.env.YAAC_K8S_NAMESPACE = TEST_NAMESPACE

  // The port `server start`/`restart` binds (under k8s, the forward's
  // port). Drawn free so workers and rigs never collide.
  const serverPort = await freeLocalPort()

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    YAAC_DATA_DIR: dataDir,
    // Set explicitly: a spawned server loads no setup files, and a refresh
    // grant could rotate the hosting install's credential (see
    // vitest-setup).
    YAAC_E2E_NO_TOKEN_REFRESH: '1',
    GIT_CONFIG_GLOBAL: gitConfigPath,
    YAAC_SERVER_PORT: String(serverPort),
    YAAC_BUILD_ID: 'test-build-id',
    YAAC_IMAGE_PREFIX: 'yaac-test',
    YAAC_PROXY_IMAGE: 'yaac-test-proxy',
    YAAC_NETD_IMAGE: 'yaac-test-netd',
    YAAC_K8S_NAMESPACE: TEST_NAMESPACE,
    YAAC_REQUIRE_PREBUILT_IMAGES: '1',
    // A spare pool would waste cluster resources and disturb assertions.
    // The prewarm suite turns it back on.
    YAAC_PREWARM_POOL_SIZE: '0',
    // Images are prebuilt by the global setup; workers must never build.
    YAAC_IMAGE_PREWARM: '0',
    // Auto-titling would download a model and retitle workspaces
    // mid-assertion; it is unit-tested instead.
    YAAC_AUTO_TITLES: '0',
  }

  const cleanup = async (): Promise<void> => {
    // Reap any auth server spawned against this data dir; it would
    // reconnect forever.
    try {
      const raw = await fs.readFile(path.join(dataDir, '.auth-daemon.lock'), 'utf8')
      const lock = JSON.parse(raw) as { pid?: number }
      if (typeof lock.pid === 'number') process.kill(lock.pid, 'SIGTERM')
    } catch {
      // no auth server ran, or it's already gone
    }
    // A terminating pod or the detached teardown script may still be
    // writing here; removeScratchTree retries that and returns root-owned
    // leftovers.
    const stuck = await removeScratchTree(scratchDir)
    if (stuck.length > 0) {
      console.warn(
        `[yaac-test] left ${stuck.length} root-owned path(s) behind under `
        + `${scratchDir}; clearing them needs root:\n  ${stuck.join('\n  ')}`,
      )
    }
  }

  return { scratchDir, dataDir, serverPort, env, cleanup }
}

export interface SpawnedServer {
  lock: ServerLock
  stop: () => Promise<void>
}

/**
 * Give this test file a yaac server, and hand back the two things a file
 * needs from one: a lock naming a loopback origin it can dial, and a way to
 * stop it.
 *
 * The kind of server follows the driver, as in production
 * (docs/server-in-cluster.md): under containerless a host process, under
 * k8s a Deployment in the file's test namespace reached through a local
 * port-forward (`#deployed-server`).
 *
 * Holds the cross-worker server mutex until `stop()` has finished.
 */
export async function spawnYaacServer(env: NodeJS.ProcessEnv): Promise<SpawnedServer> {
  const releaseMutex = await acquireServerMutex()
  let mutexReleased = false
  const releaseOnce = async (): Promise<void> => {
    if (mutexReleased) return
    mutexReleased = true
    await releaseMutex()
  }

  let server: SpawnedServer
  try {
    server = env.YAAC_DRIVER === 'containerless'
      ? await spawnHostServer(env)
      : await deployTestServer({ env })
  } catch (err) {
    await releaseOnce()
    throw err
  }

  return {
    lock: server.lock,
    stop: async (): Promise<void> => {
      try {
        await server.stop()
      } finally {
        await releaseOnce()
      }
    },
  }
}

/**
 * Spawn a `yaac server run` subprocess and wait (up to 60s) until it is
 * ready. The server leads its own process group, so `stop()` can signal it
 * and every child it forked: SIGTERM, then SIGKILL after 15s. Orphaned
 * children would otherwise pile up across e2e files until fork() fails.
 */
async function spawnHostServer(env: NodeJS.ProcessEnv): Promise<SpawnedServer> {
  const child = spawn(process.execPath, [ENTRY, 'server', 'run', '--port', '0'], {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  })

  // Useful when the server dies before the CLI can report a clear error.
  if (process.env.YAAC_TEST_DEBUG_SERVER === '1') {
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[server] ${chunk.toString()}`)
    })
  }

  let lock: ServerLock
  try {
    // A cold start takes ~12s when idle; 60s leaves room under the load of
    // a full parallel run.
    lock = await waitForLock(60_000)
  } catch (err) {
    // No `stop()` reaches the caller, so reap the server here.
    killGroup(child, 'SIGKILL')
    throw err
  }

  // `yaac server run` doesn't register itself, so do what `yaac server
  // start` would: point this worker's clients at the new server.
  try {
    await registerServer(`http://127.0.0.1:${lock.port}`, 'containerless')
  } catch (err) {
    killGroup(child, 'SIGKILL')
    throw err
  }

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null) return
    // SIGTERM lets the server's shutdown handler remove its lock.
    killGroup(child, 'SIGTERM')
    await new Promise<void>((resolve) => {
      // 15s for the current background tick to finish; SIGKILL skips
      // the lock removal that some tests assert on.
      const t = setTimeout(() => {
        killGroup(child, 'SIGKILL')
        resolve()
      }, 15000)
      child.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
    })
  }

  return { lock, stop }
}

/**
 * Signal a server's whole process group, falling back to the server alone
 * if the group is gone.
 */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, signal)
  } catch {
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
    // Wait for `/health` to report ready, as `yaac server start` does: the
    // lock is written before the server opens its DB.
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
   * Data to write to stdin (otherwise /dev/null), then close it.
   *
   * A single string suits commands with one readline interface. Commands
   * that open a readline per prompt (`auth update`, `auth clear`) would
   * lose later answers to the first reader, so pass an array: each chunk is
   * written `chunkDelayMs` after the last. Prefer `stdinOnPrompt`.
   */
  stdin?: string | string[]
  /**
   * Delay between chunks when `stdin` is an array. Default 1500 ms. Races
   * under CPU load; prefer `stdinOnPrompt`.
   */
  chunkDelayMs?: number
  /**
   * Write each `send` once its `when` pattern appears in stdout after the
   * previous match. The prompt is printed by the readline that will read
   * the answer, so there is no race. Stdin closes after the last send.
   */
  stdinOnPrompt?: Array<{ when: RegExp; send: string }>
}

/**
 * Run `yaac <args>` with the given env and resolve with its output once it
 * exits. Start a server first (`spawnYaacServer`) unless the command
 * manages the server itself.
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

/**
 * Give a spawned server the git identity a create refuses without, through
 * the CLI command a user runs (`yaac config git-identity`).
 */
export async function setTestGitIdentity(env: NodeJS.ProcessEnv): Promise<void> {
  const { exitCode, stderr } = await runYaac(
    env, 'config', 'git-identity', '--name', 'Test User', '--email', 'test@example.com',
  )
  if (exitCode !== 0) throw new Error(`yaac config git-identity failed: ${stderr}`)
}
