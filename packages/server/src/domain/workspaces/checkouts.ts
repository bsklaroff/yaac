import fs from 'node:fs/promises'
import path from 'node:path'
import { repoDir, workspaceDir } from '@yaac/shared/project-paths'
import { isBranchName } from '@yaac/shared/git'
import { ServerError } from '@yaac/shared/errors'
import type { RepoSelection, RepoStart } from '@yaac/shared/types'
import {
  applyWorkspaceEvent,
  getRepo,
  listWorkspaceRepos,
  type ProjectRepoLink,
  type ProjectRow,
  type RepoRow,
} from '#db'
import { createCheckout, getDefaultBranch, isGitAuthError, remoteBranchExists } from '#domain/git'
import { projectRepo } from '#domain/projects'
import { fetchRepoCommit, seedRepoOrigin } from '#domain/repos'

/*
 * A workspace's checkouts (docs/project-repos.md "Workspace layout"): what
 * a create starts with, resolved against its project, and the leg that
 * makes or reuses each one. A workspace has none, one at its root, or each
 * in a folder of its own.
 */

/** One repo a fresh workspace starts with. */
export interface StartRepo {
  link: ProjectRepoLink
  /** Where its checkout sits under the workspace root: `''` or the link's
   *  folder. */
  path: string
  /** The branch the request named (no `origin/` prefix), or the full commit
   *  to start at; neither starts at the remote's default branch. */
  branch?: string
  commit?: string
}

/** What a fresh workspace starts with: its repos, their layout, and where
 *  its agent runs, relative to the workspace root. */
export interface WorkspaceStart {
  repos: StartRepo[]
  nested: boolean
  cwd: string
}

/** A create-shaped request's selection (`repoSelectionShape`). */
export interface StartRequest {
  repos?: RepoStart[]
  nested?: boolean
  cwd?: string
  branch?: string
  commit?: string
}

/**
 * Resolve what a create starts with against its project, field by field:
 * the request's choice, else what the project last used
 * (docs/project-repos.md "Remembered create settings").
 *
 * - Repos: the ones named, by folder or id, else those the last create
 *   included, each at its default branch. `branch` and `commit` are the
 *   start of a selection of exactly one repo.
 * - Layout: several repos always nest; one nests when asked, else as the
 *   last create did.
 * - Cwd: `.` for the workspace root or a selected repo, else the remembered
 *   one when that repo is selected, else a lone repo's folder, else the
 *   root.
 */
export function resolveStart(project: ProjectRow, request: StartRequest): WorkspaceStart {
  const named = request.repos !== undefined
  const picked: Array<{ link: ProjectRepoLink; branch?: string; commit?: string }> = named
    ? (request.repos ?? []).map(({ repo, branch, commit }) => ({
      link: projectRepo(project, repo),
      ...(branch !== undefined ? { branch } : {}),
      ...(commit !== undefined ? { commit } : {}),
    }))
    : project.repos.filter((l) => l.lastIncluded).map((link) => ({ link }))
  if (new Set(picked.map((p) => p.link.repo.id)).size !== picked.length) {
    throw new ServerError('VALIDATION', 'a repo is selected twice')
  }
  if (request.branch !== undefined || request.commit !== undefined) {
    if (picked.length !== 1 || picked[0].branch !== undefined || picked[0].commit !== undefined) {
      throw new ServerError('VALIDATION', 'a branch or commit on its own names the start of exactly one repo; '
        + `this selects ${picked.length}. Name each repo's start with it instead.`)
    }
    if (request.branch !== undefined) picked[0].branch = request.branch
    if (request.commit !== undefined) picked[0].commit = request.commit
  }
  for (const { link, branch, commit } of picked) {
    if (branch !== undefined && commit !== undefined) {
      throw new ServerError('VALIDATION', `${link.dir}: name a branch or a commit, not both`)
    }
    if (branch !== undefined && !isBranchName(branch)) {
      throw new ServerError('VALIDATION', `${link.dir}: "${branch}" is not a branch name`)
    }
  }
  if (picked.length > 1 && request.nested === false) {
    throw new ServerError('VALIDATION', 'several repos always sit in folders of their own')
  }
  const nested = picked.length > 1 || (picked.length === 1 && (request.nested ?? project.lastNested ?? false))
  const repos = picked.map((p) => ({ ...p, path: nested ? p.link.dir : '' }))
  return { repos, nested, cwd: startCwd(project, repos, request.cwd) }
}

function startCwd(project: ProjectRow, repos: StartRepo[], requested: string | undefined): string {
  const at = (ref: string): StartRepo | undefined =>
    repos.find((r) => r.link.dir === ref) ?? repos.find((r) => r.link.repo.id === ref)
  if (requested !== undefined) {
    if (requested === '.') return ''
    const repo = at(requested)
    if (!repo) throw new ServerError('VALIDATION', `the cwd "${requested}" is not "." or a repo this workspace starts with`)
    return repo.path
  }
  if (project.lastCwd === '.') return ''
  const remembered = project.lastCwd !== undefined ? at(project.lastCwd) : undefined
  return remembered?.path ?? (repos.length === 1 ? repos[0].path : '')
}

/** A resolved start as queued entries, routines and the project's
 *  remembered settings keep it: repos by id, the cwd as a repo id or `.`. */
export function storedSelection(start: WorkspaceStart): RepoSelection {
  return {
    repos: start.repos.map(({ link, branch, commit }) => ({
      repo: link.repo.id,
      ...(branch !== undefined ? { branch } : {}),
      ...(commit !== undefined ? { commit } : {}),
    })),
    nested: start.nested,
    cwd: start.repos.find((r) => r.path === start.cwd && (start.cwd !== '' || !start.nested))?.link.repo.id ?? '.',
  }
}

/** One checkout of a workspace as the server addresses it. */
export interface Checkout {
  repo: RepoRow
  /** Where it sits under the workspace root: `''` or its folder. */
  path: string
  /** The checkout on the server's disk. */
  dir: string
  /** The main clone's `.git`, at the same path in a pod. */
  mainGitDir: string
  baseBranch?: string
  startCommit?: string
}

/** Where a checkout at `relPath` is on the server's disk. */
export function checkoutDir(projectId: string, workspaceId: string, relPath: string): string {
  return path.join(workspaceDir(projectId, workspaceId), relPath)
}

/** A workspace's checkouts as its rows record them, the root's first. A
 *  repo whose row is gone is skipped: a row outlives its repo's deletion while
 *  a checkout holds it. */
export async function workspaceCheckouts(projectId: string, workspaceId: string): Promise<Checkout[]> {
  const rows = await listWorkspaceRepos(workspaceId)
  const checkouts = await Promise.all(rows.map(async (row): Promise<Checkout[]> => {
    const repo = await getRepo(row.repoId)
    return repo
      ? [{
        repo,
        path: row.path,
        dir: checkoutDir(projectId, workspaceId, row.path),
        mainGitDir: path.join(repoDir(repo.id), '.git'),
        ...(row.baseBranch !== undefined ? { baseBranch: row.baseBranch } : {}),
        ...(row.startCommit !== undefined ? { startCommit: row.startCommit } : {}),
      }]
      : []
  }))
  return checkouts.flat()
}

/**
 * The checkout a repo-scoped request means: the one at `at` (its path, or
 * its repo's id), or with no `at` the workspace's only one. A workspace
 * with several needs the `at`.
 */
export function checkoutAt<C extends { path: string; repo: { id: string } }>(checkouts: C[], at?: string): C {
  if (at !== undefined) {
    const found = checkouts.find((c) => c.path === at) ?? checkouts.find((c) => c.repo.id === at)
    if (!found) throw new ServerError('NOT_FOUND', `this workspace has no checkout at "${at}"`)
    return found
  }
  if (checkouts.length === 1) return checkouts[0]
  throw new ServerError('VALIDATION', checkouts.length === 0
    ? 'this workspace has no repos'
    : `this workspace has several repos; name one of: ${checkouts.map((c) => c.path).join(', ')}`)
}

/**
 * The directories an agent of a workspace can run in, relative to its
 * root: the root and each checkout in a folder. Each carries the repo whose
 * checkout it is, which decides claude's memory there.
 */
export function workspaceCwds(checkouts: Array<{ path: string; repo: { id: string } }>): Array<{ cwd: string; repoId?: string }> {
  const root = checkouts.find((c) => c.path === '')
  return [
    { cwd: '', ...(root ? { repoId: root.repo.id } : {}) },
    ...checkouts.filter((c) => c.path !== '').map((c) => ({ cwd: c.path, repoId: c.repo.id })),
  ]
}

/** Refuse a resume's checkout over `dir` if it holds the user's files. */
export async function refuseCheckingOutOver(dir: string): Promise<void> {
  if (!await holdsFiles(dir)) return
  throw new ServerError(
    'CONFLICT',
    `${dir} holds files but no .git, so restarting would check out over them. `
    + 'Restore its .git or move the files aside, then restart.',
  )
}

/** Whether `dir` holds anything but empty directories; a missing one holds
 *  nothing. Links count as files and are not followed. */
async function holdsFiles(dir: string): Promise<boolean> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  })
  for (const e of entries) {
    if (!e.isDirectory() || await holdsFiles(path.join(dir, e.name))) return true
  }
  return false
}

/** One checkout a launch makes or reuses. */
export interface PlannedCheckout {
  repo: RepoRow
  path: string
  dir: string
  /** A resume found its `.git`, so it is used as it stands. */
  reuse: boolean
  /** The branch the user named, checked once the fetch lands. On a resume,
   *  the recorded base branch, used only if the checkout is gone. */
  branch?: string
  /** The branch a fresh create forks from: `branch`, else the remote's
   *  default. Absent on a resume and at a commit. */
  refBranch?: string
  /** A full commit to create the checkout at, in place of a branch's tip.
   *  On a resume, the recorded start commit of a checkout with no base
   *  branch, used only if the checkout is gone. */
  commit?: string
  /** On a resume, the commit it was first created at, whatever its base. */
  startCommit?: string
}

/**
 * Make one checkout, or reuse it, once `fetched` (the fetch of its main
 * clone) allows. First it gives an origin with no branches its default one,
 * so no workspace's push picks it (`seedEmptyOrigin`); that push changes
 * the remote, so callers start this only once their own checks have passed.
 *
 * - A reused checkout is left as it stands.
 * - At a commit, the commit is fetched if the main clone lacks it.
 * - From a branch, a fresh create checks out what the main clone has while
 *   the fetch runs, and checks a named branch once it lands.
 * - A resume whose checkout is gone recreates it from its recorded base
 *   branch, or from the default if origin no longer has that, which is then
 *   recorded as its base branch.
 *
 * A checkout whose repo was deleted has no remote: it is reused as it
 * stands, and one that is gone cannot be made again.
 *
 * Resolves with the commit the checkout was created at, undefined for a
 * reused one.
 */
export async function provisionCheckout(args: {
  projectId: string
  workspaceId: string
  checkout: PlannedCheckout
  resume: boolean
  fetched: Promise<void>
  gitUser: { name: string; email: string }
  emit: (message: string) => void
  /** Make only the `.git`; the tree is checked out on the node. */
  gitOnly?: boolean
}): Promise<string | undefined> {
  const { projectId, workspaceId, checkout, resume, fetched, gitUser, emit } = args
  const { repo, dir, refBranch } = checkout
  const main = repoDir(repo.id)
  const label = checkout.path === '' ? 'workspace' : checkout.path
  if (repo.deletedAt !== undefined) {
    if (!checkout.reuse) {
      throw new ServerError('VALIDATION', `${dir} is gone, and ${repo.remoteUrl} was deleted by its owner, `
        + 'so it cannot be checked out again')
    }
    emit(`Reusing existing ${label} at ${dir}, whose repo was deleted`)
    return undefined
  }
  const seeded = fetched.then(() => seedRepoOrigin(repo.id, gitUser).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    if (isGitAuthError(msg)) {
      throw new ServerError(
        'VALIDATION',
        `${repo.remoteUrl} is empty, and its git credential cannot push the first commit `
        + 'that gives it a default branch. Give the credential push access, or push a first '
        + 'commit to the default branch yourself, then retry.',
      )
    }
    throw new ServerError('INTERNAL', `could not give the empty remote its default branch: ${msg}`)
  }))
  if (checkout.reuse) {
    await seeded
    emit(`Reusing existing ${label} at ${dir}`)
    return undefined
  }
  const params = {
    branch: `agent/${workspaceId}`,
    remoteUrl: repo.remoteUrl,
    // Beside the workspace dir, where no workspace mounts it.
    staging: path.join(path.dirname(workspaceDir(projectId, workspaceId)), `.staging-${workspaceId}-${repo.id}`),
    ...(args.gitOnly === true ? { gitOnly: true } : {}),
  }
  const { commit } = checkout
  if (commit !== undefined && (!resume || checkout.branch === undefined)) {
    await seeded
    await fetchRepoCommit(repo.id, commit).catch((err: unknown) => {
      throw new ServerError('VALIDATION', err instanceof Error ? err.message : String(err))
    })
    if (resume) await refuseCheckingOutOver(dir)
    emit(`Creating ${label} at ${commit.slice(0, 12)}...`)
    return createCheckout(main, dir, { ...params, commit })
  }
  if (refBranch !== undefined) {
    emit(`Creating ${label} from ${refBranch}...`)
    const named = checkout.branch
    return createCheckout(main, dir, {
      ...params,
      baseBranch: refBranch,
      fetched: seeded.then(async () => {
        if (named === undefined || await remoteBranchExists(main, named)) return
        throw new ServerError('VALIDATION', `branch "${named}" not found on origin of ${repo.remoteUrl}.`)
      }),
    })
  }
  await seeded
  const base = checkout.branch !== undefined && !(await remoteBranchExists(main, checkout.branch))
    ? await getDefaultBranch(main)
    : checkout.branch ?? await getDefaultBranch(main)
  if (base !== checkout.branch) {
    await applyWorkspaceEvent({ type: 'base-branch-resolved', projectId, workspaceId, repoId: repo.id, baseBranch: base })
  }
  // Again, since files may have landed while the fetch ran; the scratch
  // dirs made since are empty, so they do not count.
  await refuseCheckingOutOver(dir)
  emit(`Creating ${label} from ${base}...`)
  return createCheckout(main, dir, { ...params, baseBranch: base })
}
