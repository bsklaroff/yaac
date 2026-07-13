/**
 * Spawning the yaac CLI from a GUI process. The one wrinkle vs the
 * terminal is PATH: an app launched from Finder (or a desktop launcher)
 * inherits the OS's minimal PATH, not the login shell's. Two spawn shapes:
 *
 *  - dev (`yaac` from PATH): self-healing — try as-is, and only on ENOENT
 *    resolve the login shell's PATH and retry once.
 *  - packaged (bundled node + cli.js under Resources): the bin is absolute so
 *    there is no ENOENT to self-heal on — instead the login-shell PATH is
 *    resolved up front and handed to the child, because the child needs it
 *    to find its own tools (kubectl/podman/tmux for the server,
 *    claude/codex/npm/brew for the auth daemon) from a Finder launch.
 */
import { execFile, spawn } from 'node:child_process'
import path from 'node:path'
import type { ServerTarget } from '@yaac/shared/server-client'
import { ensureAuthDaemonSpawned } from '@yaac/shared/auth-daemon'

export interface RunResult {
  code: number | null
  stderr: string
}

/** How to invoke the yaac CLI. */
export interface YaacCommand {
  bin: string
  args: string[]
}

export type SpawnImpl = typeof spawn

/**
 * The yaac CLI invocation for this install shape. Dev/unpackaged
 * (`resourcesPath` null) spawns `yaac` from PATH; packaged runs the bundled
 * standalone Node against the staged CLI. The bundled pair works detached
 * too: the daemons' own relaunches use process.execPath + argv[1], i.e. the
 * same bundled node + cli.js.
 */
export function resolveYaacCommand(resourcesPath: string | null, args: string[]): YaacCommand {
  if (resourcesPath === null) return { bin: 'yaac', args }
  return {
    bin: path.join(resourcesPath, 'node', 'node'),
    args: [path.join(resourcesPath, 'server', 'dist', 'cli.js'), ...args],
  }
}

/**
 * Resolve the user's login-shell PATH. Best-effort: null when the shell
 * can't be run or prints nothing (callers keep the inherited PATH).
 */
export function loginShellPath(execImpl: typeof execFile = execFile): Promise<string | null> {
  return new Promise((resolve) => {
    // eslint-disable-next-line no-process-env -- SHELL is the OS login shell, not yaac config
    const shell = process.env.SHELL ?? '/bin/sh'
    execImpl(shell, ['-lic', 'printf %s "$PATH"'], { timeout: 5000 }, (err, stdout) => {
      resolve(err || !stdout.trim() ? null : stdout.trim())
    })
  })
}

function run(spawnImpl: SpawnImpl, cmd: YaacCommand, path: string | undefined): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(cmd.bin, cmd.args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      // eslint-disable-next-line no-process-env -- forwarded wholesale to the child, not yaac config
      env: path === undefined ? undefined : { ...process.env, PATH: path },
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stderr: stderr.trim() }))
  })
}

/**
 * Run `yaac server start` to completion (it exits once the detached server
 * daemon is up and healthy). Rejects only when the binary can't be spawned
 * — yaac isn't installed or isn't on any resolvable PATH.
 */
export async function runYaacServerStart(
  cmd: YaacCommand = resolveYaacCommand(null, ['server', 'start']),
  opts: {
    /** Resolve the login-shell PATH up front (packaged; see module doc). */
    hydratePath?: boolean
    spawnImpl?: SpawnImpl
    resolvePath?: () => Promise<string | null>
  } = {},
): Promise<RunResult> {
  const spawnImpl = opts.spawnImpl ?? spawn
  const resolvePath = opts.resolvePath ?? loginShellPath
  if (opts.hydratePath) {
    return run(spawnImpl, cmd, await resolvePath() ?? undefined)
  }
  try {
    return await run(spawnImpl, cmd, undefined)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    const path = await resolvePath()
    if (!path) throw err
    return run(spawnImpl, cmd, path)
  }
}

/**
 * Ensure the machine-local auth daemon (login broker) runs against `target`,
 * with the invocation and (packaged) login-shell PATH this install shape
 * needs — the daemon's vendor-CLI children (claude/codex/npm/brew) inherit
 * that PATH transitively. Throws on spawn failure; the flow swallows it
 * (best-effort — the SPA's sign-in cards say what to run by hand). No dev
 * ENOENT self-heal like `runYaacServerStart`: dev launches come from a
 * terminal where `yaac` is on PATH.
 */
export async function ensureAuthDaemonRunning(opts: {
  /** The flow's requireBuildMatch:false target (the shell has no build id). */
  target: ServerTarget
  /** resolveYaacCommand(resourcesPath, ['auth', 'server', 'run']). */
  command: YaacCommand
  /** Resolve the login-shell PATH up front (packaged; see module doc). */
  hydratePath?: boolean
  resolvePath?: () => Promise<string | null>
  ensureImpl?: typeof ensureAuthDaemonSpawned
}): Promise<void> {
  const path = opts.hydratePath ? await (opts.resolvePath ?? loginShellPath)() : null
  await (opts.ensureImpl ?? ensureAuthDaemonSpawned)({
    target: opts.target,
    invocation: opts.command,
    // eslint-disable-next-line no-process-env -- forwarded wholesale to the daemon, not yaac config
    env: path === null ? undefined : { ...process.env, PATH: path },
  })
}
