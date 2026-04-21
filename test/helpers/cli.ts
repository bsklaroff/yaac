import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setDataDir } from '@/shared/paths'
import { readLock, type DaemonLock } from '@/shared/lock'
import { TEST_RUN_ID } from '@test/helpers/setup'

const TSX_CLI = path.resolve(__dirname, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')
const ENTRY = path.resolve(__dirname, '..', '..', 'src', 'cli.ts')

export interface YaacTestEnv {
  scratchDir: string
  dataDir: string
  gitConfigPath: string
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
 * land on pre-built images and a worker-isolated proxy network;
 * tests that do not touch containers just ignore them.
 */
export async function createYaacTestEnv(): Promise<YaacTestEnv> {
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-e2ecli-'))
  const dataDir = path.join(scratchDir, 'data')
  const gitConfigPath = path.join(scratchDir, 'gitconfig')
  await fs.mkdir(path.join(dataDir, 'projects'), { recursive: true })
  await fs.writeFile(gitConfigPath, '')
  setDataDir(dataDir)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    YAAC_DATA_DIR: dataDir,
    GIT_CONFIG_GLOBAL: gitConfigPath,
    YAAC_BUILD_ID: 'test-build-id',
    YAAC_IMAGE_PREFIX: 'yaac-test',
    YAAC_PROXY_IMAGE: 'yaac-test-proxy',
    YAAC_PROXY_NETWORK: `yaac-test-sessions-${TEST_RUN_ID}`,
    YAAC_REQUIRE_PREBUILT_IMAGES: '1',
  }

  const cleanup = async (): Promise<void> => {
    await fs.rm(scratchDir, { recursive: true, force: true })
  }

  return { scratchDir, dataDir, gitConfigPath, env, cleanup }
}

export interface SpawnedDaemon {
  child: ChildProcess
  lock: DaemonLock
  stop: () => Promise<void>
}

/**
 * Spawn a real `yaac daemon run` subprocess under the given env. Polls
 * for the lock file (5s budget) so the caller can read `.lock.port`
 * without races. `stop()` SIGTERMs, falling back to SIGKILL after 3s.
 */
export async function spawnYaacDaemon(env: NodeJS.ProcessEnv): Promise<SpawnedDaemon> {
  const child = spawn(process.execPath, [TSX_CLI, ENTRY, 'daemon', 'run', '--port', '0'], {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  // Forward daemon stderr to the test worker's stderr when the debug
  // flag is set — invaluable when a daemon subprocess dies before the
  // CLI can observe a coherent error.
  if (process.env.YAAC_TEST_DEBUG_DAEMON === '1') {
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[daemon] ${chunk.toString()}`)
    })
  }

  const lock = await waitForLock(5000)

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null) return
    child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      // Give the daemon up to 15s to finish its current background-loop
      // tick (prewarm upkeep, blocked-host persist) before we force-kill.
      // SIGKILL bypasses the shutdown handler's `removeLock()` call, so a
      // too-short timeout leaves stale lock files and flakes tests that
      // assert on lock cleanup.
      const t = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 15000)
      child.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
    })
  }

  return { child, lock, stop }
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
   */
  chunkDelayMs?: number
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

  const stdinMode: 'pipe' | 'ignore' = opts.stdin !== undefined ? 'pipe' : 'ignore'
  const child = spawn(process.execPath, [TSX_CLI, ENTRY, ...args], {
    env,
    stdio: [stdinMode, 'pipe', 'pipe'],
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
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const exitCode = await new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code))
  })
  return { stdout, stderr, exitCode }
}
