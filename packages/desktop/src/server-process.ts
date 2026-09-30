/**
 * Spawns the yaac CLI from the GUI process, used only to start the
 * machine-local auth daemon (the login broker). The shell never starts a
 * server.
 *
 * An app launched from Finder inherits the OS's minimal PATH, not the login
 * shell's. The packaged app therefore resolves the login-shell PATH and hands
 * it to the daemon, whose children (claude/codex/npm/brew) need it.
 */
import { execFile } from 'node:child_process'
import path from 'node:path'
import type { ServerTarget } from '@yaac/shared/server-api'
import { ensureAuthDaemonSpawned } from '@yaac/shared/auth-daemon'

/** How to invoke the yaac CLI. */
export interface YaacCommand {
  bin: string
  args: string[]
}

/**
 * The yaac CLI invocation for this install. Unpackaged (`resourcesPath`
 * null) runs `yaac` from PATH; packaged runs the bundled Node against the
 * staged cli.js.
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

/**
 * Ensure the machine-local auth daemon runs against `target`, with the
 * login-shell PATH when `hydratePath` is set. Throws on spawn failure; the
 * boot flow ignores that, since the SPA's sign-in cards say what to run.
 */
export async function ensureAuthDaemonRunning(opts: {
  /** The resolved server target the daemon should broker for. */
  target: ServerTarget
  /** resolveYaacCommand(resourcesPath, ['auth', 'server', 'run']). */
  command: YaacCommand
  /** Resolve the login-shell PATH first (packaged app; see module doc). */
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
