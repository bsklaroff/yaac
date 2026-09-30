import fs from 'node:fs/promises'
import path from 'node:path'
import { createKeyedMutex } from '#lib/keyed-mutex'
import { readRepoConfig, runGit } from './run'
import { NEVER_PRUNE_KEYS, ensureNeverPrune, initClone, mainRefs, stagingGitDir } from './repo'

/**
 * The conversion of a checkout made before workspaces were clones — a `git
 * worktree add` linked checkout whose git state lives in the main clone's
 * `worktrees/<id>` — into one (docs/legacy-compat-shims.md). Everything here
 * reads state a legacy pod could write, so it goes through the hardened
 * runner, copies only regular files, and never follows a link.
 */

/** One conversion per checkout at a time: the startup sweep and a restart
 *  can reach the same one together, and both stage in the same place. */
const adopting = createKeyedMutex()

/** The admin dir entries that describe the link itself, not the checkout. */
const LINK_FILES = new Set(['gitdir', 'commondir', 'locked'])

/**
 * Convert the stopped linked checkout at `workspacePath` into a clone, in
 * place, keeping its index, HEAD, reflog and any in-progress merge or rebase.
 * A no-op for a checkout that already is one. Idempotent at every step, so a
 * crash anywhere is finished by the next call. Must not run while a pod
 * still has the checkout.
 *
 * The admin dir is found by workspace id, never through the `.git` file,
 * which names it as whichever substrate last launched the checkout saw it —
 * for one last run in a pod, a path that resolves nowhere here.
 *
 * Local branches were one namespace shared by every workspace of the project
 * and cannot be attributed, so each converted clone gets all of them — bar
 * the `agent/<id>` of the project's OTHER rows (`rowIds`), which their own
 * conversion carries — and a copy of the stash. Every other `agent/*`
 * comes along too: an agent's `agent/<id>-wip`, a user's `agent/foo`, and
 * the branches of workspaces deleted before the upgrade, which nothing else
 * still names. The agent's commits stay in the main clone's objects,
 * borrowed like everything else — safe because `ensureNeverPrune` has run
 * first.
 *
 * The main clone's `agent/<id>` is dropped only once a clone holds it. A
 * checkout whose `.git` is gone loses just its admin dir, which is what
 * would hold up the sanitize; its branch stays the one name its commits
 * have.
 */
export function adoptLinkedCheckout(
  repoPath: string,
  workspacePath: string,
  workspaceId: string,
  remoteUrl: string,
  rowIds: ReadonlySet<string>,
): Promise<void> {
  return adopting(workspacePath, () => adopt(repoPath, workspacePath, workspaceId, remoteUrl, rowIds))
}

async function adopt(
  repoPath: string,
  workspacePath: string,
  workspaceId: string,
  remoteUrl: string,
  rowIds: ReadonlySet<string>,
): Promise<void> {
  const dotGit = path.join(workspacePath, '.git')
  const linked = path.join(workspacePath, '.git.linked')
  const kind = async (p: string): Promise<'dir' | 'file' | null> => {
    const st = await fs.lstat(p).catch(() => null)
    return st === null ? null : st.isDirectory() ? 'dir' : 'file'
  }
  const admin = path.join(repoPath, '.git', 'worktrees', workspaceId)
  if (await kind(dotGit) === 'dir') {
    // Converted; a crash between the swap and the cleanup leaves this.
    await fs.rm(linked, { force: true })
  } else if (await kind(dotGit) !== null || await kind(linked) !== null) {
    await ensureNeverPrune(repoPath)
    const branch = `agent/${workspaceId}`
    const gitDir = stagingGitDir(workspacePath)
    await fs.rm(path.dirname(gitDir), { recursive: true, force: true })
    await fs.mkdir(path.dirname(gitDir), { recursive: true })
    try {
      const merge = (await readRepoConfig(repoPath, `branch.${branch}.merge`)).at(-1)
      // Pod-written: only a plain branch name comes back out.
      const base = merge?.match(/^refs\/heads\/([^\s~^:?*[\\]+)$/)?.[1] ?? null
      const { refs, originHead } = await mainRefs(repoPath, [
        'refs/remotes/origin', 'refs/tags', 'refs/heads', 'refs/stash',
      ])
      await initClone(repoPath, gitDir, {
        remoteUrl,
        branch,
        baseBranch: base,
        refs: refs.filter((l) => {
          const other = /^refs\/heads\/agent\/(.+)$/.exec(l.slice(l.indexOf(' ') + 1))?.[1]
          return other === undefined || other === workspaceId || !rowIds.has(other)
        }),
        originHead,
      })
      // HEAD as the admin dir has it, else on the workspace's own branch.
      await runGit({ kind: 'private', gitDir }, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`])
      if (!await copyRegularFiles(admin, gitDir, '')) {
        // No admin dir, so no index: one read from HEAD, rather than a
        // checkout whose every tracked file reads as deleted.
        await runGit({ kind: 'private', gitDir, workTree: workspacePath }, ['read-tree', 'HEAD'])
      }
      await copyRegularFiles(path.join(repoPath, '.git', 'logs', 'refs'), path.join(gitDir, 'logs', 'refs'), '', (rel) =>
        rel === 'stash' || rel === `heads/${branch}`)
      // The swap: a crash after the first rename leaves `.git.linked` and no
      // `.git`, which the next call resumes from here.
      if (await kind(dotGit) === 'file') await fs.rename(dotGit, linked)
      await fs.rename(gitDir, dotGit)
      await fs.rm(linked, { force: true })
    } finally {
      await fs.rm(path.dirname(gitDir), { recursive: true, force: true })
    }
  }
  // What the main clone kept for the checkout — the admin dir also when
  // there is no checkout left to convert, so a vanished one cannot hold up
  // the sanitize; the branch only once a clone holds it.
  if (await kind(admin) === null) return
  await fs.rm(admin, { recursive: true, force: true })
  if (await kind(dotGit) !== 'dir') return
  await runGit({ kind: 'repo', repoPath }, ['update-ref', '-d', `refs/heads/agent/${workspaceId}`]).catch(() => {})
}

/**
 * Copy every regular file under `from/rel` to the same place under `to`,
 * skipping links and the link files, creating directories as needed.
 * `keep`, when given, picks which files (by path relative to `from`) come
 * along. Answers whether `from/rel` existed.
 */
async function copyRegularFiles(
  from: string,
  to: string,
  rel: string,
  keep: (rel: string) => boolean = (r) => !LINK_FILES.has(r),
): Promise<boolean> {
  const entries = await fs.readdir(path.join(from, rel), { withFileTypes: true }).catch(() => null)
  if (entries === null) return false
  for (const e of entries) {
    const child = rel === '' ? e.name : `${rel}/${e.name}`
    if (e.isDirectory()) {
      await copyRegularFiles(from, to, child, keep)
    } else if (e.isFile() && keep(child)) {
      await fs.mkdir(path.dirname(path.join(to, child)), { recursive: true })
      await fs.copyFile(path.join(from, child), path.join(to, child))
    }
  }
  return true
}

/** The main clone's config keys that survive `sanitizeMainClone`. */
const SANITIZED_KEYS = /^(core\.(repositoryformatversion|bare|logallrefupdates)|extensions\.objectformat)$/

/**
 * Once no linked checkout a row still owns is left in the main clone, make
 * it the server's alone (docs/legacy-compat-shims.md): no pod can write it
 * from here on, so whatever a pod ever wrote into it goes. Refuses a
 * `.git` holding any symlink. Answers whether the clone is (now) clean; a
 * project with no `worktrees/` never held a linked checkout, or was
 * sanitized already.
 */
export async function sanitizeMainClone(
  repoPath: string,
  remoteUrl: string,
  ownedIds: ReadonlySet<string>,
): Promise<boolean> {
  const gitDir = path.join(repoPath, '.git')
  const admins = await fs.readdir(path.join(gitDir, 'worktrees')).catch(() => null)
  if (admins === null) return true
  if (admins.some((id) => ownedIds.has(id))) return false

  await assertNoLinks(gitDir)
  const config = path.join(gitDir, 'config')
  const entries = (await runGit({ kind: 'none' }, ['config', '--file', config, '--no-includes', '--null', '--list']))
    .split('\0').filter((e) => e.includes('\n'))
    .map((e) => [e.slice(0, e.indexOf('\n')), e.slice(e.indexOf('\n') + 1)] as const)
    .filter(([key]) => SANITIZED_KEYS.test(key))
  const fresh = `${config}.sanitized`
  await fs.writeFile(fresh, '')
  for (const [key, value] of [
    ...entries,
    ['remote.origin.url', remoteUrl],
    ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
    ...NEVER_PRUNE_KEYS.map((k) => [k, 'never'] as const),
  ]) {
    await runGit({ kind: 'none' }, ['config', '--file', fresh, key, value])
  }
  await fs.rename(fresh, config)
  for (const p of ['hooks', 'info/attributes', 'objects/info/alternates', 'worktrees']) {
    await fs.rm(path.join(gitDir, p), { recursive: true, force: true })
  }
  return true
}

/** Refuse a git dir with a symlink anywhere in it. */
async function assertNoLinks(dir: string): Promise<void> {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isSymbolicLink()) throw new Error(`refusing to sanitize ${dir}: ${p} is a symlink`)
    if (e.isDirectory()) await assertNoLinks(p)
  }
}
