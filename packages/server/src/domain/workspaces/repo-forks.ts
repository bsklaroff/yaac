import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { workspaceDriver } from '#drivers/driver'
import {
  adoptUpstreamRemote,
  getRepo,
  hostRepoWithUpstream,
  listProjectRows,
  listQueuedWorkspaceRows,
  listRoutineRows,
  listWorkspaceReposFor,
  removeRepoShares,
  updateRepoSettings,
  type RepoRow,
} from '#db'
import { pushCredentialsToRuntime } from '#domain/auth'
import {
  compareRemoteBranches,
  fillHostedRepo,
  getDefaultBranch,
  initHostedRepo,
  isGitAuthError,
  probePushAccess,
  pushMainBranches,
  setUpstreamRefs,
} from '#domain/git'
import {
  ensureMainClone,
  fetchRepoOrigin,
  fetchRepoUpstream,
  ownRepo,
  probeRepoPushAccess,
  resolveRepoCredential,
  withRepoHeld,
} from '#domain/repos'
import { withProjectsHeld, type Actor } from '#domain/access'
import { serverLog } from '#lib/log'
import { ServerError } from '@yaac/shared/errors'
import { isBranchName } from '@yaac/shared/git'
import { hostedRemoteUrl } from '@yaac/shared/hosted-git'
import { globalTrashDir, hostedRepoDir, repoDir } from '@yaac/shared/project-paths'
import { moveToTrash } from '#lib/trash'
import type { RepoHostPreview, RepoMovePreview, UpstreamMoveBranch } from '@yaac/shared/types'
import { startWaitingWorkspaces } from './queued-workspaces'
import {
  handOverToLinkers,
  holdersOf,
  movePreviewOf,
  projectsLinking,
  reapSparesWith,
  stopProvisioningWith,
  stopWorkspaces,
} from './repo-teardown'

/*
 * The moves between a repo's shapes that stop workspaces
 * (docs/repo-forks.md): onto yaac, which makes a repo on a git host a local
 * fork of the remote it leaves, and back onto a fork's upstream. Both keep
 * the repo's id and main clone, so everything that names the repo follows
 * it, and a stopped k8s workspace's checkpoints, which lean on the main
 * clone, stay restorable.
 */

/**
 * Run `fn` holding the repo and every project that links it, after
 * stopping every workspace holding a checkout of it and reaping the spares
 * warmed with it. Queued workspaces that waited out the hold start once it
 * lifts.
 */
async function withRepoStopped<T>(repoId: string, reason: string, fn: () => Promise<T>): Promise<T> {
  await workspaceDriver().ensureRuntimeReachable()
  const projectIds = new Set((await projectsLinking(repoId)).map((p) => p.id))
  try {
    return await withRepoHeld(repoId, reason, () => withProjectsHeld([...projectIds], reason, async () => {
      const holders = await stopProvisioningWith(repoId, projectIds)
      const handles = await reapSparesWith(repoId)
      const failed = await stopWorkspaces(handles.filter((h) => holders.has(h.workspaceId)), await listProjectRows())
      if (failed.length > 0) {
        throw new ServerError('RUNTIME_UNAVAILABLE', 'the repo did not move: some of its workspaces could not be '
          + `stopped (${failed.join('; ')}). Try again.`)
      }
      return fn()
    }))
  } finally {
    for (const id of projectIds) void startWaitingWorkspaces(id)
  }
}

/** Hand the egress path the credentials again, since a move changes the
 *  grants; `moved` says what happened for the error when it cannot. */
async function handCredentialsOver(moved: string): Promise<void> {
  const failure = await pushCredentialsToRuntime()
  if (failure) {
    throw new ServerError('RUNTIME_UNAVAILABLE', `${moved}, but the egress proxy could not be given its `
      + `credentials (${failure.message}), so its workspaces cannot reach it until it is: `
      + 'any credential change or a server restart does it.')
  }
}

/** A repo on a git host that may move onto yaac, once its owner is
 *  checked. */
async function hostableRepo(principal: Actor, repoId: string): Promise<RepoRow> {
  const repo = await ownRepo(principal, repoId)
  if (repo.deletedAt !== undefined) throw new ServerError('VALIDATION', `${repo.remoteUrl} was deleted`)
  if (repo.hosted) {
    throw new ServerError('VALIDATION', 'the repo is hosted by yaac already; give it an upstream instead.')
  }
  if (repo.keepsHostedRepo) {
    throw new ServerError('VALIDATION', 'yaac still keeps the repository this repo had before it moved to a git host; '
      + 'remove it in Settings → Repos first.')
  }
  return repo
}

/** What `moveRepoToYaac` would stop: the running workspaces holding a
 *  checkout of the repo, by project. */
export async function previewRepoHost(principal: Actor, repoId: string): Promise<RepoHostPreview> {
  await hostableRepo(principal, repoId)
  const holders = await holdersOf(repoId)
  const running = (await workspaceDriver().list()).filter((h) => holders.has(h.workspaceId) && !h.prewarmed && !h.terminating)
  return {
    projects: (await listProjectRows()).flatMap((p) => {
      const workspaces = running.filter((h) => h.projectId === p.id).map((h) => h.workspaceId)
      return workspaces.length > 0 ? [{ id: p.id, name: p.name, workspaces }] : []
    }),
  }
}

/**
 * Move a repo on a git host onto yaac (docs/repo-forks.md "Moving a repo
 * to yaac"): the repo becomes a hosted repo filled from its main clone, and
 * a new repo takes over the remote it leaves as its upstream, so its
 * workspaces push to yaac from their next start. Every workspace holding a
 * checkout stops first. Only its owner may, and not while yaac still keeps
 * the repository of an earlier move off it, whose place on disk the new one
 * takes.
 */
export async function moveRepoToYaac(principal: Actor, repoId: string): Promise<void> {
  const repo = await hostableRepo(principal, repoId)
  const reason = 'a repo of this project is moving to yaac; try again once it has.'
  await withRepoStopped(repoId, reason, async () => {
    await ensureMainClone(repo)
    // The hosted repository is filled from the main clone, so it must hold
    // every branch origin has; and the remote it leaves is read-only only
    // if its credential cannot push there.
    await fetchRepoOrigin(repoId).catch((err: unknown) => {
      throw new ServerError('VALIDATION', `the repo did not move: fetching ${repo.remoteUrl} failed `
        + `(${err instanceof Error ? err.message : String(err)}). It stays where it was.`)
    })
    await probeRepoPushAccess([repoId])
    const main = repoDir(repoId)
    const hosted = hostedRepoDir(repoId)
    await fs.rm(hosted, { recursive: true, force: true })
    await fs.mkdir(path.dirname(hosted), { recursive: true })
    try {
      await initHostedRepo(hosted)
      await fillHostedRepo(hosted, main, await getDefaultBranch(main))
      await setUpstreamRefs(main)
    } catch (err) {
      await fs.rm(hosted, { recursive: true, force: true })
      throw new ServerError('INTERNAL', `the repo did not move: ${err instanceof Error ? err.message : String(err)}`)
    }
    await hostRepoWithUpstream(repoId, crypto.randomUUID(), hostedRemoteUrl(repoId))
  })
  fetchRepoOrigin(repoId).catch((err: unknown) => serverLog(`[git] fetching ${repoId} after its move: ${String(err)}`))
  await handCredentialsOver('the repo moved to yaac')
}

/** A choice for a branch that needs one as a fork moves back onto its
 *  upstream: push it, under its own name or `as`, or leave it behind. */
export interface UpstreamMoveChoices {
  push: Array<{ branch: string; as?: string }>
  leave: string[]
}

/**
 * The fork a move back onto its upstream is asked for, with its upstream
 * and the upstream's credential, once that credential is known to push:
 * refused while a project links the upstream directly or a workspace
 * holds a checkout of it, since the two would then be one remote under two
 * rows.
 */
async function upstreamMovable(principal: Actor, repoId: string): Promise<{
  repo: RepoRow
  upstream: RepoRow
  credential: NonNullable<Awaited<ReturnType<typeof resolveRepoCredential>>>
}> {
  const repo = await ownRepo(principal, repoId)
  const upstream = repo.upstreamRepoId !== null && repo.deletedAt === undefined ? await getRepo(repo.upstreamRepoId) : undefined
  if (!upstream) throw new ServerError('VALIDATION', 'the repo has no upstream to move onto.')
  if (upstream.hosted) throw new ServerError('VALIDATION', 'its upstream is hosted by yaac; move it there by hand.')
  if ((await projectsLinking(upstream.id)).length > 0 || (await holdersOf(upstream.id)).size > 0) {
    throw new ServerError('CONFLICT', `${upstream.remoteUrl} is linked into a project itself; unlink it first.`)
  }
  const credential = await resolveRepoCredential(upstream)
  const access = credential ? await probePushAccess(upstream.remoteUrl, credential) : 'no'
  if (access !== null && credential) await updateRepoSettings(upstream.id, { pushAccess: access })
  if (!credential || access !== 'yes') {
    throw new ServerError('VALIDATION', `the upstream's credential cannot push to ${upstream.remoteUrl}; `
      + 'assign it one that can in Settings → Repos.')
  }
  return { repo, upstream, credential }
}

/** Every branch of the fork and its upstream by name, with what depends
 *  on the fork's. */
async function upstreamBranches(repoId: string): Promise<UpstreamMoveBranch[]> {
  const [compared, holders, queued, routines] = await Promise.all([
    compareRemoteBranches(repoDir(repoId)), holdersOf(repoId), listQueuedWorkspaceRows(), listRoutineRows(),
  ])
  const running = new Set((await workspaceDriver().list()).filter((h) => !h.prewarmed && !h.terminating).map((h) => h.workspaceId))
  const bases = [...(await listWorkspaceReposFor([...holders])).entries()]
    .flatMap(([workspaceId, rows]) => rows.filter((r) => r.repoId === repoId).map((r) => ({ workspaceId, branch: r.baseBranch })))
  const naming = (rows: Array<{ repos: Array<{ repo: string; branch?: string }> }>, branch: string): number =>
    rows.filter((r) => r.repos.some((s) => s.repo === repoId && s.branch === branch)).length
  return compared.map(({ branch, state }) => ({
    branch,
    state,
    dependents: {
      running: bases.filter((b) => b.branch === branch && running.has(b.workspaceId)).length,
      stopped: bases.filter((b) => b.branch === branch && !running.has(b.workspaceId)).length,
      queued: naming(queued, branch),
      routines: naming(routines, branch),
    },
  }))
}

/** What a move back onto the upstream would stop and hand over, with
 *  every branch of either remote, after fetching both. */
export async function previewUpstreamMove(principal: Actor, repoId: string): Promise<RepoMovePreview> {
  const { upstream } = await upstreamMovable(principal, repoId)
  await fetchRepoOrigin(repoId)
  await fetchRepoUpstream(repoId)
  return { ...await movePreviewOf(repoId), toUpstream: { remoteUrl: upstream.remoteUrl, branches: await upstreamBranches(repoId) } }
}

/** The pushes `choices` asks for, refused unless every branch that needs a
 *  choice has exactly one and each pushed branch can be pushed. */
function checkedPushes(branches: UpstreamMoveBranch[], choices: UpstreamMoveChoices): Array<{ from: string; to: string }> {
  const pushed = new Map(choices.push.map((p) => [p.branch, p.as ?? p.branch]))
  const left = new Set(choices.leave)
  for (const { branch, state } of branches) {
    if (state === 'same' || state === 'upstream-only') continue
    if (pushed.has(branch) === left.has(branch)) {
      throw new ServerError('VALIDATION', `choose whether to push or leave behind ${branch} (${state})`)
    }
    if (state === 'diverged' && pushed.has(branch)) {
      throw new ServerError('VALIDATION', `${branch} has diverged from the upstream's, so it can only be left behind, `
        + 'or caught up in a workspace first')
    }
  }
  for (const [from, to] of pushed) {
    const known = branches.find((b) => b.branch === from)
    if (known === undefined || known.state === 'upstream-only') throw new ServerError('VALIDATION', `the fork has no branch ${from}`)
    if (!isBranchName(to)) throw new ServerError('VALIDATION', `"${to}" is not a branch name`)
  }
  return [...pushed].filter(([from]) => {
    const state = branches.find((b) => b.branch === from)?.state
    return state === 'fork-only' || state === 'ahead' || pushed.get(from) !== from
  }).map(([from, to]) => ({ from, to }))
}

/**
 * Move a fork back onto its upstream once its owner can push there
 * (docs/repo-forks.md "Moving back to the upstream"): the branches picked
 * are pushed to the upstream, nothing forced, and the repo takes the
 * upstream's remote and its own upstream while the upstream's row goes.
 * Every workspace holding a checkout stops first, whoever owns it; a
 * hosted fork's shares end and each other user gets a repo of their own.
 * What is left behind stays where the fork was: yaac's kept repository for
 * a local fork, or the fork on its git host, whose URL is answered.
 */
export async function moveRepoToUpstream(
  principal: Actor,
  repoId: string,
  choices: UpstreamMoveChoices,
): Promise<{ leftAt?: string }> {
  const { repo, upstream, credential } = await upstreamMovable(principal, repoId)
  checkedPushes(await upstreamBranches(repoId), choices)
  const reason = `a repo of this project is moving to ${upstream.remoteUrl}; try again once it has.`
  await withRepoStopped(repoId, reason, async () => {
    await fetchRepoOrigin(repoId)
    await fetchRepoUpstream(repoId)
    const pushes = checkedPushes(await upstreamBranches(repoId), choices)
    await pushMainBranches(repoDir(repoId), upstream.remoteUrl, credential, pushes).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      throw new ServerError('VALIDATION', `the repo did not move: ${isGitAuthError(message)
        ? "git authentication failed; the upstream's credential was rejected"
        : `${upstream.remoteUrl} refused the push (did it move meanwhile?): ${message}`}. It stays where it was.`)
    })
    await adoptUpstreamRemote(repoId, upstream.id)
    // An upstream linked once has a main clone, which nothing names now.
    await moveToTrash(repoDir(upstream.id), globalTrashDir())
    if (repo.hosted) {
      await removeRepoShares(repoId)
      await handOverToLinkers(repo, upstream.remoteUrl)
    }
    await setUpstreamRefs(repoDir(repoId), { drop: true })
  })
  fetchRepoOrigin(repoId).catch((err: unknown) => serverLog(`[git] fetching ${repoId} from its new remote: ${String(err)}`))
  await handCredentialsOver(`the repo moved to ${upstream.remoteUrl}`)
  return repo.hosted ? {} : { leftAt: repo.remoteUrl }
}
