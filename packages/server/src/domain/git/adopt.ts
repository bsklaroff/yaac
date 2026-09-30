import fs from 'node:fs/promises'
import path from 'node:path'
import { createKeyedMutex } from '#lib/keyed-mutex'
import { readRepoConfig, runGit } from './run'
import { NEVER_PRUNE_KEYS, ensureNeverPrune, initClone, mainRefs, stagingGitDir } from './repo'

/**
 * Converts a legacy linked checkout (`git worktree add`, with its git state
 * in the main clone's `worktrees/<id>`) into a standalone clone
 * (docs/legacy-compat-shims.md). A legacy pod could have written this state,
 * so everything goes through the hardened runner, copies only regular files,
 * and never follows a link.
 */

/** One conversion per checkout at a time: the startup sweep and a restart
 *  may race, and both stage in the same place. */
const adopting = createKeyedMutex()

/** The admin dir entries that describe the link itself, not the checkout. */
const LINK_FILES = new Set(['gitdir', 'commondir', 'locked'])

/**
 * Convert the stopped linked checkout at `workspacePath` into a clone in
 * place, keeping its index, HEAD, reflog and any in-progress merge or rebase.
 * A no-op if already converted. Every step is idempotent, so a crash is
 * finished by the next call. Must not run while a pod uses the checkout.
 *
 * The admin dir is found by workspace id, not through the `.git` file, whose
 * path may be the one a pod saw.
 *
 * Local branches were shared by all the project's workspaces and can't be
 * attributed, so each converted clone gets all of them (except other rows'
 * `agent/<id>`, which their own conversion carries) plus a copy of the
 * stash. Commits stay in the main clone's objects and are borrowed, which is
 * safe because `ensureNeverPrune` runs first.
 *
 * The main clone's `agent/<id>` is deleted only once a clone holds it. If the
 * checkout's `.git` is gone, only the admin dir is removed (so it doesn't
 * block the sanitize) and the branch is kept.
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
      // Default HEAD to the workspace's branch; the admin dir's copy below
      // overrides it.
      await runGit({ kind: 'private', gitDir }, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`])
      if (!await copyRegularFiles(admin, gitDir, '')) {
        // No admin dir means no index: build one from HEAD, or every tracked
        // file would read as deleted.
        await runGit({ kind: 'private', gitDir, workTree: workspacePath }, ['read-tree', 'HEAD'])
      }
      await copyRegularFiles(path.join(repoPath, '.git', 'logs', 'refs'), path.join(gitDir, 'logs', 'refs'), '', (rel) =>
        rel === 'stash' || rel === `heads/${branch}`)
      // A crash after the first rename leaves `.git.linked` and no `.git`,
      // which the next call resumes from.
      if (await kind(dotGit) === 'file') await fs.rename(dotGit, linked)
      await fs.rename(gitDir, dotGit)
      await fs.rm(linked, { force: true })
    } finally {
      await fs.rm(path.dirname(gitDir), { recursive: true, force: true })
    }
  }
  // Remove the main clone's admin dir (even if the checkout is gone, so it
  // can't block the sanitize), and the branch only once a clone holds it.
  if (await kind(admin) === null) return
  await fs.rm(admin, { recursive: true, force: true })
  if (await kind(dotGit) !== 'dir') return
  await runGit({ kind: 'repo', repoPath }, ['update-ref', '-d', `refs/heads/agent/${workspaceId}`]).catch(() => {})
}

/**
 * Copy every regular file under `from/rel` to the same place under `to`,
 * skipping symlinks and (by default) the link files. `keep` filters by path
 * relative to `from`. Returns whether `from/rel` existed.
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
 * Once no row owns a linked checkout of the main clone, strip everything a
 * pod could have written into it: config is rebuilt from an allowlist, and
 * hooks, attributes, alternates and `worktrees/` are removed
 * (docs/legacy-compat-shims.md). Refuses a `.git` containing a symlink.
 * Returns whether the clone is clean; one with no `worktrees/` already is.
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
