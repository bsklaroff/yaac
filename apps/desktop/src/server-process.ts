/**
 * Spawning `yaac server start` from a GUI process. The one wrinkle vs the
 * terminal is PATH: an app launched from Finder (or a desktop launcher)
 * inherits the OS's minimal PATH, not the login shell's, so `yaac` from a
 * Homebrew/nvm install won't resolve. Rather than guess at launch context,
 * spawning is self-healing: try as-is, and only on ENOENT resolve the login
 * shell's PATH and retry once.
 */
import { execFile, spawn } from 'node:child_process'

export interface RunResult {
  code: number | null
  stderr: string
}

export type SpawnImpl = typeof spawn

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

function run(spawnImpl: SpawnImpl, path: string | undefined): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl('yaac', ['server', 'start'], {
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
  spawnImpl: SpawnImpl = spawn,
  resolvePath: () => Promise<string | null> = loginShellPath,
): Promise<RunResult> {
  try {
    return await run(spawnImpl, undefined)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    const path = await resolvePath()
    if (!path) throw err
    return run(spawnImpl, path)
  }
}
