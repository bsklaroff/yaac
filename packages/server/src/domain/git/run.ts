import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { env as serverEnv } from '@yaac/shared/env'
import { serverLocalPath } from '@yaac/shared/paths'
import type { GitProgress } from '@yaac/shared/types'

/**
 * The only way the server starts git (docs/server-git.md). Every call pins
 * off hooks, fsmonitor, submodule recursion, auto gc and every transport but
 * the one the call needs.
 */

/** What a call runs against. */
export type GitTarget =
  /** The project's main clone, with no work tree. */
  | { kind: 'repo'; repoPath: string }
  /** A git dir only the server has written and no workspace can see yet (a
   *  checkout being staged), used directly. */
  | { kind: 'private'; gitDir: string; workTree?: string }
  /** No repository yet (a clone), or one file read with `--file`. */
  | { kind: 'none' }

export interface GitRunOptions {
  /** The full env from `gitEnvForCredential` (https token helper, ssh
   *  command, Tor proxy). */
  env?: NodeJS.ProcessEnv
  /** The remote this call talks to, if any. Only its transport is allowed;
   *  without it, no transport is. */
  remoteUrl?: string
  /** Called with each progress line git prints to stderr (with
   *  `--progress`), parsed. */
  onProgress?: (progress: GitProgress) => void
}

/** Set on the command line for every call, overriding any config. */
const PINS = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'submodule.recurse=false',
  'fetch.recurseSubmodules=false',
  'diff.ignoreSubmodules=all',
  // Default gc prunes objects clones borrow. Only `maintainRepo` runs gc.
  'gc.auto=0',
  'maintenance.auto=false',
  'protocol.allow=never',
]

/**
 * Run git against `target` and return its stdout. Rejects with git's
 * stderr as the message when it exits non-zero.
 *
 * Calls without a work tree run in an empty server-private dir under a
 * ceiling, so git never discovers a repository from its cwd.
 */
export async function runGit(target: GitTarget, args: string[], opts: GitRunOptions = {}): Promise<string> {
  const env = gitEnv(opts.env)
  let cwd = await emptyCwd(env)
  if (target.kind === 'private') {
    env.GIT_DIR = target.gitDir
    if (target.workTree !== undefined) {
      env.GIT_WORK_TREE = target.workTree
      cwd = target.workTree
    }
  } else if (target.kind === 'repo') {
    env.GIT_DIR = path.join(target.repoPath, '.git')
  }
  const pins = [...PINS]
  if (opts.remoteUrl !== undefined) pins.push(`protocol.${transportOf(opts.remoteUrl)}.allow=always`)
  const run = execGit([...pins.flatMap((p) => ['-c', p]), ...args], cwd, env, opts.onProgress)
  if (opts.remoteUrl === undefined) return run
  return run.catch((err: Error) => {
    err.message = withEgressHint(err.message)
    throw err
  })
}

/**
 * `message`, with a pointer appended when it is a connect timeout in the
 * in-cluster server. Its egress policy drops dials to non-public addresses
 * silently, so a remote at one fails only by timing out
 * (docs/server-in-cluster.md "The server's own egress"). ssh says "timed
 * out"; curl 8 says only "Failed to connect to … after <n> ms", as it does
 * for a refusal, so a connect that took over 10s is read as a timeout.
 */
export function withEgressHint(message: string): string {
  const waited = /Failed to connect to .* after (\d+) ms/.exec(message)
  const timedOut = /timed out/i.test(message) || (waited !== null && Number(waited[1]) >= 10_000)
  if (!serverEnv.inCluster || !timedOut) return message
  return `${message} (the in-cluster yaac server reaches only public addresses; a git server at `
    + 'a private one must be opened to it: docs/server-in-cluster.md "The server\'s own egress")'
}

/**
 * Start git with no repository and the same pins as `runGit`, for a caller
 * that streams its stdin and stdout (`serveGitHttp`). `extraEnv` is added
 * to the server's env.
 */
export async function spawnGit(args: string[], extraEnv: NodeJS.ProcessEnv): Promise<ChildProcessWithoutNullStreams> {
  const env = { ...gitEnv(), ...extraEnv }
  const cwd = await emptyCwd(env)
  return spawn('git', [...PINS.flatMap((p) => ['-c', p]), ...args], { cwd, env })
}

/** The empty server-private dir a call without a work tree runs in, with
 *  `env` set so git never searches above it for a repository. */
async function emptyCwd(env: NodeJS.ProcessEnv): Promise<string> {
  const cwd = serverLocalPath('run', 'git-cwd')
  await fs.mkdir(cwd, { recursive: true, mode: 0o700 })
  env.GIT_CEILING_DIRECTORIES = path.dirname(cwd)
  return cwd
}

/** The git transport a remote URL uses, for `protocol.<name>.allow`. */
function transportOf(url: string): string {
  const helper = /^([A-Za-z][A-Za-z0-9+.-]*)::/.exec(url)
  if (helper) return helper[1]
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url)
  if (scheme) return /^(git\+ssh|ssh\+git)$/.test(scheme[1]) ? 'ssh' : scheme[1].toLowerCase()
  // scp-like `user@host:path`: a colon before any slash.
  if (/^[^/]+:/.test(url)) return 'ssh'
  return 'file'
}

/** `extra` (or the server's env) minus variables that would point git at
 *  another repository or change the kind of one it creates. */
function gitEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // eslint-disable-next-line no-process-env -- the git child needs PATH/HOME/…; `extra` already carries it when given
  const env: NodeJS.ProcessEnv = { ...(extra ?? process.env) }
  for (const name of [
    'GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES',
    // Beats `-c init.defaultRefFormat`, which `createCheckout` pins.
    'GIT_DEFAULT_REF_FORMAT',
  ]) delete env[name]
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}

/**
 * A progress line, such as `Receiving objects:  45% (556/1234), 1.20 MiB |
 * 2.00 MiB/s` or `remote: Enumerating objects: 1234, done.`, parsed; null
 * for any other line. A count needs its `, done.`, so a host's free-text
 * `remote: Error: 403` is not taken for a phase.
 */
function parseProgress(line: string): GitProgress | null {
  const m = /^(?:remote: )?([A-Z][A-Za-z ]+):\s+(?:(\d+)% \(\d+\/\d+\)(?:, (.+?))?(?:, done\.)?|\d+, done\.)\s*$/.exec(line)
  if (!m) return null
  return {
    phase: m[1],
    percent: m[2] === undefined ? null : Number(m[2]),
    ...(m[3] !== undefined && m[3] !== 'done.' ? { detail: m[3] } : {}),
  }
}

/**
 * Run git, rejecting with its stderr minus progress. Git redraws a progress
 * line in place, ending each version with a carriage return, so of each
 * line only what follows the last one is kept (a CRLF ending aside).
 */
function execGit(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  onProgress?: (progress: GitProgress) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, env, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout)
      const lines = stderr.split(/\r?\n/).map((l) => l.slice(l.lastIndexOf('\r') + 1))
      const message = lines.join('\n').trim() || err.message
      reject(Object.assign(new Error(message), { code: err.code }))
    })
    if (onProgress === undefined) return
    let partial = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      const lines = (partial + chunk.toString()).split(/[\r\n]/)
      partial = lines.pop() ?? ''
      for (const line of lines) {
        const progress = parseProgress(line)
        if (progress) onProgress(progress)
      }
    })
  })
}
