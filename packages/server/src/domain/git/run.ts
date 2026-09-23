import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { serverLocalPath } from '@yaac/shared/paths'

/**
 * The one way the server starts git (docs/server-git.md).
 *
 * A project's `.git` is mounted read-write into every worktree pod, so
 * anything git reads from it is written by an agent. Git has no switch to
 * ignore a repository's config, and that config can name commands for git
 * to run (filter drivers, fsmonitor, credential helpers) under names only
 * its writer knows. So git never reads it: each call runs against a
 * throwaway git dir holding an allowlisted COPY of the config, read once, with
 * the real object store and refs linked in. A pod rewriting its config
 * mid-call changes nothing, because git never opens that file.
 */

/** What a call runs against. */
export type GitTarget =
  /** The project's clone itself — no work tree. */
  | { kind: 'repo'; repoPath: string }
  /** A linked worktree's checkout. `worktreeId` names its admin dir under
   *  `<repo>/.git/worktrees/`. */
  | { kind: 'worktree'; repoPath: string; worktreeId: string; workTree: string }
  /** No repository yet (a clone), or one file read with `--file`. */
  | { kind: 'none' }

export interface GitRunOptions {
  /** The environment the credential needs (ssh command, Tor proxy); the
   *  full env, as `gitEnvForCredential` builds it. */
  env?: NodeJS.ProcessEnv
  /** The remote this call talks to, when it talks to one. Only its
   *  transport is allowed; every call without one may use none. */
  remoteUrl?: string
}

/** The only keys the copy keeps: what git needs to read the repository at
 *  all. Everything else — every driver, hook, URL, helper and include — is
 *  dropped, so a key git grows later is dropped too. */
const KEPT_KEYS = /^(core\.repositoryformatversion|extensions\.(objectformat|refstorage))$/

/** Entries of the real git dir the throwaway one links. No `config` (it is
 *  the copy), no `hooks`, no `modules` (a submodule's git dir brings its
 *  own config), no `gc.pid` (the server runs no gc). */
const LINKED = ['objects', 'refs', 'packed-refs', 'logs', 'worktrees', 'info', 'shallow']
/** The linked directories that must exist for a write to land through the
 *  link: git creates `logs/…` and `worktrees/<name>` on demand. */
const ENSURED_DIRS = ['logs', 'worktrees', 'info']

/** Pinned on every call, on the command line, which beats any config. */
const PINS = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'submodule.recurse=false',
  'fetch.recurseSubmodules=false',
  'diff.ignoreSubmodules=all',
  // The server runs no gc on the shared repo: an auto gc detaches and
  // would outlive the throwaway git dir, and its lock (`gc.pid`) would sit
  // in that dir where a pod's gc cannot see it. Pods gc it themselves.
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
    } else {
      await buildGitDir(path.join(target.repoPath, '.git'), scratch, target.kind === 'repo')
      // GIT_COMMON_DIR on a `repo` target too: a git child process
      // `worktree add` starts in the new admin dir would otherwise resolve
      // its `commondir` through the `worktrees` link, back to the real
      // config.
      env.GIT_COMMON_DIR = scratch
      if (target.kind === 'repo') {
        env.GIT_DIR = scratch
      } else {
        env.GIT_DIR = path.join(target.repoPath, '.git', 'worktrees', target.worktreeId)
        env.GIT_WORK_TREE = target.workTree
        cwd = target.workTree
      }
    }
    const pins = [...PINS]
    if (opts.remoteUrl !== undefined) pins.push(`protocol.${transportOf(opts.remoteUrl)}.allow=always`)
    return await execGit([...pins.flatMap((p) => ['-c', p]), ...args], cwd, env)
  } finally {
    await fs.rm(scratch, { recursive: true, force: true })
  }
}

/**
 * Values of `key` in the repository's config, read from a copy the same way
 * `runGit` reads it — for the data a server reads back out of config
 * (`branch.<name>.merge`), which the copy `runGit` builds does not keep.
 * Empty when the key is unset.
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
 * Remove every throwaway git dir, for the server to call once at startup:
 * a server killed mid-call (a roll, an OOM) never ran its `finally`. Only
 * safe where nothing else can be mid-call, which is why it is the server's,
 * under its lock, and not something the first call of any process does — a
 * test process sharing a live server's data dir would sweep that server's
 * dirs out from under it.
 */
export async function clearGitScratch(): Promise<void> {
  await fs.rm(scratchBase(), { recursive: true, force: true })
}

async function makeScratchDir(): Promise<string> {
  await fs.mkdir(scratchBase(), { recursive: true, mode: 0o700 })
  return fs.mkdtemp(path.join(scratchBase(), 'g-'))
}

/** Lay out the throwaway git dir for `realGitDir` in `dir`. */
async function buildGitDir(realGitDir: string, dir: string, bare: boolean): Promise<void> {
  // One read of the real config. Nothing below opens it again, which is
  // what makes a concurrent write by a pod irrelevant.
  const copy = path.join(dir, 'config.src')
  await fs.writeFile(copy, await readOnce(path.join(realGitDir, 'config'), MAX_CONFIG_BYTES))
  const kept = await configEntries(copy, dir)
  await fs.rm(copy)

  const lines = ['[core]', `\tbare = ${bare}`, '\tlogallrefupdates = true']
  const format = kept.get('core.repositoryformatversion') ?? '0'
  if (!/^[01]$/.test(format)) throw new Error(`unsupported repositoryformatversion ${format}`)
  lines.push(`\trepositoryformatversion = ${format}`)
  const objectFormat = kept.get('extensions.objectformat')
  const refStorage = kept.get('extensions.refstorage')
  if (objectFormat !== undefined && !/^(sha1|sha256)$/.test(objectFormat)) {
    throw new Error(`unsupported objectformat ${objectFormat}`)
  }
  // The links below are the files ref backend's layout; a reftable repo
  // keeps its refs elsewhere, and reading it through them would be wrong.
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
  // A link to an entry that does not exist yet (`packed-refs`, `shallow`)
  // still works: git's lockfile resolves the link, so a write creates the
  // real file.
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

/** The server's own environment minus anything that would point git at a
 *  repository other than the one named here, plus `extra`. */
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
