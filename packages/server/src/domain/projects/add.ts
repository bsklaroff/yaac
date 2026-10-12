import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { ensureDataDir, projectDir, repoDir, claudeDir, hostedRepoDir } from '@yaac/shared/project-paths'
import { hostedRemoteUrl } from '@yaac/shared/hosted-git'
import { cloneRepo, initHostedRepo, isGitAuthError } from '#domain/git'
import { parseGitRemote, resolveCredentialForRemote } from './credentials'
import { getProjectRow, getToolCredential, listProjectRows, recordProject } from '#db'
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
  // Its name is a hosted project's only handle (`yaac project clone`, the
  // remove confirmation), so it must name one project.
  if ((await listProjectRows()).some((r) => r.name === name)) {
    throw new ServerError('CONFLICT', `a project named "${name}" already exists`)
  }
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
 * What both ways of adding a project share: a new id, the project dir,
 * `makeRepo` to fill its main clone (returning the remote URL to record),
 * the tool-auth placeholders, and the row. A failure removes the project
 * dir and any hosted remote, since files without a row couldn't be listed,
 * removed or re-added.
 */
async function setUpProject(
  name: string,
  owner: string,
  record: { hosted?: boolean; gitCredential?: { id: string; knownHostsEntry: string | null } },
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

    await recordProject({ ...meta, hosted: record.hosted === true }, owner, record.gitCredential)
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
