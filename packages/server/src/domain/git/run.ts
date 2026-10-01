import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { serverLocalPath } from '@yaac/shared/paths'

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
  /** The full env from `gitEnvForCredential` (ssh command, Tor proxy). */
  env?: NodeJS.ProcessEnv
  /** The remote this call talks to, if any. Only its transport is allowed;
   *  without it, no transport is. */
  remoteUrl?: string
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
  let cwd = serverLocalPath('run', 'git-cwd')
  await fs.mkdir(cwd, { recursive: true, mode: 0o700 })
  env.GIT_CEILING_DIRECTORIES = path.dirname(cwd)
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
  return execGit([...pins.flatMap((p) => ['-c', p]), ...args], cwd, env)
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
 *  another repository. */
function gitEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // eslint-disable-next-line no-process-env -- the git child needs PATH/HOME/…; `extra` already carries it when given
  const env: NodeJS.ProcessEnv = { ...(extra ?? process.env) }
  for (const name of [
    'GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES',
  ]) delete env[name]
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}

function execGit(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout)
      const message = stderr.trim() || err.message
      reject(Object.assign(new Error(message), { code: err.code }))
    })
  })
}
