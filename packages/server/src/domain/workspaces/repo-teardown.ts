import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { workspaceDriver } from '#drivers/driver'
import type { RuntimeHandle, RuntimeSnapshot } from '#drivers/contract'
import { claudeDir, claudeMemoryDirName, hostedRepoDir, repoDir } from '@yaac/shared/project-paths'
import { cleanupWorkspaceDetached } from './cleanup'
import {
  deleteRepoRow,
  insertRepo,
  listProjectRows,
  listReleasedDeletedRepos,
  listRepoHolders,
  listRepos,
  listRepoShares,
  listSites,
  listUsers,
  listWorkspaceReposFor,
  markRepoDeleted,
  removeRepoShares,
  repointProjectRepos,
  setRepoRemote,
  unlinkProjectRepo,
  type ProjectRow,
  type RepoRow,
} from '#db'
import { harvestToolCredentials, pushCredentialsToRuntime } from '#domain/auth'
import { checkMoveTarget, isGitAuthError, pushHostedRepo } from '#domain/git'
import { fetchRepoOrigin, ownRepo, resolveCredentialForRemote, withRepoHeld } from '#domain/repos'
import { startWaitingWorkspaces } from './queued-workspaces'
import { serverLog } from '#lib/log'
import { allowlistAllows } from '@yaac/shared/allowed-hosts'
import { parseGitRemote } from '@yaac/shared/git-remote'
import { inFlightCreate, listProvisioning, stopProvisioning } from './provisioning'
import { reapSpare, spareSettings } from './prewarm'
import { ServerError } from '@yaac/shared/errors'
import type { RepoDeletePreview, RepoHolder, RepoMovePreview } from '@yaac/shared/types'
import { withProjectsHeld, type Actor } from '#domain/access'

/*
 * The repo verbs that reach into workspaces (docs/hosted-projects.md):
 * ending a share, moving a hosted repo to a git host, and deleting a repo.
 * They live here rather than in `#domain/repos` because they stop
 * workspaces. None deletes a workspace or a checkout.
 */

/**
 * Stop workspaces among `handles`, spares aside, keeping their checkouts,
 * after adopting any token their agents refreshed, as a stop does. Answers
 * the ones that could not be stopped, each with why.
 */
async function stopWorkspaces(handles: RuntimeHandle[], projects: ProjectRow[]): Promise<string[]> {
  const own = handles.filter((h) => !h.prewarmed)
  for (const project of projects.filter((p) => own.some((h) => h.projectId === p.id))) {
    await harvestToolCredentials(project.owner, { projectId: project.id })
      .catch((err: unknown) => serverLog(`[server] credential harvest for ${project.id} failed: ${String(err)}`))
  }
  const failed: string[] = []
  for (const h of own) {
    await cleanupWorkspaceDetached({ jobName: h.jobName, projectId: h.projectId, workspaceId: h.workspaceId })
      .catch((err: unknown) => { failed.push(`${h.workspaceId.slice(0, 8)}: ${String(err)}`) })
  }
  return failed
}

/**
 * Reap every spare warmed with a repo, and one whose settings are unknown.
 * Answers the runtime's units that are not being torn down.
 */
async function reapSparesWith(repoId: string): Promise<RuntimeHandle[]> {
  const handles = (await workspaceDriver().list()).filter((h) => !h.terminating)
  for (const h of handles) {
    if (h.prewarmed && spareSettings.get(h.workspaceId)?.repos.some((r) => r.repoId === repoId) !== false) {
      reapSpare({ jobName: h.jobName, projectId: h.projectId, workspaceId: h.workspaceId })
    }
  }
  return handles
}

/** The ids of the workspaces holding a checkout of a repo, running or not. */
async function holdersOf(repoId: string): Promise<Set<string>> {
  return new Set((await listRepoHolders(repoId)).map((h) => h.workspaceId))
}

/**
 * Stop every create and restart in flight in `projectIds` that involves the
 * repo: one whose workspace holds a checkout of it, or whose create starts
 * with it. One past its last checkpoint still comes up, so each is waited
 * for. Answers the workspaces holding a checkout once they have settled,
 * for the caller to stop the running ones among.
 */
async function stopProvisioningWith(repoId: string, projectIds: Set<string>): Promise<Set<string>> {
  const holders = await holdersOf(repoId)
  const involved = listProvisioning().filter((e) => projectIds.has(e.projectId)
    && (holders.has(e.workspaceId)
      || inFlightCreate(e.workspaceId)?.selection?.repos.some((r) => r.repo === repoId) === true))
  await Promise.all(involved.map((p) =>
    stopProvisioning(p.workspaceId)?.ranAs.catch(() => undefined) ?? Promise.resolve(undefined)))
  return holdersOf(repoId)
}

/**
 * End `userId`'s share of a repo (docs/hosted-projects.md "Sharing"): they
 * can no longer link it or start a workspace with it, and their running
 * workspaces that hold a checkout of it stop. Their links, rows and
 * checkouts stay, and work again if the repo is shared again. Only the
 * repo's owner ends a share. A workspace that cannot be stopped now is
 * refused as RUNTIME_UNAVAILABLE, with the share already ended;
 * `reconcileRevokedShares` stops it later.
 */
export async function unshareRepo(principal: Actor, repoId: string, userId: string): Promise<void> {
  const repo = await ownRepo(principal, repoId)
  if (!(await listRepoShares()).some((s) => s.repoId === repoId && s.userId === userId)) {
    throw new ServerError('NOT_FOUND', `${repo.remoteUrl} is not shared with user ${userId}`)
  }
  // First, so nothing can start with it while its workspaces stop.
  await removeRepoShares(repoId, userId)
  const projects = (await listProjectRows()).filter((p) => p.owner === userId)
  const projectIds = new Set(projects.map((p) => p.id))
  const holders = await stopProvisioningWith(repoId, projectIds)
  let running: RuntimeHandle[]
  try {
    running = await workspaceDriver().list()
  } catch (err) {
    throw new ServerError('RUNTIME_UNAVAILABLE', 'The share was ended, but its workspaces could not be listed '
      + `(${err instanceof Error ? err.message : String(err)}); the server stops them once the runtime is reachable.`)
  }
  const failed = await stopWorkspaces(
    running.filter((h) => projectIds.has(h.projectId) && holders.has(h.workspaceId) && !h.terminating), projects)
  if (failed.length > 0) {
    throw new ServerError('RUNTIME_UNAVAILABLE', 'The share was ended, but some workspaces could not be '
      + `stopped yet (${failed.join('; ')}); the server keeps trying.`)
  }
}

/**
 * Stop every running workspace that holds a checkout of a repo its
 * project's owner may not use: one whose stop failed when a share ended, or
 * a create or restart that had passed its check by then. A deleted repo's
 * checkouts are left running, with no remote. Level-triggered, so it runs
 * every pass; a workspace that fails is logged and retried next pass.
 */
export async function reconcileRevokedShares(snapshot: RuntimeSnapshot): Promise<void> {
  const running = (await snapshot.workspaces()).filter((h) => h.running && !h.prewarmed && !h.terminating)
  if (running.length === 0) return
  const held = await listWorkspaceReposFor(running.map((h) => h.workspaceId))
  if ([...held.values()].every((rows) => rows.length === 0)) return
  const [repos, shares, projects] = await Promise.all([listRepos(), listRepoShares(), listProjectRows()])
  const repoOf = new Map(repos.map((r) => [r.id, r]))
  const ownerOf = new Map(projects.map((p) => [p.id, p.owner]))
  const revoked = running.filter((h) => (held.get(h.workspaceId) ?? []).some(({ repoId }) => {
    const repo = repoOf.get(repoId)
    const owner = ownerOf.get(h.projectId)
    return repo !== undefined && repo.deletedAt === undefined && owner !== undefined && repo.owner !== owner
      && !shares.some((s) => s.repoId === repoId && s.userId === owner)
  }))
  const failed = await stopWorkspaces(revoked, projects)
  if (failed.length > 0) serverLog(`[server] stopping workspaces of ended shares: ${failed.join('; ')}`)
}

/** The hosted repo a move is asked for, once its owner is checked. */
async function movableRepo(principal: Actor, repoId: string): Promise<RepoRow> {
  const repo = await ownRepo(principal, repoId)
  if (!repo.hosted || repo.deletedAt !== undefined) {
    throw new ServerError('VALIDATION', `the repo is not hosted by yaac; its remote is ${repo.remoteUrl}.`)
  }
  return repo
}

/** The projects that link a repo, any user's. */
async function projectsLinking(repoId: string): Promise<ProjectRow[]> {
  return (await listProjectRows()).filter((p) => p.repos.some((l) => l.repo.id === repoId))
}

/** What `moveRepoToRemote` would stop and hand over, right now. */
export async function previewRepoMove(principal: Actor, repoId: string): Promise<RepoMovePreview> {
  await movableRepo(principal, repoId)
  const holders = await holdersOf(repoId)
  const running = (await workspaceDriver().list()).filter((h) => holders.has(h.workspaceId) && !h.prewarmed && !h.terminating)
  const users = new Map((await listUsers()).map((u) => [u.id, u.login ?? u.name]))
  return {
    runningWorkspaces: running.length,
    sharedWith: (await listRepoShares()).filter((s) => s.repoId === repoId).map((s) => users.get(s.userId) ?? s.userId),
  }
}

/**
 * Move a repo the server hosts to an empty repository elsewhere, such as on
 * GitHub, reached with one of its owner's git credentials
 * (docs/hosted-projects.md "Moving to a git host"). While it runs, the repo
 * and every project that links it are held (`withRepoHeld`,
 * `withProjectsHeld`): nothing starts in them and nothing is pushed to the
 * repo. Once the remote is known to fit, every workspace holding a checkout
 * of it stops, whoever owns it, keeping its checkout. Then every branch and
 * tag is pushed, and only once that lands does the repo switch to the
 * remote. Anything that fails before then leaves it on yaac, and a retry
 * picks up where it stopped.
 *
 * The move ends the repo's shares. Each other user who links it gets a repo
 * of their own for the same remote, with a copy of the main clone and no
 * credential, which everything of theirs that named the repo now names;
 * they assign a credential before their next create. yaac keeps the hosted
 * repository, read-only, until the owner has checked the remote and removes
 * it (`removeKeptHostedRepo`). Only the owner moves a repo. Answers the host
 * key trusted for an ssh credential.
 */
export async function moveRepoToRemote(
  principal: Actor,
  repoId: string,
  remoteUrl: string,
  credentialId: string,
): Promise<{ knownHostsEntry: string | null }> {
  const repo = await movableRepo(principal, repoId)
  const { credential, knownHostsEntry } = await resolveCredentialForRemote(repo.owner, credentialId, remoteUrl)
  const runtime = workspaceDriver()
  const linking = await projectsLinking(repoId)
  // Behind an egress proxy a workspace reaches only allowed hosts, so every
  // workspace of the owner's restarted after the move would be refused, as
  // create is. Other users check theirs when they assign a credential.
  const { host } = parseGitRemote(remoteUrl)
  const closed = runtime.kind === 'containerless' ? undefined
    : linking.find((p) => p.owner === repo.owner && !allowlistAllows(p.egressAllowlist, host))
  if (closed !== undefined) {
    throw new ServerError('VALIDATION', `"${host}" is not in the egress allowlist of "${closed.name}", so its `
      + 'workspaces could not reach the new remote. Add it in Settings → Project Config, then move.')
  }
  await runtime.ensureRuntimeReachable()
  const hosted = hostedRepoDir(repoId)
  const git = async (step: () => Promise<void>): Promise<void> => step().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    throw new ServerError('VALIDATION', `the repo did not move: ${isGitAuthError(message)
      ? 'git authentication failed; the credential was rejected, or cannot push there'
      : `${remoteUrl} could not take it: ${message}`}. It stays on yaac.`)
  })
  const reason = `a repo of this project is moving to ${remoteUrl}; try again once it has.`
  const projectIds = new Set(linking.map((p) => p.id))
  try {
    return await withRepoHeld(repoId, reason, () => withProjectsHeld([...projectIds], reason, async () => {
      await git(() => checkMoveTarget(hosted, remoteUrl, credential))
      const holders = await stopProvisioningWith(repoId, projectIds)
      const handles = await reapSparesWith(repoId)
      const failed = await stopWorkspaces(handles.filter((h) => holders.has(h.workspaceId)), await listProjectRows())
      if (failed.length > 0) {
        throw new ServerError('RUNTIME_UNAVAILABLE', 'the repo did not move: some of its workspaces could not be '
          + `stopped (${failed.join('; ')}). It stays on yaac; try again.`)
      }
      await git(() => pushHostedRepo(hosted, remoteUrl, credential))
      await setRepoRemote(repoId, remoteUrl, { id: credentialId, knownHostsEntry })
      await removeRepoShares(repoId)
      await handOverToLinkers(repo, remoteUrl)
      fetchRepoOrigin(repoId).catch((err: unknown) => {
        serverLog(`[git] fetching ${repoId} from its new remote: ${(err as Error).message}`)
      })
      // An egress proxy injects only the credentials it was last handed,
      // so a restarted workspace could not push without this.
      const failure = await pushCredentialsToRuntime()
      if (failure) {
        throw new ServerError('RUNTIME_UNAVAILABLE', `the repo moved to ${remoteUrl}, but the egress proxy `
          + `could not be given its credential (${failure.message}), so its workspaces cannot push there until it is: `
          + 'any credential change or a server restart does it.')
      }
      return { knownHostsEntry }
    }))
  } finally {
    // Queued workspaces wait out the hold rather than fail on it, and start
    // now, on whichever remote the repo has.
    for (const id of projectIds) void startWaitingWorkspaces(id)
  }
}

/**
 * Give each user but the owner whose projects or workspaces name a moved
 * repo one of their own: a row for the same remote with no credential, a
 * copy of the main clone (their checkouts borrow its objects), and
 * everything of theirs repointed at it, claude's memory of it included.
 */
async function handOverToLinkers(repo: RepoRow, remoteUrl: string): Promise<void> {
  const projects = await listProjectRows()
  const holding = new Set((await listRepoHolders(repo.id)).map((h) => h.projectId))
  const users = new Set(projects
    .filter((p) => p.owner !== repo.owner && (holding.has(p.id) || p.repos.some((l) => l.repo.id === repo.id)))
    .map((p) => p.owner))
  for (const owner of users) {
    const id = crypto.randomUUID()
    await fs.mkdir(path.dirname(repoDir(id)), { recursive: true })
    await fs.cp(repoDir(repo.id), repoDir(id), { recursive: true })
    await insertRepo({ id, owner, remoteUrl })
    await repointProjectRepos(owner, repo.id, id)
    // claude's memory of the repo follows it, in each of their projects.
    for (const project of projects.filter((p) => p.owner === owner)) {
      const memories = path.join(claudeDir(project.id), 'projects')
      await fs.rename(path.join(memories, claudeMemoryDirName(repo.id)), path.join(memories, claudeMemoryDirName(id)))
        .catch((err: unknown) => {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        })
    }
  }
}

/** The workspaces holding a checkout of a repo, with their projects. */
async function repoHolders(repoId: string): Promise<RepoHolder[]> {
  const projects = new Map((await listProjectRows()).map((p) => [p.id, p]))
  return (await listRepoHolders(repoId)).flatMap((h) => {
    const project = projects.get(h.projectId)
    return project
      ? [{ workspaceId: h.workspaceId, projectId: h.projectId, projectName: project.name, owner: project.owner }]
      : []
  })
}

/** What `deleteRepo` would reach, for the confirmation a client shows. */
export async function previewRepoDelete(principal: Actor, repoId: string): Promise<RepoDeletePreview> {
  const repo = await ownRepo(principal, repoId)
  return {
    hosted: repo.hosted || repo.keepsHostedRepo,
    projects: (await projectsLinking(repoId)).map((p) => ({ id: p.id, name: p.name, owner: p.owner })),
    heldBy: await repoHolders(repoId),
  }
}

/**
 * Delete a repo, the one way a repo goes (docs/hosted-projects.md "Deleting
 * a repo"). Only its owner may. It is unlinked from every project, other
 * users' included, its shares end, and a hosted repo's bare repository, the
 * only copy of its code, is deleted. No workspace is deleted or stopped:
 * one holding a checkout keeps its files and commits, with no remote to
 * fetch from or push to.
 *
 * Those checkouts borrow their objects from the main clone, so while any
 * workspace holds one the main clone and the row (marked deleted, usable by
 * no one) stay, and the answer lists the holders; `collectDeletedRepos`
 * removes both once the last of those workspaces is deleted. With no
 * holder, everything goes at once.
 */
export async function deleteRepo(principal: Actor, repoId: string): Promise<{ heldBy: RepoHolder[] }> {
  await ownRepo(principal, repoId)
  const sites = (await listSites()).filter((s) => s.repoId === repoId)
  if (sites.length > 0) {
    throw new ServerError('CONFLICT', `site ${sites.map((s) => `"${s.name}"`).join(', ')} is built from this repo; `
      + 'delete the site first')
  }
  const projectIds = new Set((await projectsLinking(repoId)).map((p) => p.id))
  return withRepoHeld(repoId, 'this repo is being deleted', async () => {
    await unlinkProjectRepo(repoId)
    await removeRepoShares(repoId)
    // A create that had read the link would fetch a repo that is gone, and
    // a spare warmed with it can no longer be claimed.
    await stopProvisioningWith(repoId, projectIds)
    await reapSparesWith(repoId).catch(() => { /* the prewarm pool reaps a spare its project no longer matches */ })
    await fs.rm(hostedRepoDir(repoId), { recursive: true, force: true })
    const heldBy = await repoHolders(repoId)
    if (heldBy.length > 0) await markRepoDeleted(repoId)
    else await removeRepo(repoId)
    return { heldBy }
  })
}

async function removeRepo(repoId: string): Promise<void> {
  await fs.rm(repoDir(repoId), { recursive: true, force: true })
  await deleteRepoRow(repoId)
}

/**
 * The `deleted-repos` reconcile step: remove the main clone and row of each
 * deleted repo no workspace holds a checkout of any more.
 */
export async function collectDeletedRepos(): Promise<void> {
  for (const repo of await listReleasedDeletedRepos()) {
    await removeRepo(repo.id).catch((err: unknown) => serverLog(`[git] removing deleted repo ${repo.id}: ${String(err)}`))
  }
}
