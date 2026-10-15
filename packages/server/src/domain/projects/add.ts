import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { ensureDataDir, projectDir, repoDir, claudeDir, hostedRepoDir } from '@yaac/shared/project-paths'
import { hostedRemoteUrl } from '@yaac/shared/hosted-git'
import { cloneRepo, initHostedRepo, isGitAuthError } from '#domain/git'
import { parseGitRemote } from '@yaac/shared/git-remote'
import { resolveCredentialForRemote } from './credentials'
import { getProjectRow, getToolCredential, listProjectRows, listUsers, recordProject, setProjectShareRevoked } from '#db'
import { authorizeProject, type Actor } from '#domain/access'
import {
  writeProjectClaudePlaceholder,
  writeProjectCodexPlaceholder,
} from '@yaac/shared/tool-auth'
import { ServerError } from '@yaac/shared/errors'
import type { ProjectMeta } from '@yaac/shared/types'
import { projectNameFor } from '@yaac/shared/project-name'

/**
 * Validate a git remote URL and return it parsed. Accepts the two
 * `parseGitRemote` forms:
 *   - https://<host>/<path>[.git]
 *   - SCP-style: git@<host>:<path>[.git]
 * Rejects http://, ssh://, custom ports, and unparseable input.
 */
export function validateGitRemoteUrl(url: string): ReturnType<typeof parseGitRemote> {
  try {
    return parseGitRemote(url)
  } catch (err) {
    throw new ServerError(
      'VALIDATION',
      err instanceof Error ? err.message : `Invalid git remote URL: "${url}"`,
    )
  }
}

export interface AddProjectResult {
  project: ProjectMeta
  /** The host key trusted for an SSH credential, for the user to compare
   *  against what the host publishes. */
  knownHostsEntry: string | null
}

/**
 * Clone a git repo into the data dir as a yaac project owned by `owner`,
 * assigning it the credential used for the clone (docs/git-credentials.md). User-facing
 * failures throw `ServerError`.
 */
export async function addProject(
  remoteUrl: string,
  gitCredentialId: string,
  owner: string,
): Promise<AddProjectResult> {
  const parsed = validateGitRemoteUrl(remoteUrl)
  const name = projectNameFor(parsed.path)
  if (!name) throw new ServerError('VALIDATION', `no project name can be derived from "${parsed.path}"`)

  await ensureDataDir()
  const { credential, knownHostsEntry } = await resolveCredentialForRemote(owner, gitCredentialId, remoteUrl)

  const project = await setUpProject(name, owner, { gitCredential: { id: gitCredentialId, knownHostsEntry } }, async (projectId) => {
    try {
      await cloneRepo(remoteUrl, repoDir(projectId), credential)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (isGitAuthError(message)) {
        throw new ServerError(
          'VALIDATION',
          `git authentication failed for ${parsed.host} — the credential was rejected `
          + '(a revoked token, or a key not yet registered with the host?).',
        )
      }
      throw new ServerError('INTERNAL', `Failed to clone: ${message}`)
    }
    return remoteUrl
  })
  return { project, knownHostsEntry }
}

/**
 * Create an empty project whose remote the server hosts
 * (docs/hosted-projects.md). Its main clone is cloned from the hosted bare
 * repository like any other remote, so everything downstream runs as for a
 * cloned project.
 */
export async function createHostedProject(rawName: string, owner: string): Promise<ProjectMeta> {
  const name = projectNameFor(rawName.trim())
  if (!name) throw new ServerError('VALIDATION', `"${rawName}" is not a usable project name`)
  await ensureDataDir()
  return setUpProject(name, owner, { hosted: true }, async (projectId) => {
    const hosted = hostedRepoDir(projectId)
    try {
      await fs.mkdir(path.dirname(hosted), { recursive: true })
      await initHostedRepo(hosted)
      await cloneRepo(hosted, repoDir(projectId), { kind: 'hosted' })
    } catch (err) {
      throw new ServerError('INTERNAL', `Failed to create the repository: ${err instanceof Error ? err.message : String(err)}`)
    }
    return hostedRemoteUrl(projectId)
  })
}

/**
 * Share a hosted project with another user (docs/hosted-projects.md
 * "Sharing"): give them a project of their own under the same name, whose
 * remote is this project's repository. Sharing again with a user whose
 * share was removed gives that share back, workspaces and all. Only the
 * owner shares, and only a project created in yaac that is not itself a
 * share.
 */
export async function shareProject(principal: Actor, projectId: string, userId: string): Promise<ProjectMeta> {
  const row = await getProjectRow(projectId)
  if (!row) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  await authorizeProject(principal, projectId)
  if (!row.hosted || row.sharedFrom !== undefined) {
    throw new ServerError('VALIDATION', `"${row.name}" can't be shared: only a project created in yaac can be, by its owner.`)
  }
  if (userId === row.owner) throw new ServerError('VALIDATION', `"${row.name}" is already yours`)
  if (!(await listUsers()).some((u) => u.id === userId)) throw new ServerError('NOT_FOUND', `user ${userId} not found`)
  const existing = (await listProjectRows()).find((r) => r.sharedFrom === projectId && r.owner === userId)
  if (existing) {
    if (existing.shareRevoked) await setProjectShareRevoked(existing.id, false)
    return { id: existing.id, name: existing.name, remoteUrl: existing.remoteUrl, addedAt: existing.addedAt }
  }
  return setUpProject(row.name, userId, { hosted: true, sharedFrom: projectId }, async (shareId) => {
    try {
      await cloneRepo(hostedRepoDir(projectId), repoDir(shareId), { kind: 'hosted' })
    } catch (err) {
      throw new ServerError('INTERNAL', `Failed to clone the repository: ${err instanceof Error ? err.message : String(err)}`)
    }
    return hostedRemoteUrl(shareId)
  })
}

/**
 * What every way of adding a project shares: a new id, the project dir,
 * `makeRepo` to fill its main clone (returning the remote URL to record),
 * the tool-auth placeholders, and the row. A failure removes the project
 * dir and any hosted remote, since files without a row couldn't be listed,
 * removed or re-added.
 */
async function setUpProject(
  name: string,
  owner: string,
  record: { hosted?: boolean; sharedFrom?: string; gitCredential?: { id: string; knownHostsEntry: string | null } },
  makeRepo: (projectId: string) => Promise<string>,
): Promise<ProjectMeta> {
  const projectId = crypto.randomUUID()
  const dir = projectDir(projectId)
  await fs.mkdir(dir, { recursive: true })
  try {
    const remoteUrl = await makeRepo(projectId)
    const meta: ProjectMeta = { id: projectId, name, remoteUrl, addedAt: new Date().toISOString() }
    await fs.mkdir(claudeDir(projectId), { recursive: true })

    const claudeCreds = await getToolCredential(owner, 'claude')
    if (claudeCreds?.kind === 'oauth') {
      await writeProjectClaudePlaceholder(projectId, claudeCreds.claudeAiOauth)
    }

    const codexCreds = await getToolCredential(owner, 'codex')
    if (codexCreds?.kind === 'oauth') {
      await writeProjectCodexPlaceholder(projectId, codexCreds.codexOauth)
    }

    await recordProject({ ...meta, hosted: record.hosted === true, sharedFrom: record.sharedFrom }, owner, record.gitCredential)
    return meta
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true })
    await fs.rm(hostedRepoDir(projectId), { recursive: true, force: true })
    throw err
  }
}

/**
 * Record a project whose checkout is already staged in the data dir under
 * `id`, without cloning; test suites use this for local repos. Refuses a
 * remote `project add` would reject, a missing staged checkout, and an id
 * already recorded.
 */
export async function registerStagedProject(
  id: string,
  name: string,
  remoteUrl: string,
  owner: string,
): Promise<ProjectMeta> {
  // The remote decides every later fetch's transport, so validate it as
  // `addProject` does.
  validateGitRemoteUrl(remoteUrl)
  try {
    await fs.access(repoDir(id))
  } catch {
    throw new ServerError('NOT_FOUND', `no checkout is staged for project ${id}`)
  }
  if (await getProjectRow(id)) {
    throw new ServerError('CONFLICT', `Project ${id} already exists`)
  }
  const meta: ProjectMeta = { id, name, remoteUrl, addedAt: new Date().toISOString() }
  await recordProject(meta, owner)
  return meta
}
