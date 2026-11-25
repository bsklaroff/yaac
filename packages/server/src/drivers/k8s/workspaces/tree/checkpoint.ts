import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs, { type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import {
  BUNDLES_DIR, LIVES_DIR, MANIFEST_FILE, MAX_MANIFEST_BYTES, parseManifest,
  type Manifest, type SavedUnit, type StartCheckout, type StartInstruction,
} from '@yaac/shared/tree-records'

/**
 * The tree container's git work (docs/node-local-workspaces.md
 * "Checkpoints"): checking a life's tree out or restoring it, and saving it
 * in passes, each a bundle appended to the workspace's checkpoint log.
 *
 * Every git call runs against the scratch repository, never a checkout's
 * own `.git`, whose config, hooks and index are the agent's. From a
 * checkout's git dir it takes objects (through the scratch repository's
 * alternates), the value of HEAD, read as a file, and `info/exclude`.
 */

/** Where one life's things are, as the tree container sees them. */
export interface TreeContext {
  tree: string
  scratch: string
  /** The workspace's checkpoint dir: `bundles/` and `lives/`. */
  ckpt: string
  start: StartInstruction
}

/** git's empty tree, as the attribute source, so no filter or eol rule of
 *  the tree's own applies to what is saved. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
/** A bundle under this size that this life wrote is merged at compaction. */
const SMALL_BUNDLE_BYTES = 64 * 1024 * 1024
/** Compaction also runs when a chain grows past this many bundles. */
const MAX_CHAIN = 20
const PASS_REF = 'refs/yaac/pass'
/** The line of a pass commit's message naming its units. */
const UNITS_TRAILER = 'yaac-units: '

const repoDir = (c: TreeContext): string => path.join(c.scratch, 'repo')
const indexFile = (c: TreeContext, key: string): string => path.join(c.scratch, 'idx', key)
const lifeDir = (c: TreeContext): string => path.join(c.ckpt, LIVES_DIR, c.start.life)
/** Whether files must be handed to the install uid: only when it is not us. */
const asOwnerNeeded = (c: TreeContext): boolean => process.getuid?.() !== c.start.uid

interface GitOpts {
  env?: Record<string, string>
  input?: string
  /** An open file git reads as its stdin, from where the file stands. */
  stdin?: number
  /** Run as the install uid (writing files the agent will own). */
  asOwner?: boolean
  /** Exit codes that are answers, not failures. */
  ok?: number[]
  /** Whether a failed exit, with what git printed, is an answer after all. */
  okWhen?: (code: number, stderr: string) => boolean
}

/**
 * Whether `git add` failed only to report that a pathspec names an ignored
 * path, which it does for an excluded path the unit's rules also ignore (a
 * scratch dir under `node_modules/`, say). It has staged everything else by
 * then, so that is no failure; a warning (an embedded repository) may come
 * with it.
 */
const onlyIgnoredReport = (code: number, stderr: string): boolean =>
  code === 1 && stderr.startsWith('The following paths are ignored')
  && !/^(fatal|error):/m.test(stderr)

/**
 * Run git on the scratch repository. Config is pinned over whatever the
 * environment holds: no hooks, fsmonitor, transport or lazy fetch, and no
 * user or system config.
 */
async function git(c: TreeContext, args: string[], opts: GitOpts = {}): Promise<string> {
  const full = [
    '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never',
    '-c', 'safe.directory=*', '-c', 'core.quotePath=false', '-c', 'advice.addEmbeddedRepo=false',
    '-c', 'advice.addIgnoredFile=false',
    '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args,
  ]
  const env = {
    // eslint-disable-next-line no-process-env -- a program of its own in the tree container, finding git on its PATH
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LC_ALL: 'C',
    HOME: c.scratch,
    GIT_DIR: repoDir(c),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_LAZY_FETCH: '1',
    ...opts.env,
  }
  const [cmd, argv] = opts.asOwner && asOwnerNeeded(c)
    ? ['setpriv', ['--reuid', String(c.start.uid), '--regid', String(c.start.gid), '--clear-groups', 'git', ...full]]
    : ['git', full]
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { env, stdio: [opts.stdin ?? (opts.input === undefined ? 'ignore' : 'pipe'), 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout?.on('data', (b: Buffer) => out.push(b))
    child.stderr?.on('data', (b: Buffer) => err.push(b))
    child.on('error', reject)
    child.on('close', (code) => {
      const stderr = Buffer.concat(err).toString('utf8')
      if (code === 0 || (code !== null && (opts.ok?.includes(code) || opts.okWhen?.(code, stderr)))) resolve(Buffer.concat(out).toString('utf8'))
      else reject(new Error(`git ${args.slice(0, 2).join(' ')}: exit ${String(code)}: ${stderr.trim()}`))
    })
    // git may exit before reading all its input.
    child.stdin?.on('error', () => {})
    child.stdin?.end(opts.input)
  })
}

/** Hand a file the tree container wrote to the install uid. */
async function own(c: TreeContext, p: string): Promise<void> {
  if (asOwnerNeeded(c)) await fs.chown(p, c.start.uid, c.start.gid)
}

/** Make `dir` and its missing parents, each handed to the install uid. */
async function mkdirOwned(c: TreeContext, dir: string): Promise<void> {
  const missing: string[] = []
  for (let d = dir; ; d = path.dirname(d)) {
    if (await fs.stat(d).then(() => true, () => false)) break
    missing.unshift(d)
    if (path.dirname(d) === d) break
  }
  for (const d of missing) {
    await fs.mkdir(d).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e })
    await own(c, d)
  }
}

/** Write a file through a temp name, synced before the rename, so a
 *  reader on another node never finds a name without its bytes. */
async function writeDurably(c: TreeContext, file: string, write: (tmp: string) => Promise<void>): Promise<void> {
  const tmp = `${file}.tmp-${process.pid.toString(36)}`
  await write(tmp)
  const fh = await fs.open(tmp, 'r')
  try {
    await fh.sync()
  } finally {
    await fh.close()
  }
  await own(c, tmp)
  await fs.rename(tmp, file)
  // The new name is durable only once its folder is synced too.
  const dir = await fs.open(path.dirname(file), 'r')
  try {
    await dir.sync()
  } finally {
    await dir.close()
  }
}

/** The commit a git dir's HEAD names, read as data, or null. */
export async function readHead(gitDir: string): Promise<string | null> {
  const head = (await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8').catch(() => '')).trim()
  if (/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head)) return head
  const ref = /^ref: (refs\/\S+)$/.exec(head)?.[1]
  if (ref === undefined || ref.split('/').includes('..')) return null
  const loose = (await fs.readFile(path.join(gitDir, ref), 'utf8').catch(() => '')).trim()
  if (/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(loose)) return loose
  const packed = await fs.readFile(path.join(gitDir, 'packed-refs'), 'utf8').catch(() => '')
  for (const line of packed.split('\n')) {
    const [sha, name] = line.split(' ')
    if (name === ref && /^[0-9a-f]{40}/.test(sha)) return sha
  }
  return null
}

/** Make the scratch repository and its index folder, if missing, and point
 *  its alternates at every object store the tree's git dirs use. */
async function prepareScratch(c: TreeContext, objectDirs: string[]): Promise<void> {
  const repo = repoDir(c)
  if (!(await fs.stat(path.join(repo, 'HEAD')).then(() => true, () => false))) {
    await fs.mkdir(c.scratch, { recursive: true })
    await git(c, ['init', '-q', '--bare', repo])
  }
  await fs.mkdir(path.join(c.scratch, 'idx'), { recursive: true })
  await own(c, path.join(c.scratch, 'idx'))
  const lines = [...new Set(objectDirs)].join('\n')
  await fs.writeFile(path.join(repo, 'objects', 'info', 'alternates'), lines ? `${lines}\n` : '')
}

const key = (kind: string, p: string): string => createHash('sha1').update(`${kind}:${p}`).digest('hex').slice(0, 16)

/** Check out `treeish` into `worktree` through the index named `idx`,
 *  as the install uid, discarding any older index of that name. */
async function writeTree(c: TreeContext, worktree: string, idx: string, treeish: string): Promise<void> {
  await mkdirOwned(c, worktree)
  await fs.rm(indexFile(c, idx), { force: true })
  const env = { GIT_WORK_TREE: worktree, GIT_INDEX_FILE: indexFile(c, idx) }
  await git(c, ['-c', 'checkout.workers=8', '-c', 'checkout.thresholdForParallelism=100', 'read-tree', '-u', '--reset', treeish], {
    asOwner: true,
    env,
  })
  await pinGitlinks(c, env, worktree)
}

/** One thing a pass saves, as found in this pass. */
interface LiveUnit {
  unit: SavedUnit
  worktree: string
  /** Its git dir, for a checkout or submodule. */
  gitDir?: string
  /** Its own ignore file, or none for the root. */
  excludesFile?: string
  kept: string[]
}

const under = (p: string, dir: string): boolean => dir === '' || p === dir || p.startsWith(`${dir}/`)
const relTo = (p: string, dir: string): string => (dir === '' ? p : p.slice(dir.length + 1))

/**
 * Mark every gitlink of an index skip-worktree, after dropping those whose
 * repository is gone. Each repository inside a unit is saved as a unit of
 * its own, and git, finding a gitlink unchanged, would otherwise run
 * `git status` inside that repository, which rewrites its index.
 */
async function pinGitlinks(c: TreeContext, env: Record<string, string>, worktree: string): Promise<void> {
  const links = (await git(c, ['ls-files', '-s', '-z'], { env })).split('\0')
    .filter((l) => l.startsWith('160000 ')).map((l) => l.slice(l.indexOf('\t') + 1))
  const gone: string[] = []
  for (const l of links) if (!(await fs.lstat(path.join(worktree, l, '.git')).then(() => true, () => false))) gone.push(l)
  if (gone.length > 0) await git(c, ['update-index', '-z', '--force-remove', '--stdin'], { env, input: `${gone.join('\0')}\0` })
  const kept = links.filter((l) => !gone.includes(l))
  if (kept.length > 0) await git(c, ['update-index', '-z', '--skip-worktree', '--stdin'], { env, input: `${kept.join('\0')}\0` })
}

/**
 * The nested repositories with no commit yet under a unit's work tree, as
 * paths relative to it. `git ls-files -o` names every nested repository,
 * at any depth, as one `<dir>/` entry without entering it; those whose
 * own HEAD names no commit are the ones `git add` would refuse. The root,
 * which honours no ignore rules, is listed whole.
 */
async function unbornRepos(
  c: TreeContext, u: LiveUnit, env: Record<string, string>, base: string[], excludes: string[],
): Promise<string[]> {
  const standard = u.unit.kind === 'root' ? [] : ['--exclude-standard']
  const out = await git(c, [...base, 'ls-files', '-o', '-z', ...standard, '--', '.', ...excludes], { env })
  const unborn: string[] = []
  for (const entry of out.split('\0')) {
    if (!entry.endsWith('/')) continue
    const rel = entry.slice(0, -1)
    const gitDir = path.join(u.worktree, rel, '.git')
    if (!(await fs.lstat(gitDir).catch(() => null))?.isDirectory()) continue
    if (await readHead(gitDir) === null) unborn.push(rel)
  }
  return unborn
}

/** Stage a unit's files into its private index, returning the tree. */
async function stageFiles(c: TreeContext, u: LiveUnit, skip: string[]): Promise<{ tree: string; unborn: string[] }> {
  const upath = 'path' in u.unit ? u.unit.path : ''
  const env = { GIT_WORK_TREE: u.worktree, GIT_INDEX_FILE: indexFile(c, key(u.unit.kind, upath)) }
  await pinGitlinks(c, env, u.worktree)
  const excludes = skip.filter((p) => p !== upath && under(p, upath)).map((p) => `:(exclude,literal)${relTo(p, upath)}`)
  const base = ['-c', `core.excludesFile=${u.excludesFile ?? '/dev/null'}`, `--attr-source=${EMPTY_TREE}`]
  // git refuses a nested repository with no commit yet (`git init`, `cargo
  // new`), which it cannot record as a gitlink; each is found up front,
  // left out here and saved as a repository of its own.
  const force = u.unit.kind === 'root' ? ['-f'] : []
  const unborn = await unbornRepos(c, u, env, base, excludes)
  await git(c, [...base, 'add', '-A', ...force, '--', '.', ...excludes, ...unborn.map((p) => `:(exclude,literal)${p}`)],
    { env, okWhen: onlyIgnoredReport })
  const kept = []
  for (const k of u.kept) {
    if (await fs.lstat(path.join(u.worktree, k)).then(() => true, () => false)) kept.push(k)
  }
  if (kept.length > 0) await git(c, [...base, 'add', '-A', '-f', '--', ...kept.map((k) => `:(literal)${k}`)], { env })
  await pinGitlinks(c, env, u.worktree)
  return { tree: (await git(c, ['write-tree'], { env })).trim(), unborn }
}

/**
 * Stage a repository's git dir as plain files: its refs first and its
 * objects after, the reverse of the order git writes them, so every object
 * a saved ref names is already there when the walk reaches it. An object
 * file is staged once and then marked unchanged, since git touches a pack's
 * mtime whenever it reuses an object in it; a pass only adds new ones and
 * drops vanished ones. Nothing is recompressed.
 */
async function stageGitDir(c: TreeContext, repoPath: string, gitDir: string): Promise<string> {
  const env = { GIT_WORK_TREE: gitDir, GIT_INDEX_FILE: indexFile(c, key('repo.git', repoPath)) }
  const base = ['-c', 'core.excludesFile=/dev/null', '-c', 'core.compression=0', `--attr-source=${EMPTY_TREE}`]
  const refs = []
  for (const r of ['HEAD', 'packed-refs', 'refs', 'logs']) {
    if (await fs.lstat(path.join(gitDir, r)).then(() => true, () => false)) refs.push(`:(literal)${r}`)
  }
  if (refs.length > 0) await git(c, [...base, 'add', '-A', '-f', '--', ...refs], { env })
  const onDisk = new Set<string>()
  const walk = async (rel: string): Promise<void> => {
    for (const e of await fs.readdir(path.join(gitDir, rel), { withFileTypes: true }).catch(() => [])) {
      const child = `${rel}/${e.name}`
      if (e.isDirectory()) await walk(child)
      else if (e.isFile()) onDisk.add(child)
    }
  }
  await walk('objects')
  const staged = new Set((await git(c, ['ls-files', '-z', '--', ':(literal)objects'], { env })).split('\0').filter(Boolean))
  const gone = [...staged].filter((p) => !onDisk.has(p))
  const fresh = [...onDisk].filter((p) => !staged.has(p))
  if (gone.length > 0) await git(c, ['update-index', '-z', '--force-remove', '--stdin'], { env, input: `${gone.join('\0')}\0` })
  if (fresh.length > 0) {
    await git(c, [...base, 'add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'],
      { env: { ...env, GIT_LITERAL_PATHSPECS: '1' }, input: `${fresh.join('\0')}\0` })
    await git(c, ['update-index', '-z', '--assume-unchanged', '--stdin'], { env, input: `${fresh.join('\0')}\0` })
  }
  const rest = ['HEAD', 'packed-refs', 'refs', 'logs', 'objects'].map((r) => `:(exclude,literal)${r}`)
  await git(c, [...base, 'add', '-A', '-f', '--', '.', ...rest], { env })
  return (await git(c, ['write-tree'], { env })).trim()
}

/** The gitlinks a unit's index holds: repositories inside it, as paths
 *  under the unit's work tree. */
async function gitlinks(c: TreeContext, u: LiveUnit): Promise<string[]> {
  const upath = 'path' in u.unit ? u.unit.path : ''
  const out = await git(c, ['ls-files', '-s', '-z'], {
    env: { GIT_WORK_TREE: u.worktree, GIT_INDEX_FILE: indexFile(c, key(u.unit.kind, upath)) },
  })
  return out.split('\0').filter((l) => l.startsWith('160000 ')).map((l) => l.slice(l.indexOf('\t') + 1))
}

/** The checkout a path under the tree belongs to, the deepest one. */
function checkoutOf(c: TreeContext, p: string): StartCheckout | undefined {
  return [...c.start.checkouts].sort((a, b) => b.path.length - a.path.length).find((co) => under(p, co.path))
}

/**
 * What a gitlink at `treePath` is: a repository with its own git dir (a
 * `.git` folder), or a submodule whose `.git` file points into its
 * checkout's git dir. Anything else is left as the bare gitlink.
 */
async function childUnit(c: TreeContext, treePath: string): Promise<LiveUnit | null> {
  const abs = path.join(c.tree, treePath)
  const dotgit = path.join(abs, '.git')
  const st = await fs.lstat(dotgit).catch(() => null)
  if (st?.isDirectory()) {
    return { unit: { kind: 'repo', path: treePath }, worktree: abs, excludesFile: path.join(dotgit, 'info', 'exclude'), kept: [] }
  }
  if (!st?.isFile()) return null
  const co = checkoutOf(c, treePath)
  const pointer = /^gitdir: (.+)$/m.exec(await fs.readFile(dotgit, 'utf8').catch(() => ''))?.[1]?.trim()
  if (!co || pointer === undefined) return null
  // The pointer names the checkout's git dir as the workspace sees it,
  // under the checkout; here that git dir is mounted elsewhere.
  const coGit = path.join(c.tree, co.path, '.git')
  const target = path.resolve(abs, pointer)
  if (!target.startsWith(`${coGit}/`)) return null
  const inGit = target.slice(coGit.length + 1)
  const gitDir = path.join(co.gitDir, inGit)
  const head = await readHead(gitDir)
  if (head === null) return null
  return {
    unit: { kind: 'submodule', path: treePath, checkout: co.id, gitDir: inGit, head },
    worktree: abs, gitDir, excludesFile: path.join(gitDir, 'info', 'exclude'), kept: [],
  }
}

/** How a log line names a unit. */
function unitLabel(u: SavedUnit): string {
  if (u.kind === 'root') return 'the root'
  const where = u.path === '' ? '(the workspace root)' : u.path
  return `${u.kind === 'repo' ? 'repository' : u.kind} ${where}`
}

/**
 * Remove the lock files a git killed mid-write left in the scratch
 * repository, which would fail every later write there. Only for a program
 * that is now the tree's one writer: a started (or restarted) tree
 * container, or a salvage pod, which is named for its life so a new one
 * first removes any earlier one.
 */
export async function clearStaleLocks(c: TreeContext): Promise<void> {
  const walk = async (dir: string): Promise<void> => {
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, e.name)
      if (e.isDirectory() && e.name !== 'objects') await walk(p)
      else if (e.isFile() && e.name.endsWith('.lock')) await fs.rm(p, { force: true })
    }
  }
  await walk(path.join(c.scratch, 'idx'))
  await walk(repoDir(c))
}

/** The life's current manifest, if it has one. */
export async function readOwnManifest(c: TreeContext): Promise<Manifest | null> {
  return readManifestAt(path.join(lifeDir(c), MANIFEST_FILE))
}

async function readManifestAt(file: string): Promise<Manifest | null> {
  const fh = await fs.open(file, 'r').catch(() => null)
  if (!fh) return null
  try {
    const buf = Buffer.alloc(MAX_MANIFEST_BYTES + 1)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    if (bytesRead > MAX_MANIFEST_BYTES) return null
    return parseManifest(buf.subarray(0, bytesRead).toString('utf8'))
  } finally {
    await fh.close()
  }
}

async function writeManifest(c: TreeContext, m: Manifest): Promise<void> {
  await mkdirOwned(c, lifeDir(c))
  await writeDurably(c, path.join(lifeDir(c), MANIFEST_FILE), (tmp) => fs.writeFile(tmp, `${JSON.stringify(m, null, 2)}\n`))
}

/**
 * Write a bundle of `PASS_REF` less everything `not` reaches, under a name
 * of its own, returning its path relative to the checkpoint dir. A bundle
 * that leans on no earlier pass (a chain's first, or a compaction from its
 * start) leaves out instead every file of a start commit its main clone
 * holds. A main clone never deletes an object (docs/server-git.md), so a
 * chain can lean on those files; git leaves out a commit's files only when
 * that commit is an ancestor of what is bundled, which a start commit never
 * is, so each is named by its tree. A start commit only the agent's own
 * `.git` holds is not leaned on, since the agent may prune it. A later
 * pass needs none of this, since the previous pass holds every unchanged
 * file, and marking a whole start tree costs git a large repo's every tree.
 */
async function writeBundle(c: TreeContext, pass: string, not: string[]): Promise<string> {
  await mkdirOwned(c, path.join(c.ckpt, BUNDLES_DIR))
  const rel = `${BUNDLES_DIR}/${c.start.life}.${Date.now().toString(36)}.${pass.slice(0, 12)}.bundle`
  await git(c, ['update-ref', PASS_REF, pass])
  const excluded = not.length > 0 ? not : await mainCloneTrees(c)
  await writeDurably(c, path.join(c.ckpt, rel), (tmp) =>
    git(c, ['bundle', 'create', '-q', tmp, '--stdin'], { input: `${[PASS_REF, ...excluded.map((n) => `^${n}`)].join('\n')}\n` })
      .then(() => undefined))
  return rel
}

/** The object dir of a checkout's main clone, which its git dir's
 *  alternates name first, or null when they name none. */
async function mainObjects(co: StartCheckout): Promise<string | null> {
  const alternates = await fs.readFile(path.join(co.gitDir, 'objects', 'info', 'alternates'), 'utf8').catch(() => '')
  return alternates.split('\n')[0]?.trim() || null
}

/** The tree of each start commit its checkout's main clone holds, read
 *  without the scratch repository's own alternates, which reach the
 *  agent's objects too. */
async function mainCloneTrees(c: TreeContext): Promise<string[]> {
  const trees: string[] = []
  for (const co of c.start.checkouts) {
    const main = await mainObjects(co)
    if (!main || !co.commit) continue
    const tree = `${co.commit}^{tree}`
    if (await git(c, ['cat-file', '-e', tree], { env: { GIT_OBJECT_DIRECTORY: main } }).then(() => true, () => false)) trees.push(tree)
  }
  return trees
}

/** Whether the scratch repository has `sha`, its own or borrowed. */
async function has(c: TreeContext, sha: string): Promise<boolean> {
  return git(c, ['cat-file', '-e', `${sha}^{commit}`]).then(() => true, () => false)
}

/** The object dirs of every checkout's git dir. */
const checkoutObjects = (c: TreeContext): string[] => c.start.checkouts.map((co) => path.join(co.gitDir, 'objects'))

/**
 * Take one checkpoint pass. Writes a bundle of what changed and replaces the
 * life's manifest; a pass in which nothing changed (no tree and no HEAD)
 * writes nothing unless `final` needs recording. Returns the manifest as it
 * stands after the pass, or null when there is still none.
 */
export async function takePass(c: TreeContext, opts: { final?: boolean } = {}): Promise<Manifest | null> {
  const prev = await readOwnManifest(c)
  const objectDirs = checkoutObjects(c)
  await prepareScratch(c, objectDirs)
  const skip = [...c.start.excluded]
  const queue: LiveUnit[] = []
  if (!c.start.checkouts.some((co) => co.path === '')) {
    queue.push({ unit: { kind: 'root' }, worktree: c.tree, kept: [] })
    skip.push(...c.start.checkouts.map((co) => co.path))
  }
  for (const co of c.start.checkouts) {
    const head = await readHead(co.gitDir)
    if (head === null) continue
    queue.push({
      unit: { kind: 'checkout', path: co.path, id: co.id, head },
      worktree: path.join(c.tree, co.path), gitDir: co.gitDir,
      excludesFile: path.join(co.gitDir, 'info', 'exclude'), kept: co.kept,
    })
  }
  const units: SavedUnit[] = []
  const entries: string[] = []
  const unsaved: string[] = []
  /** A unit's entry in the previous pass, with the record it was saved
   *  under, whose HEAD is the one those files sit on. */
  const prevEntry = async (u: SavedUnit, suffix = ''): Promise<{ entry: string; unit: SavedUnit } | null> => {
    if (!prev) return null
    const i = prev.units.findIndex((p) => p.kind === u.kind && ('path' in p ? p.path : '') === ('path' in u ? u.path : ''))
    if (i < 0) return null
    const entry = await git(c, ['rev-parse', '--verify', '-q', `${prev.pass}^{tree}:${String(i)}${suffix}`]).then((s) => s.trim(), () => null)
    return entry === null ? null : { entry, unit: prev.units[i] }
  }
  /** Queue the nested repository or submodule at `treePath`, once. */
  const queued = new Set<string>()
  const enqueue = async (treePath: string): Promise<void> => {
    if (queued.has(treePath)) return
    queued.add(treePath)
    const child = await childUnit(c, treePath)
    if (child) queue.push(child)
  }
  for (let q = 0; q < queue.length && q < 10_000; q++) {
    const u = queue[q]
    const upath = 'path' in u.unit ? u.unit.path : ''
    if (u.unit.kind === 'submodule') objectDirs.push(path.join(u.gitDir as string, 'objects'))
    if (u.unit.kind === 'submodule') await prepareScratch(c, objectDirs)
    let files: string | null
    let gitTree: string | null = null
    let saved = u.unit
    let unborn: string[] = []
    try {
      const staged = await stageFiles(c, u, skip)
      files = staged.tree
      unborn = staged.unborn
      if (u.unit.kind === 'repo') gitTree = await stageGitDir(c, upath, path.join(u.worktree, '.git'))
    } catch (err) {
      const why = `could not save ${unitLabel(u.unit)}: ${err instanceof Error ? err.message : String(err)}`
      // A final pass is the life's last record, and its tree is removed
      // after it: one that cannot save everything fails, leaving the tree
      // for a salvage to try again.
      if (opts.final === true) throw new Error(why)
      // A repository changing under the pass (a gc, a repack) keeps its
      // last saved state, named as unsaved, and the next pass tries again.
      process.stderr.write(`yaac-tree: ${why}\n`)
      unsaved.push(upath)
      // The repositories it held in the last pass are saved as before, the
      // ones with no commit included, which no gitlink names.
      unborn = (prev?.units ?? []).flatMap((p) => (p.kind === 'repo' && p.path !== upath && under(p.path, upath) ? [relTo(p.path, upath)] : []))
      const before = await prevEntry(u.unit)
      const beforeGit = u.unit.kind === 'repo' ? await prevEntry(u.unit, '.git') : null
      if (before === null || (u.unit.kind === 'repo' && beforeGit === null)) {
        for (const rel of unborn) await enqueue(upath === '' ? rel : `${upath}/${rel}`)
        continue
      }
      files = before.entry
      gitTree = beforeGit?.entry ?? null
      saved = before.unit
    }
    const n = units.length
    units.push(saved)
    entries.push(`040000 tree ${files}\t${String(n)}`)
    if (gitTree !== null) entries.push(`040000 tree ${gitTree}\t${String(n)}.git`)
    // What this unit leaves out: excluded paths, and the checkouts inside
    // it, which are units of their own; never the unit's own path.
    const leftOut = skip.filter((s) => s !== upath && under(s, upath))
    for (const link of [...await gitlinks(c, u).catch(() => []), ...unborn]) {
      const treePath = upath === '' ? link : `${upath}/${link}`
      if (!leftOut.some((s) => under(treePath, s))) await enqueue(treePath)
    }
  }
  // Nothing could be saved this time: the checkpoint before stands.
  if (entries.length === 0) return prev
  const tree = (await git(c, ['mktree'], { input: `${entries.join('\n')}\n` })).trim()
  const heads = [...new Set(units.flatMap((u) => ('head' in u ? [u.head] : [])))]
  if (prev) {
    const prevTree = await git(c, ['rev-parse', `${prev.pass}^{tree}`]).then((s) => s.trim(), () => '')
    const prevHeads = [...new Set(prev.units.flatMap((u) => ('head' in u ? [u.head] : [])))]
    const same = prevTree === tree && prevHeads.length === heads.length && prevHeads.every((h) => heads.includes(h))
      && prev.life === c.start.life && JSON.stringify(prev.unsaved) === JSON.stringify(unsaved)
    if (same) {
      if (!opts.final || prev.final) return prev
      const m = { ...prev, final: true, takenAt: new Date().toISOString() }
      await writeManifest(c, m)
      return m
    }
  }
  // The previous pass is the only parent. Each checkout's HEAD is recorded
  // in the units, not as a parent: those commits live in the agent's own
  // .git, which may rewrite and prune them, and a chain that named them
  // could no longer be walked.
  const parents = []
  if (prev && await has(c, prev.pass)) parents.push(prev.pass)
  const pass = (await git(c, ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p])], {
    // The units go with the pass, so a restore that can read only part of a
    // chain knows what an earlier pass's entries are.
    input: `yaac checkpoint ${c.start.life}\n\n${UNITS_TRAILER}${JSON.stringify(units)}\n`,
    env: { GIT_AUTHOR_NAME: 'yaac', GIT_AUTHOR_EMAIL: 'yaac@localhost', GIT_COMMITTER_NAME: 'yaac', GIT_COMMITTER_EMAIL: 'yaac@localhost' },
  })).trim()
  const bundle = await writeBundle(c, pass, prev && parents.includes(prev.pass) ? [prev.pass] : [])
  const m: Manifest = {
    version: 1, life: c.start.life, takenAt: new Date().toISOString(), final: opts.final === true, pass,
    bundles: [...(prev?.bundles ?? []), bundle], units, unsaved,
  }
  const written = m.bundles.length > MAX_CHAIN ? await compactQuietly(c, m) : m
  await writeManifest(c, written)
  return written
}

/** Compact, keeping the chain as it is if that fails: a longer chain
 *  restores the same, while a failed compaction must not stop the pass. */
async function compactQuietly(c: TreeContext, m: Manifest): Promise<Manifest> {
  try {
    return await compactChain(c, m)
  } catch (err) {
    process.stderr.write(`yaac-tree: could not compact the chain: ${err instanceof Error ? err.message : String(err)}\n`)
    return m
  }
}

/** A header line as git accepts it: a prerequisite is `-`, an object id
 *  and an optional comment; a head is an object id and a ref name. */
const BUNDLE_LINE = /^(?:-([0-9a-f]{40}(?:[0-9a-f]{24})?)(?: |$)|([0-9a-f]{40}(?:[0-9a-f]{24})?) )/

/**
 * What a bundle's header says: the commits it leans on, the commits it
 * carries, and where its pack begins. A header git would refuse is refused
 * here, so that a damaged one fails a restore at its own bundle and is
 * never read again by the git commands that take a bundle whole.
 */
async function bundleHeader(fh: FileHandle): Promise<{ prerequisites: string[]; heads: string[]; packAt: number }> {
  const buf = Buffer.alloc(256 * 1024)
  const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
  // One byte a character, so an index is an offset in the file.
  const head = buf.subarray(0, bytesRead).toString('latin1')
  const end = head.indexOf('\n\n')
  const version = /^# v([23]) git bundle\n/.exec(head)?.[1]
  if (end < 0 || version === undefined) throw new Error('not a bundle')
  const prerequisites: string[] = []
  const heads: string[] = []
  for (const l of head.slice(0, end).split('\n').slice(1)) {
    // Only a v3 header carries capability lines.
    if (version === '3' && l.startsWith('@')) continue
    const m = BUNDLE_LINE.exec(l)
    if (!m) throw new Error(`not a bundle: unrecognized header line ${JSON.stringify(l.slice(0, 80))}`)
    if (m[1] !== undefined) prerequisites.push(m[1])
    else heads.push(m[2])
  }
  return { prerequisites, heads, packAt: end + 2 }
}

/**
 * Unpack one bundle of a chain into the scratch repository and return the
 * commits it carries. `have` holds the commits the bundles before it
 * carried.
 *
 * The header is read here and git is given the pack, with the command
 * `git bundle unbundle` itself ends in. `unbundle` would first walk
 * everything each prerequisite reaches, for every bundle, which is most of
 * a restore's time when the shared tier is a file server. A chain needs no
 * such walk: a bundle's prerequisite is the pass the bundle before it
 * carried in full. A damaged or cut-short file still fails here, since
 * `index-pack` checks every object and the pack's checksum, and a lost
 * bundle leaves the next one without its prerequisite.
 */
async function unpackBundle(c: TreeContext, file: string, have: Set<string>): Promise<string[]> {
  const fh = await fs.open(file, 'r')
  try {
    const { prerequisites, heads, packAt } = await bundleHeader(fh)
    for (const p of prerequisites) {
      if (!have.has(p) && !(await has(c, p))) throw new Error(`the commit it leans on, ${p}, is missing`)
    }
    // A read with no position moves the descriptor, here to the pack,
    // and git reads on from where it stands.
    await fh.read(Buffer.alloc(packAt), 0, packAt, null)
    await git(c, ['index-pack', '--fix-thin', '--stdin'], { stdin: fh.fd })
    return heads
  } finally {
    await fh.close()
  }
}

/**
 * Merge the small bundles at the end of the chain into one, whichever life
 * wrote them. A large bundle (a cloned repository's packs) is left as it
 * is, so it is never rewritten. The old files stay for the server to
 * remove. Runs during passes, never at a stop, whose grace period it
 * would spend: merging a bundle that holds a large file means reading
 * that file whole again.
 */
async function compactChain(c: TreeContext, m: Manifest): Promise<Manifest> {
  let i = m.bundles.length
  while (i > 0) {
    const size = (await fs.stat(path.join(c.ckpt, m.bundles[i - 1])).catch(() => null))?.size ?? Infinity
    if (size >= SMALL_BUNDLE_BYTES) break
    i--
  }
  if (m.bundles.length - i < 2) return m
  const first = await fs.open(path.join(c.ckpt, m.bundles[i]), 'r')
  const not = (await bundleHeader(first).finally(() => first.close())).prerequisites
  const merged = await writeBundle(c, m.pass, not).catch(async () => {
    // A pass stores no object git found in a borrowed object dir (a
    // checkout's own .git), which the agent may since have pruned; the
    // bundles hold every one, so take them from there and try again.
    for (const b of m.bundles.slice(i)) await git(c, ['bundle', 'unbundle', path.join(c.ckpt, b)])
    return writeBundle(c, m.pass, not)
  })
  return { ...m, bundles: [...m.bundles.slice(0, i), merged] }
}

/** Record the checkpoint as the life's last: a final pass, uncompacted. */
export async function finish(c: TreeContext): Promise<Manifest | null> {
  return takePass(c, { final: true })
}

/** Where the arborist's index of a checkout's tree is put, in the
 *  life's scratch folder (docs/generic-workspace-pods.md "Trees"). */
const arboristIndex = (c: TreeContext, co: StartCheckout): string => path.join(c.scratch, 'arborist', `${co.id}.index`)

/**
 * Write `treeish` into a checkout's tree, which holds the arborist's
 * build of its start commit, through the index named `idx`, which starts as
 * the arborist's: git writes only the paths that differ. Nothing has
 * run on the tree since the build (the take moves it straight into a life
 * no process has started in), so trusting whole-second mtime and size is
 * sound; with git's default checks every file would differ, since the
 * arborist's index carries the node's inode numbers.
 */
async function writeOnto(c: TreeContext, co: StartCheckout, idx: string, treeish: string): Promise<void> {
  const worktree = path.join(c.tree, co.path)
  await fs.copyFile(arboristIndex(c, co), indexFile(c, idx))
  await own(c, indexFile(c, idx))
  const env = { GIT_WORK_TREE: worktree, GIT_INDEX_FILE: indexFile(c, idx) }
  if (treeish !== co.commit) {
    await git(c, [
      '-c', 'core.checkStat=minimal', '-c', 'checkout.workers=8', '-c', 'checkout.thresholdForParallelism=100',
      'read-tree', '-u', '--reset', treeish,
    ], { asOwner: true, env })
  }
  if (await fs.stat(path.join(worktree, '.gitmodules')).then(() => true, () => false)) await pinGitlinks(c, env, worktree)
}

/**
 * Fill a new life's tree, which the arborist built at each checkout's
 * start commit: a checkout whose HEAD has moved from it since (a restart's)
 * gets the difference written, and the index is copied into its git dir as
 * the first index, with `core.checkStat=minimal` set there, since the
 * workspace container sees this tree under other inode numbers
 * (docs/node-local-workspaces.md "Start").
 */
export async function fill(c: TreeContext): Promise<void> {
  await prepareScratch(c, checkoutObjects(c))
  for (const co of c.start.checkouts) {
    const idx = key('checkout', co.path)
    await writeOnto(c, co, idx, (await readHead(co.gitDir)) ?? co.commit)
    const target = path.join(co.gitDir, 'index')
    await fs.copyFile(indexFile(c, idx), target)
    await own(c, target)
    await git(c, ['config', '--file', path.join(co.gitDir, 'config'), 'core.checkStat', 'minimal'], { asOwner: true })
  }
}

/** Raised when a chain does not verify: names the first unreadable bundle. */
export class ChainError extends Error {
  constructor(readonly bundle: string, readonly cause: unknown) {
    super(`checkpoint bundle ${bundle} does not verify`)
  }
}

/**
 * Restore the checkpoint `manifestRel` names into the tree: unpack its
 * chain, then write each unit outermost first, a checkout's onto the
 * arborist's build of its start commit (`writeOnto`), so only what
 * the checkpoint changed is written. A checkout whose HEAD moved
 * after the checkpoint gets the checkpoint merged onto its new HEAD, HEAD
 * winning every conflict. The life then starts its own manifest from that
 * chain, so a later pass writes only what changes.
 */
export async function restore(c: TreeContext, manifestRel: string, opts: { newestReadable?: boolean } = {}): Promise<Manifest | null> {
  let m = await readManifestAt(path.join(c.ckpt, manifestRel))
  if (!m) throw new ChainError(manifestRel, new Error('not a manifest'))
  const objectDirs = checkoutObjects(c)
  for (const u of m.units) {
    if (u.kind !== 'submodule') continue
    const co = c.start.checkouts.find((x) => x.id === u.checkout)
    if (co) objectDirs.push(path.join(co.gitDir, u.gitDir, 'objects'))
  }
  // A chain leans only on the main clones, so those are all the scratch
  // repository borrows from while it is unpacked: git looks through every
  // borrowed object dir for each object it unpacks, and each look into the
  // agent's is a round trip to the shared tier.
  const mains = await Promise.all(c.start.checkouts.map(mainObjects))
  await prepareScratch(c, mains.filter((d) => d !== null))
  const unpacked = new Set<string>()
  for (const [k, b] of m.bundles.entries()) {
    try {
      for (const pass of await unpackBundle(c, path.join(c.ckpt, b), unpacked)) unpacked.add(pass)
    } catch (err) {
      if (!opts.newestReadable) throw new ChainError(b, err)
      // Asked for the newest state that verifies: the unreadable bundle is
      // moved aside, never deleted, and the chain before it is restored,
      // or nothing when even its first bundle is unreadable.
      await fs.rename(path.join(c.ckpt, b), path.join(c.ckpt, `${b}.unreadable`)).catch(() => {})
      const older = k === 0 ? null : await chainManifest(c, m.bundles.slice(0, k))
      if (!older) return null
      m = older
      break
    }
  }
  await prepareScratch(c, objectDirs)
  for (const [n, u] of m.units.entries()) {
    const entry = `${m.pass}^{tree}:${String(n)}`
    switch (u.kind) {
      case 'root':
        await writeTree(c, c.tree, key('root', ''), entry)
        break
      case 'checkout': {
        const co = c.start.checkouts.find((x) => x.id === u.id)
        if (!co) break
        await writeOnto(c, co, key('checkout', co.path), await ontoHead(c, co.gitDir, u.head, entry))
        break
      }
      case 'submodule': {
        const co = c.start.checkouts.find((x) => x.id === u.checkout)
        if (!co) break
        const gitDir = path.join(co.gitDir, u.gitDir)
        await writeTree(c, path.join(c.tree, u.path), key('submodule', u.path), await ontoHead(c, gitDir, u.head, entry))
        break
      }
      case 'repo': {
        await writeTree(c, path.join(c.tree, u.path), key('repo', u.path), entry)
        const idx = key('repo.git', u.path)
        await writeTree(c, path.join(c.tree, u.path, '.git'), idx, `${m.pass}^{tree}:${String(n)}.git`)
        const env = { GIT_WORK_TREE: path.join(c.tree, u.path, '.git'), GIT_INDEX_FILE: indexFile(c, idx) }
        const objects = (await git(c, ['ls-files', '-z', '--', ':(literal)objects'], { env })).split('\0').filter(Boolean)
        if (objects.length > 0) {
          await git(c, ['update-index', '-z', '--assume-unchanged', '--stdin'], { env, input: `${objects.join('\0')}\0` })
        }
        // git saves no empty folder, and a git dir is not one without these
        // (a repository with no commit has nothing in them).
        for (const d of ['objects', 'refs']) await mkdirOwned(c, path.join(c.tree, u.path, '.git', d))
        break
      }
    }
  }
  // A checkout the checkpoint does not know (a repo added since) starts at
  // its HEAD.
  for (const co of c.start.checkouts) {
    if (!m.units.some((u) => u.kind === 'checkout' && u.id === co.id)) {
      await writeOnto(c, co, key('checkout', co.path), (await readHead(co.gitDir)) ?? co.commit)
    }
  }
  const mine: Manifest = { ...m, life: c.start.life, final: false, takenAt: new Date().toISOString() }
  await writeManifest(c, mine)
  return mine
}

/** The manifest of the pass a chain's last bundle holds, from the units its
 *  commit carries, or null when it carries none. */
async function chainManifest(c: TreeContext, chain: string[]): Promise<Manifest | null> {
  const heads = await git(c, ['bundle', 'list-heads', path.join(c.ckpt, chain[chain.length - 1])]).catch(() => '')
  const pass = heads.split('\n')[0]?.split(' ')[0] ?? ''
  if (!pass) return null
  const body = await git(c, ['log', '-1', '--format=%B', pass]).catch(() => '')
  const units = body.split('\n').find((l) => l.startsWith(UNITS_TRAILER))?.slice(UNITS_TRAILER.length)
  if (units === undefined) return null
  const date = (await git(c, ['log', '-1', '--format=%cI', pass]).catch(() => '')).trim()
  return parseManifest(JSON.stringify({
    version: 1, life: c.start.life, takenAt: date || new Date().toISOString(), final: false, pass, bundles: chain,
    units: JSON.parse(units) as unknown, unsaved: [],
  }))
}

/** The tree to write for a checkout saved on `saved`'s HEAD: the saved
 *  tree, or merged onto the HEAD it has now when that moved. */
async function ontoHead(c: TreeContext, gitDir: string, saved: string, entry: string): Promise<string> {
  const now = await readHead(gitDir)
  if (now === null || now === saved || !(await has(c, now)) || !(await has(c, saved))) return entry
  const ident = { GIT_AUTHOR_NAME: 'yaac', GIT_AUTHOR_EMAIL: 'yaac@localhost', GIT_COMMITTER_NAME: 'yaac', GIT_COMMITTER_EMAIL: 'yaac@localhost' }
  const ckpt = (await git(c, ['commit-tree', entry, '-p', saved], { input: 'yaac checkpoint\n', env: ident })).trim()
  const out = await git(c, ['merge-tree', '--write-tree', '-X', 'ours', `--merge-base=${saved}`, now, ckpt], { ok: [1], env: ident })
  return out.split('\n')[0].trim()
}

/** Make the folders the workspace container mounts over inside the tree:
 *  each checkout's `.git` and each excluded path. */
export async function makeMountPoints(c: TreeContext): Promise<void> {
  for (const co of c.start.checkouts) await mkdirOwned(c, path.join(c.tree, co.path, '.git'))
  for (const p of c.start.excluded) await mkdirOwned(c, path.join(c.tree, p))
}

/** Remove everything in the tree and the scratch repository. */
export async function removeLife(c: TreeContext): Promise<void> {
  for (const dir of [c.tree, c.scratch]) {
    for (const name of await fs.readdir(dir).catch(() => [])) {
      await fs.rm(path.join(dir, name), { recursive: true, force: true })
    }
  }
}
