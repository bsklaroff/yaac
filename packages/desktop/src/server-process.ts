/**
 * Spawning the yaac CLI from a GUI process — which the shell does for
 * exactly one thing: the machine-local auth daemon (the login broker). It
 * never spawns a SERVER; every server is reached through `server.json`,
 * and starting one is `yaac server start`'s job.
 *
 * The one wrinkle vs the terminal is PATH: an app launched from Finder (or
 * a desktop launcher) inherits the OS's minimal PATH, not the login
 * shell's. Packaged, the bin is absolute (bundled node + cli.js under
 * Resources), so the login-shell PATH is resolved up front and handed to
 * the child — the daemon's vendor-CLI children (claude/codex/npm/brew)
 * need it from a Finder launch.
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
 * The yaac CLI invocation for this install shape. Dev/unpackaged
 * (`resourcesPath` null) runs `yaac` from PATH; packaged runs the bundled
 * standalone Node against the staged CLI. The bundled pair works detached
 * too: the daemon's own relaunches use process.execPath + argv[1], i.e. the
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

/**
 * Ensure the machine-local auth daemon (login broker) runs against `target`,
 * with the invocation and (packaged) login-shell PATH this install shape
 * needs — the daemon's vendor-CLI children (claude/codex/npm/brew) inherit
 * that PATH transitively. Throws on spawn failure; the flow swallows it
 * (best-effort — the SPA's sign-in cards say what to run by hand). No dev
 * ENOENT self-heal: dev launches come from a terminal where `yaac` is on
 * PATH.
 */
export async function ensureAuthDaemonRunning(opts: {
  /** The resolved server target the daemon should broker for. */
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
