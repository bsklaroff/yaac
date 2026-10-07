import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { ensureDataDir, projectDir, repoDir, claudeDir } from '@yaac/shared/project-paths'
import { cloneRepo, isGitAuthError } from '#domain/git'
import { parseGitRemote, resolveCredentialForRemote } from './credentials'
import { getProjectRow, recordProject } from '#db'
import {
  loadClaudeCredentialsFile,
  loadCodexCredentialsFile,
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
  const projectId = crypto.randomUUID()
  const dir = projectDir(projectId)

  await ensureDataDir()

  const { credential, knownHostsEntry } = await resolveCredentialForRemote(gitCredentialId, remoteUrl)

  await fs.mkdir(dir, { recursive: true })

  try {
    await cloneRepo(remoteUrl, repoDir(projectId), credential)
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true })
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

  const meta: ProjectMeta = {
    id: projectId,
    name,
    remoteUrl,
    addedAt: new Date().toISOString(),
  }
  try {
    await fs.mkdir(claudeDir(projectId), { recursive: true })

    const claudeCreds = await loadClaudeCredentialsFile()
    if (claudeCreds?.kind === 'oauth') {
      await writeProjectClaudePlaceholder(projectId, claudeCreds.claudeAiOauth)
    }

    const codexCreds = await loadCodexCredentialsFile()
    if (codexCreds?.kind === 'oauth') {
      await writeProjectCodexPlaceholder(projectId, codexCreds.codexOauth)
    }

    await recordProject(meta, owner, { id: gitCredentialId, knownHostsEntry })
  } catch (err) {
    // A directory without a row couldn't be listed, removed or re-added, so
    // clean it up.
    await fs.rm(dir, { recursive: true, force: true })
    throw err
  }

  return { project: meta, knownHostsEntry }
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
