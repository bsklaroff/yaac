import fs from 'node:fs/promises'
import { workspaceDriver } from '#drivers/driver'
import type { RuntimeHandle, RuntimeSnapshot } from '#drivers/contract'
import { hostedRepoDir } from '@yaac/shared/project-paths'
import { getProjectsDir } from '@yaac/shared/paths'
import { cleanupWorkspaceDetached, removeEntries } from './cleanup'
import {
  deleteProjectConversations,
  deleteProjectDraftWorkspaces,
  deleteProjectEnvVars,
  deleteProjectQueuedWorkspaces,
  deleteProjectRoutines,
  deleteProjectRow,
  deleteProjectRunSecrets,
  deleteProjectWorkflows,
  deleteProjectSiteRows,
  deleteProjectVolumeRows,
  deleteProjectWorkspaceGroups,
  deleteProjectWorkspaces,
  getProjectRow,
  listProjectRows,
  listProjectVolumes,
  listUsers,
  setProjectRemote,
  setProjectShareRevoked,
  type ProjectRow,
} from '#db'
import { harvestToolCredentials, pushCredentialsToRuntime } from '#domain/auth'
import { checkMoveTarget, isGitAuthError, pushHostedRepo } from '#domain/git'
import { fetchProjectOrigin, resolveCredentialForRemote } from '#domain/projects'
import { startWaitingWorkspaces } from './queued-workspaces'
import { serverLog } from '#lib/log'
import { allowlistAllows } from '#lib/allowed-hosts'
import { parseGitRemote } from '@yaac/shared/git-remote'
import { listProvisioning, stopProvisioning } from './provisioning'
import { reapSpare } from './prewarm'
import { ServerError } from '@yaac/shared/errors'
import { dropProjectClaudeKeychainItem } from '@yaac/shared/tool-auth'
import { authorizeProject, withProjectsHeld, type Actor } from '#domain/access'

/**
 * Remove a project: its workspaces and bytes (`purgeProjectBytes`), then its
 * rows. Throws `NOT_FOUND` if it does not exist. The project row goes last,
 * so a failed removal leaves a project that can still be listed and removed
 * again. A project's shares go first, since its repository goes with it.
 * Lives here rather than in #domain/projects to avoid an import cycle.
 */
export async function removeProject(principal: Actor, projectId: string): Promise<void> {
  if (!await getProjectRow(projectId)) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  await authorizeProject(principal, projectId)
  for (const share of (await listProjectRows()).filter((r) => r.sharedFrom === projectId)) {
    await deleteProject(share.id)
  }
  await deleteProject(projectId)
}

/**
 * Remove `userId`'s share of a project (docs/hosted-projects.md "Sharing"):
 * the share becomes read-only to its owner too, and its running workspaces
 * stop. Its rows, checkouts and sessions stay, for everyone to read. Only
 * the project's owner removes a share. A workspace that cannot be stopped
 * now is refused as RUNTIME_UNAVAILABLE, with the share already removed;
 * `reconcileRevokedShares` stops it later.
 */
export async function unshareProject(principal: Actor, projectId: string, userId: string): Promise<void> {
  if (!await getProjectRow(projectId)) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  await authorizeProject(principal, projectId)
  const share = (await listProjectRows()).find((r) => r.sharedFrom === projectId && r.owner === userId && !r.shareRevoked)
  if (!share) throw new ServerError('NOT_FOUND', `project ${projectId} is not shared with user ${userId}`)
  // First, so nothing can start in it while its workspaces stop.
  await setProjectShareRevoked(share.id, true)
  for (const p of listProvisioning().filter((e) => e.projectId === share.id)) stopProvisioning(p.workspaceId)
  let running: RuntimeHandle[]
  try {
    running = await workspaceDriver().list(share.id)
  } catch (err) {
    throw new ServerError('RUNTIME_UNAVAILABLE', 'The share was removed, but its workspaces could not be listed '
      + `(${err instanceof Error ? err.message : String(err)}); the server stops them once the runtime is reachable.`)
  }
  await stopInRevokedShare(share, running)
}

/**
 * Stop whatever still runs in a removed share: a workspace whose stop
 * failed when the share was removed, or a create or restart that had
 * passed its owner check by then. Level-triggered, so it runs every pass;
 * a share that fails is logged and retried next pass, without holding up
 * the others.
 */
export async function reconcileRevokedShares(snapshot: RuntimeSnapshot): Promise<void> {
  const revoked = (await listProjectRows()).filter((r) => r.shareRevoked)
  if (revoked.length === 0) return
  const running = await snapshot.workspaces()
  for (const share of revoked) {
    await stopInRevokedShare(share, running.filter((h) => h.projectId === share.id && !h.terminating))
      .catch((err: unknown) => serverLog(`[server] stopping removed share ${share.id}: ${String(err)}`))
  }
}

/**
 * Tear down a removed share's workspaces among `handles`
 * (`stopProjectWorkspaces`). Spares are left to the prewarm pool, which
 * reaps them once the project has no running workspace. Throws
 * RUNTIME_UNAVAILABLE naming the ones that could not be stopped.
 */
async function stopInRevokedShare(share: ProjectRow, handles: RuntimeHandle[]): Promise<void> {
  const failed = await stopProjectWorkspaces(share, handles)
  if (failed.length > 0) {
    throw new ServerError('RUNTIME_UNAVAILABLE', 'The share was removed, but some of its workspaces could not be '
      + `stopped yet (${failed.join('; ')}); the server keeps trying.`)
  }
}

/**
 * Stop a project's workspaces among `handles`, spares aside, keeping their
 * checkouts, after adopting any token their agents refreshed, as a stop
 * does. Answers the ones that could not be stopped, each with why.
 */
async function stopProjectWorkspaces(project: ProjectRow, handles: RuntimeHandle[]): Promise<string[]> {
  const own = handles.filter((h) => !h.prewarmed)
  if (own.length === 0) return []
  await harvestToolCredentials(project.owner, { projectId: project.id })
    .catch((err: unknown) => serverLog(`[server] credential harvest for ${project.id} failed: ${String(err)}`))
  const failed: string[] = []
  for (const h of own) {
    await cleanupWorkspaceDetached({ jobName: h.jobName, projectId: project.id, workspaceId: h.workspaceId })
      .catch((err: unknown) => { failed.push(`${h.workspaceId.slice(0, 8)}: ${String(err)}`) })
  }
  return failed
}

/** What moving a project off yaac stops and hands over, for the warning a
 *  client shows before it confirms (`moveProjectToRemote`). */
export interface ProjectMovePreview {
  /** Running workspaces of the project and its shares, every user's. */
  runningWorkspaces: number
  /** The users it is shared with, who each need a credential of their
   *  own for the new remote. */
  sharedWith: string[]
}

/** The project a move is asked for, once its owner is checked and it can
 *  move: it is hosted by yaac and not itself a share. */
async function movableProject(principal: Actor, projectId: string): Promise<ProjectRow> {
  const row = await getProjectRow(projectId)
  if (!row) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  await authorizeProject(principal, projectId)
  if (!row.hosted) throw new ServerError('VALIDATION', `"${row.name}" is not hosted by yaac; its remote is ${row.remoteUrl}.`)
  if (row.sharedFrom !== undefined) {
    throw new ServerError('VALIDATION', `"${row.name}" was shared with you; only its owner can move it.`)
  }
  return row
}

/** A project's shares that were not removed: the ones that move with it. */
async function activeShares(projectId: string): Promise<ProjectRow[]> {
  return (await listProjectRows()).filter((r) => r.sharedFrom === projectId && !r.shareRevoked)
}

/** What `moveProjectToRemote` would stop and hand over, right now. */
export async function previewProjectMove(principal: Actor, projectId: string): Promise<ProjectMovePreview> {
  await movableProject(principal, projectId)
  const shares = await activeShares(projectId)
  const ids = new Set([projectId, ...shares.map((r) => r.id)])
  const running = (await workspaceDriver().list()).filter((h) => ids.has(h.projectId) && !h.prewarmed && !h.terminating)
  const users = new Map((await listUsers()).map((u) => [u.id, u.login ?? u.name]))
  return {
    runningWorkspaces: running.length,
    sharedWith: shares.map((r) => users.get(r.owner) ?? r.owner),
  }
}

/**
 * Move a project the server hosts to an empty repository elsewhere, such as
 * on GitHub, reached with one of its owner's git credentials
 * (docs/hosted-projects.md "Moving to a git host"). While it runs, the
 * project and every share of it are held (`withProjectsHeld`): nothing
 * starts in them and nothing is pushed to their repository. Once the
 * remote is known to fit, every workspace on the repository stops, whoever
 * owns it, keeping its checkout. Then every branch and tag is pushed, and
 * only once that lands do the project and its shares switch to the remote.
 * Anything that fails before then leaves them on yaac, and a retry picks up
 * where it stopped. yaac keeps its repository, read-only, until the owner
 * has checked the remote and removes it (`removeKeptHostedRepo`). Only the
 * owner moves a project. Answers the host key trusted for an ssh
 * credential.
 */
export async function moveProjectToRemote(
  principal: Actor,
  projectId: string,
  remoteUrl: string,
  credentialId: string,
): Promise<{ knownHostsEntry: string | null }> {
  const row = await movableProject(principal, projectId)
  const { credential, knownHostsEntry } = await resolveCredentialForRemote(row.owner, credentialId, remoteUrl)
  const runtime = workspaceDriver()
  // Behind an egress proxy a workspace reaches only allowed hosts, so every
  // workspace restarted after the move would be refused, as create is.
  const { host } = parseGitRemote(remoteUrl)
  if (runtime.kind !== 'containerless' && !allowlistAllows(row.egressAllowlist, host)) {
    throw new ServerError('VALIDATION', `"${host}" is not in the egress allowlist of "${row.name}", so its `
      + 'workspaces could not reach the new remote. Add it in Settings → Project Config, then move.')
  }
  await runtime.ensureRuntimeReachable()
  const hosted = hostedRepoDir(projectId)
  const git = async (step: () => Promise<void>): Promise<void> => step().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    throw new ServerError('VALIDATION', `"${row.name}" did not move: ${isGitAuthError(message)
      ? 'git authentication failed; the credential was rejected, or cannot push there'
      : `${remoteUrl} could not take it: ${message}`}. It stays on yaac.`)
  })
  const reason = `"${row.name}" is moving to ${remoteUrl}; try again once it has.`
  let onRepo = [row]
  try {
    // The project first: sharing and unsharing it authorize against it, so
    // once it is held its shares are settled, and are held in turn.
    return await withProjectsHeld([projectId], reason, async () => {
      const shares = await activeShares(projectId)
      onRepo = [row, ...shares]
      return withProjectsHeld(shares.map((r) => r.id), reason, async () => {
        await git(() => checkMoveTarget(hosted, remoteUrl, credential))
        const failed: string[] = []
        for (const project of onRepo) {
          // A create or restart past its last checkpoint still comes up, so
          // it is waited for and then listed with the rest.
          await Promise.all(listProvisioning().filter((e) => e.projectId === project.id)
            .map((p) => stopProvisioning(p.workspaceId)?.ranAs.catch(() => undefined) ?? Promise.resolve(undefined)))
          const handles = (await runtime.list(project.id)).filter((h) => !h.terminating)
          for (const h of handles.filter((s) => s.prewarmed)) reapSpare({ jobName: h.jobName, projectId: project.id, workspaceId: h.workspaceId })
          failed.push(...await stopProjectWorkspaces(project, handles))
        }
        if (failed.length > 0) {
          throw new ServerError('RUNTIME_UNAVAILABLE', `"${row.name}" did not move: some of its workspaces could not be `
            + `stopped (${failed.join('; ')}). It stays on yaac; try again.`)
        }
        await git(() => pushHostedRepo(hosted, remoteUrl, credential))
        await setProjectRemote(projectId, remoteUrl, { id: credentialId, knownHostsEntry })
        fetchProjectOrigin(projectId).catch((err: unknown) => {
          serverLog(`[git] fetching ${projectId} from its new remote: ${(err as Error).message}`)
        })
        // An egress proxy injects only the credentials it was last handed,
        // so a restarted workspace could not push without this.
        const failure = await pushCredentialsToRuntime()
        if (failure) {
          throw new ServerError('RUNTIME_UNAVAILABLE', `"${row.name}" moved to ${remoteUrl}, but the egress proxy `
            + `could not be given its credential (${failure.message}), so its workspaces cannot push there until it is: `
            + 'any credential change or a server restart does it.')
        }
        return { knownHostsEntry }
      })
    })
  } finally {
    // Queued workspaces wait out the hold rather than fail on it, and start
    // now, on whichever remote the project has.
    for (const r of onRepo) void startWaitingWorkspaces(r.id)
  }
}

async function deleteProject(projectId: string): Promise<void> {
  // First, so the sites step neither replaces a release the purge stops nor
  // advances a deploy into the project (docs/public-sites.md).
  await deleteProjectSiteRows(projectId)
  await purgeProjectBytes(projectId)
  // The macOS Keychain item containerless claude keys on the tool home path.
  // No-op elsewhere.
  dropProjectClaudeKeychainItem(projectId)

  await deleteProjectWorkspaces(projectId)
  await deleteProjectConversations(projectId)
  await deleteProjectWorkspaceGroups(projectId)
  // Entries first: a run's entry references its routine.
  await deleteProjectQueuedWorkspaces(projectId)
  await deleteProjectRoutines(projectId)
  await deleteProjectDraftWorkspaces(projectId)
  await deleteProjectEnvVars(projectId)
  await deleteProjectRunSecrets(projectId)
  await deleteProjectVolumeRows(projectId)
  await deleteProjectRow(projectId)
  // Last, as everything above may name them.
  await deleteProjectWorkflows(projectId)
}

/**
 * Delete everything a project has on disk and on the substrate: live
 * workspaces, volumes, driver-held state (push registry, node-local trees),
 * the global tree, and a hosted project's remote. Best-effort throughout; the
 * driver's id-keyed sweeps collect whatever a failure leaves.
 */
async function purgeProjectBytes(projectId: string): Promise<void> {
  let pods: RuntimeHandle[] = []
  try {
    pods = await workspaceDriver().list(projectId)
  } catch {
    // Runtime unavailable: still remove the dirs.
  }

  for (const p of pods) {
    try {
      await cleanupWorkspaceDetached({
        jobName: p.jobName,
        projectId,
        workspaceId: p.workspaceId,
      })
    } catch {
      // Best-effort; continue with the next workspace.
    }
  }

  // A volume outlives every workspace, but not its project. A pod still
  // shutting down may keep one mounted; `collectDeletedVolumes` removes what
  // this leaves, from the tombstones the rows' delete writes.
  if (workspaceDriver().kind === 'k8s') {
    for (const v of await listProjectVolumes(projectId).catch(() => [])) {
      await workspaceDriver().deleteVolume(v.id)
        .catch((err: unknown) => serverLog(`[server] deleting volume ${v.name} of project ${projectId}: ${String(err)}`))
    }
  }

  // Node-local and driver-held bytes live where the workspaces ran, so only
  // the driver can reach them.
  try {
    await workspaceDriver().destroyProjectSubstrate(projectId)
  } catch {
    // The id-keyed sweeps will collect it.
  }

  // Safe after the teardowns above: `rm` does not follow links, and no pod
  // is left to swap one in mid-walk.
  await removeEntries(getProjectsDir(), [projectId])
  // A hosted project's remote is its only authoritative copy; the remove
  // confirmation says so. A share has none of its own.
  await fs.rm(hostedRepoDir(projectId), { recursive: true, force: true })
}
