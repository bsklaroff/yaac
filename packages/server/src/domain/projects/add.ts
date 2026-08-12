import fs from 'node:fs/promises'
import path from 'node:path'
import { ensureDataDir, projectDir, repoDir, claudeDir } from '@yaac/shared/project-paths'
import { cloneRepo, isGitAuthError } from '#domain/git'
import { parseGitRemote, resolveCredentialForUrl } from './credentials'
import { getProjectRow, recordProject } from '#db'
import {
  loadClaudeCredentialsFile,
  loadCodexCredentialsFile,
  writeProjectClaudePlaceholder,
  writeProjectCodexPlaceholder,
} from '@yaac/shared/tool-auth'
import { ServerError } from '@yaac/shared/errors'
import type { ProjectMeta } from '@yaac/shared/types'

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
}

/**
 * Clone a git repo into the data dir as a yaac project. Throws
 * `ServerError` for user-facing failures (bad URL, duplicate slug,
 * missing credential, clone failure) so the server can map them to
 * the right HTTP status and CLI exit code.
 */
export async function addProject(remoteUrl: string): Promise<AddProjectResult> {
  const parsed = validateGitRemoteUrl(remoteUrl)
  // The slug is baked into image tags (yaac-user-<slug>:<hash>), which Docker/
  // Podman require to be all-lowercase. URL and credential-pattern case is
  // preserved everywhere else.
  const slug = (parsed.path.split('/').pop() as string).toLowerCase()
  const dir = projectDir(slug)

  await ensureDataDir()

  // The record is the authority on what exists, so a duplicate is refused
  // from it rather than from a directory the server may not share. The
  // directory check stays as a second guard: a clone into an occupied dir
  // would fail confusingly, and an adopted-but-unrecorded dir is exactly
  // what the adoption shim is for.
  if (await getProjectRow(slug)) {
    throw new ServerError('CONFLICT', `Project "${slug}" already exists`)
  }
  try {
    await fs.access(dir)
    throw new ServerError('CONFLICT', `Project "${slug}" already exists at ${dir}`)
  } catch (err) {
    if (err instanceof ServerError) throw err
    // doesn't exist — good
  }

  const credential = await resolveCredentialForUrl(remoteUrl)
  if (!credential) {
    throw new ServerError(
      'AUTH_REQUIRED',
      `No git credential configured for ${remoteUrl}. Run "yaac auth update" to add one.`,
    )
  }

  await fs.mkdir(dir, { recursive: true })

  try {
    await cloneRepo(remoteUrl, repoDir(slug), credential)
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true })
    const message = err instanceof Error ? err.message : String(err)
    if (isGitAuthError(message)) {
      throw new ServerError(
        'AUTH_REQUIRED',
        `git authentication failed for ${parsed.host} — the stored credential was rejected `
        + '(expired or revoked token?). Run "yaac auth update" to replace it, then retry.',
      )
    }
    throw new ServerError('INTERNAL', `Failed to clone: ${message}`)
  }

  await fs.mkdir(claudeDir(slug), { recursive: true })

  const claudeCreds = await loadClaudeCredentialsFile()
  if (claudeCreds?.kind === 'oauth') {
    await writeProjectClaudePlaceholder(slug, claudeCreds.claudeAiOauth)
  }

  const codexCreds = await loadCodexCredentialsFile()
  if (codexCreds?.kind === 'oauth') {
    await writeProjectCodexPlaceholder(slug, codexCreds.codexOauth)
  }

  const meta: ProjectMeta = {
    slug,
    remoteUrl,
    addedAt: new Date().toISOString(),
  }
  // Both: the row is what the server answers from, and `project.json` is
  // what the adoption shim reads on a data dir an older yaac wrote.
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(meta, null, 2) + '\n')
  await recordProject(meta)

  return { project: meta }
}
