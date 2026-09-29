import fs from 'node:fs/promises'
import path from 'node:path'
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
import { projectSlugFor } from '@yaac/shared/project-slug'

/**
 * Validate a git remote URL. Accepts the two `parseGitRemote` forms:
 *   - https://<host>/<path>[.git]
 *   - SCP-style: git@<host>:<path>[.git]
 * Rejects http://, ssh://, custom ports, and unparseable input. Returns the
 * parsed remote so callers can reuse it (e.g. to derive a slug).
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
  /** The host key an SSH credential's assignment trusted, for the user to
   *  compare against what the host publishes. */
  knownHostsEntry: string | null
}

/**
 * Clone a git repo into the data dir as a yaac project. Throws
 * `ServerError` for user-facing failures (bad URL, duplicate slug,
 * rejected credential, clone failure) so the server can map them to
 * the right HTTP status and CLI exit code.
 *
 * The credential the clone runs with becomes the project's
 * (docs/git-credentials.md).
 */
export async function addProject(remoteUrl: string, gitCredentialId: string): Promise<AddProjectResult> {
  const parsed = validateGitRemoteUrl(remoteUrl)
  const slug = projectSlugFor(parsed.path)
  if (!slug) throw new ServerError('VALIDATION', `no project name can be derived from "${parsed.path}"`)
  // Named in a refusal when it is not the repo name itself (`c++` → `c`),
  // or "c already exists" would answer an add of something else.
  const repoName = parsed.path.split('/').pop() as string
  const named = repoName.toLowerCase() === slug ? `Project "${slug}"` : `"${repoName}" derives project name "${slug}", which`
  const dir = projectDir(slug)

  await ensureDataDir()

  // The record is the authority on what exists, so a duplicate is refused
  // from it rather than from a directory the server may not share. The
  // directory check stays as a second guard: a clone into an occupied dir
  // would fail confusingly.
  if (await getProjectRow(slug)) {
    throw new ServerError('CONFLICT', `${named} already exists`)
  }
  try {
    await fs.access(dir)
    throw new ServerError('CONFLICT', `${named} already exists at ${dir}`)
  } catch (err) {
    if (err instanceof ServerError) throw err
    // doesn't exist — good
  }

  const { credential, knownHostsEntry } = await resolveCredentialForRemote(gitCredentialId, remoteUrl)

  await fs.mkdir(dir, { recursive: true })

  try {
    await cloneRepo(remoteUrl, repoDir(slug), credential)
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
    slug,
    remoteUrl,
    addedAt: new Date().toISOString(),
  }
  try {
    await fs.mkdir(claudeDir(slug), { recursive: true })

    const claudeCreds = await loadClaudeCredentialsFile()
    if (claudeCreds?.kind === 'oauth') {
      await writeProjectClaudePlaceholder(slug, claudeCreds.claudeAiOauth)
    }

    const codexCreds = await loadCodexCredentialsFile()
    if (codexCreds?.kind === 'oauth') {
      await writeProjectCodexPlaceholder(slug, codexCreds.codexOauth)
    }

    await recordProject(meta, { id: gitCredentialId, knownHostsEntry })
  } catch (err) {
    // A directory with no row is one nothing can list, remove or re-add
    // over, so a failed add leaves nothing behind.
    await fs.rm(dir, { recursive: true, force: true })
    throw err
  }

  return { project: meta, knownHostsEntry }
}

/**
 * Record a project whose checkout is already staged in the data dir, without
 * cloning anything — how a test suite stands a project up from a local repo
 * against a server that has no network to clone over. Refuses a slug that
 * would leave the projects dir, a remote `project add` would refuse, one
 * with no staged checkout, and one already recorded.
 */
export async function registerStagedProject(slug: string, remoteUrl: string): Promise<ProjectMeta> {
  if (path.basename(slug) !== slug || slug.startsWith('.')) {
    throw new ServerError('VALIDATION', `invalid project slug "${slug}"`)
  }
  // The recorded remote picks the transport every later fetch may use, so
  // it holds to the same shapes `addProject` accepts.
  validateGitRemoteUrl(remoteUrl)
  try {
    await fs.access(repoDir(slug))
  } catch {
    throw new ServerError('NOT_FOUND', `no checkout is staged for project "${slug}"`)
  }
  if (await getProjectRow(slug)) {
    throw new ServerError('CONFLICT', `Project "${slug}" already exists`)
  }
  const meta: ProjectMeta = { slug, remoteUrl, addedAt: new Date().toISOString() }
  await recordProject(meta)
  return meta
}
