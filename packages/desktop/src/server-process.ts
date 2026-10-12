/**
 * The processes the shell runs: the machine-local auth daemon (the login
 * broker). A server is the CLI's to run (server-control.ts).
 *
 * The daemon is bundled into the app (dist/auth-daemon.js) and runs in an
 * Electron utilityProcess, so it lives exactly as long as the app and is
 * the only one on the machine. It is handed the origin of the server the
 * window loads and talks to that server alone.
 *
 * An app launched from Finder inherits the OS's minimal PATH, not the login
 * shell's, so the shell adopts the login-shell PATH before starting
 * anything. The daemon's children (claude, codex, the installers) and
 * `yaac` are then found where the user's terminal finds them.
 */
import { execFile } from 'node:child_process'
import type { ServerTarget } from '@yaac/shared/server-api'

/** Brackets PATH in the shell's output, which an rc file may print into. */
const PATH_MARK = '__YAAC_LOGIN_PATH__'

/**
 * Homebrew's bin dirs (Apple silicon, Intel), where the yaac-server formula
 * puts `yaac` and the `node` its shebang needs. Appended to whatever PATH
 * is adopted, so they are found even when the login shell times out or its
 * rc never runs `brew shellenv`.
 */
const HOMEBREW_BINS = ['/opt/homebrew/bin', '/usr/local/bin']

/**
 * Set this process's PATH to the login shell's, plus Homebrew's bin dirs.
 * Best effort: the inherited PATH stays when the shell can't be run or
 * prints none.
 */
export function adoptLoginShellPath(execImpl: typeof execFile = execFile): Promise<void> {
  return new Promise((resolve) => {
    // eslint-disable-next-line no-process-env -- SHELL is the OS login shell, not yaac config
    const shell = process.env.SHELL ?? '/bin/sh'
    const script = `printf '${PATH_MARK}%s${PATH_MARK}' "$PATH"`
    execImpl(shell, ['-lic', script], { timeout: 5000 }, (err, stdout) => {
      const found = err ? undefined : new RegExp(`${PATH_MARK}(.+?)${PATH_MARK}`, 's').exec(stdout)?.[1]
      // eslint-disable-next-line no-process-env -- inherited by every child the shell spawns
      const dirs = (found?.trim() ? found : process.env.PATH ?? '').split(':').filter((d) => d !== '')
      // eslint-disable-next-line no-process-env -- inherited by every child the shell spawns
      process.env.PATH = [...dirs, ...HOMEBREW_BINS.filter((d) => !dirs.includes(d))].join(':')
      resolve()
    })
  })
}

/** The part of Electron's UtilityProcess the runner uses. */
export interface DaemonChild {
  kill(): boolean
  once(event: 'exit', listener: () => void): unknown
}

export interface AuthDaemonRunner {
  /** Run a daemon for `target`, replacing one for a different server. */
  ensure(target: ServerTarget): void
  stop(): void
}

/**
 * One daemon at a time, forked with its server's origin and replaced when
 * the window's server changes. One that exits on its own is forked again
 * after a delay that doubles while it keeps crashing, up to `maxDelayMs`.
 */
export function createAuthDaemonRunner(
  fork: (baseUrl: string) => DaemonChild,
  { minDelayMs = 1000, maxDelayMs = 60_000 } = {},
): AuthDaemonRunner {
  let running: { baseUrl: string, child: DaemonChild } | null = null
  let restart: ReturnType<typeof setTimeout> | null = null
  let delay = minDelayMs

  const start = (baseUrl: string): void => {
    const startedAt = Date.now()
    const entry = { baseUrl, child: fork(baseUrl) }
    running = entry
    entry.child.once('exit', () => {
      if (running !== entry) return
      if (Date.now() - startedAt >= maxDelayMs) delay = minDelayMs
      restart = setTimeout(() => {
        restart = null
        if (running === entry) start(baseUrl)
      }, delay)
      delay = Math.min(delay * 2, maxDelayMs)
    })
  }
  const stop = (): void => {
    if (restart) clearTimeout(restart)
    restart = null
    const was = running
    running = null
    was?.child.kill()
  }
  return {
    ensure(target) {
      if (running?.baseUrl === target.baseUrl) return
      stop()
      delay = minDelayMs
      start(target.baseUrl)
    },
    stop,
  }
}
