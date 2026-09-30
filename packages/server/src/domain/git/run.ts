import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { serverLocalPath } from '@yaac/shared/paths'

/**
 * The only way the server starts git (docs/server-git.md).
 *
 * Until a project's last linked checkout is converted
 * (`adoptLinkedCheckout`), a legacy pod may have its main clone's `.git`
 * mounted read-write. Git can't be told to ignore a repo's config, and config
 * can make git run commands (filter drivers, fsmonitor, credential helpers).
 * So each call runs against a throwaway git dir with an allowlisted copy of
 * the config, read once, and the real objects and refs linked in; git never
 * opens the real config.
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

/** The only config keys the copy keeps, the minimum git needs to read the
 *  repo. Everything else is dropped, including keys future git adds. */
const KEPT_KEYS = /^(core\.repositoryformatversion|extensions\.(objectformat|refstorage))$/

/** Entries of the real git dir linked into the throwaway one. Excluded:
 *  `config` (copied), `hooks`, `modules` (submodule git dirs carry their own
 *  config), and `gc.pid` (`maintainRepo` runs gc in the foreground here). */
const LINKED = ['objects', 'refs', 'packed-refs', 'logs', 'worktrees', 'info', 'shallow']
/** Linked directories created up front so writes through the link land.
 *  Not `worktrees`: its absence marks a fully converted project. */
const ENSURED_DIRS = ['logs', 'info']

/** Set on the command line for every call, overriding any config. */
const PINS = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'submodule.recurse=false',
  'fetch.recurseSubmodules=false',
  'diff.ignoreSubmodules=all',
  // No auto gc: it detaches and would outlive the throwaway dir, and default
  // gc prunes objects clones borrow. Only `maintainRepo` runs gc.
  'gc.auto=0',
  'maintenance.auto=false',
  'protocol.allow=never',
]

/** A config file bigger than this is refused rather than read. */
const MAX_CONFIG_BYTES = 1 << 20

/**
 * Run git against `target` and return its stdout. Rejects with git's
 * stderr as the message when it exits non-zero.
 */
export async function runGit(target: GitTarget, args: string[], opts: GitRunOptions = {}): Promise<string> {
  const scratch = await makeScratchDir()
  try {
    const env = gitEnv(opts.env)
    let cwd = scratch
    if (target.kind === 'none') {
      env.GIT_CEILING_DIRECTORIES = path.dirname(scratch)
    } else if (target.kind === 'private') {
      env.GIT_DIR = target.gitDir
      if (target.workTree !== undefined) {
        env.GIT_WORK_TREE = target.workTree
        cwd = target.workTree
      }
    } else {
      await buildGitDir(path.join(target.repoPath, '.git'), scratch)
      env.GIT_DIR = scratch
      env.GIT_COMMON_DIR = scratch
    }
    const pins = [...PINS]
    if (opts.remoteUrl !== undefined) pins.push(`protocol.${transportOf(opts.remoteUrl)}.allow=always`)
    return await execGit([...pins.flatMap((p) => ['-c', p]), ...args], cwd, env)
  } finally {
    await fs.rm(scratch, { recursive: true, force: true })
  }
}

/**
 * Values of `key` in the repo's config, read from a one-time copy like
 * `runGit` does. For keys `runGit`'s copy drops (`branch.<name>.merge` during
 * conversion, the never-prune keys). Empty when unset.
 */
export async function readRepoConfig(repoPath: string, key: string): Promise<string[]> {
  const scratch = await makeScratchDir()
  try {
    const copy = path.join(scratch, 'config.src')
    await fs.writeFile(copy, await readOnce(path.join(repoPath, '.git', 'config'), MAX_CONFIG_BYTES))
    return await configValues(copy, ['--get-all', key], scratch)
  } finally {
    await fs.rm(scratch, { recursive: true, force: true })
  }
}

const scratchBase = (): string => serverLocalPath('run', 'git-shadow')

/**
 * Remove every throwaway git dir left by a server killed mid-call. Only the
 * server calls this, once at startup under its lock; any other process could
 * delete a live server's dirs.
 */
export async function clearGitScratch(): Promise<void> {
  await fs.rm(scratchBase(), { recursive: true, force: true })
}

async function makeScratchDir(): Promise<string> {
  await fs.mkdir(scratchBase(), { recursive: true, mode: 0o700 })
  return fs.mkdtemp(path.join(scratchBase(), 'g-'))
}

/** Lay out the throwaway git dir for `realGitDir` in `dir`. */
async function buildGitDir(realGitDir: string, dir: string): Promise<void> {
  // Read the real config exactly once; nothing below reopens it.
  const copy = path.join(dir, 'config.src')
  await fs.writeFile(copy, await readOnce(path.join(realGitDir, 'config'), MAX_CONFIG_BYTES))
  const kept = await configEntries(copy, dir)
  await fs.rm(copy)

  const lines = ['[core]', '\tbare = true', '\tlogallrefupdates = true']
  const format = kept.get('core.repositoryformatversion') ?? '0'
  if (!/^[01]$/.test(format)) throw new Error(`unsupported repositoryformatversion ${format}`)
  lines.push(`\trepositoryformatversion = ${format}`)
  const objectFormat = kept.get('extensions.objectformat')
  const refStorage = kept.get('extensions.refstorage')
  if (objectFormat !== undefined && !/^(sha1|sha256)$/.test(objectFormat)) {
    throw new Error(`unsupported objectformat ${objectFormat}`)
  }
  // The links below assume the files ref backend; refuse reftable.
  if (refStorage !== undefined && refStorage !== 'files') {
    throw new Error(`unsupported refstorage ${refStorage}`)
  }
  if (objectFormat !== undefined) lines.push('[extensions]', `\tobjectformat = ${objectFormat}`)
  await fs.writeFile(path.join(dir, 'config'), lines.join('\n') + '\n')

  const head = (await readOnce(path.join(realGitDir, 'HEAD'), 4096)).toString('utf8')
  if (!/^(ref: refs\/\S+|[0-9a-f]{40}|[0-9a-f]{64})\n?$/.test(head)) {
    throw new Error(`unreadable HEAD in ${realGitDir}`)
  }
  await fs.writeFile(path.join(dir, 'HEAD'), head)

  for (const name of ENSURED_DIRS) await fs.mkdir(path.join(realGitDir, name), { recursive: true })
  // Linking a not-yet-existing entry (`packed-refs`, `shallow`) works: git's
  // lockfile resolves the link, so a write creates the real file.
  for (const name of LINKED) await fs.symlink(path.join(realGitDir, name), path.join(dir, name))
}

/** The allowlisted keys of the config file at `file`. */
async function configEntries(file: string, cwd: string): Promise<Map<string, string>> {
  const out = await execGit(['config', '--file', file, '--no-includes', '--null', '--list'], cwd, fileEnv(cwd))
  const kept = new Map<string, string>()
  for (const entry of out.split('\0')) {
    const nl = entry.indexOf('\n')
    if (nl < 0) continue
    const key = entry.slice(0, nl)
    if (KEPT_KEYS.test(key)) kept.set(key, entry.slice(nl + 1))
  }
  return kept
}

async function configValues(file: string, query: string[], cwd: string): Promise<string[]> {
  try {
    const out = await execGit(['config', '--file', file, '--no-includes', '--null', ...query], cwd, fileEnv(cwd))
    return out.split('\0').filter((v) => v !== '')
  } catch (err) {
    // `git config --get*` exits 1 for an unset key.
    if ((err as { code?: unknown }).code === 1) return []
    throw err
  }
}

/** A regular file's bytes, refusing a symlink or anything oversized. */
async function readOnce(file: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error(`${file} is not a regular file`)
    if (stat.size > maxBytes) throw new Error(`${file} is too large to read`)
    return await handle.readFile()
  } finally {
    await handle.close()
  }
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

/** For reading one file in `scratch`: no repository is discovered. */
function fileEnv(scratch: string): NodeJS.ProcessEnv {
  return { ...gitEnv(), GIT_CEILING_DIRECTORIES: path.dirname(scratch) }
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
