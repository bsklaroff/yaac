import fs from 'node:fs/promises'
import path from 'node:path'
import { ensureDataDir, projectDir, repoDir, claudeDir } from '@/lib/project/paths'
import { cloneRepo } from '@/lib/git'
import { parseGitRemote, resolveCredentialForUrl } from '@/lib/project/credentials'
import {
  loadClaudeCredentialsFile,
  loadCodexCredentialsFile,
  writeProjectClaudePlaceholder,
  writeProjectCodexPlaceholder,
} from '@/lib/project/tool-auth'
import { DaemonError } from '@/daemon/errors'
import type { ProjectMeta } from '@/shared/types'

function deriveSlug(remoteUrl: string): string {
  const lastSegment = remoteUrl.split('/').pop() ?? remoteUrl
  return lastSegment.replace(/\.git$/, '')
}

/**
 * Expand `owner/repo` shorthand to a full GitHub HTTPS URL. Unchanged from
 * the github-only era — this is a CLI ergonomic convenience, not a default.
 */
export function expandOwnerRepo(input: string): string {
  if (input.includes('://') || input.includes('@')) return input
  const parts = input.split('/')
  if (parts.length === 2 && parts[0] && parts[1]) {
    return `https://github.com/${parts[0]}/${parts[1]}`
  }
  return input
}

/**
 * Validate a git remote URL. Accepts the two `parseGitRemote` forms:
 *   - https://<host>/<owner>/<repo>[.git]
 *   - SCP-style: git@<host>:<owner>/<repo>[.git]
 * Rejects http://, ssh://, custom ports, and unparseable input.
 */
export function validateGitRemoteUrl(url: string): void {
  try {
    parseGitRemote(url)
  } catch (err) {
    throw new DaemonError(
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
 * `DaemonError` for user-facing failures (bad URL, duplicate slug,
 * missing credential, clone failure) so the daemon can map them to
 * the right HTTP status and CLI exit code.
 */
export async function addProject(input: string): Promise<AddProjectResult> {
  const remoteUrl = expandOwnerRepo(input)
  validateGitRemoteUrl(remoteUrl)

  const slug = deriveSlug(remoteUrl)
  const dir = projectDir(slug)

  await ensureDataDir()

  try {
    await fs.access(dir)
    throw new DaemonError('CONFLICT', `Project "${slug}" already exists at ${dir}`)
  } catch (err) {
    if (err instanceof DaemonError) throw err
    // doesn't exist — good
  }

  const credential = await resolveCredentialForUrl(remoteUrl)
  if (!credential) {
    throw new DaemonError(
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
    throw new DaemonError('INTERNAL', `Failed to clone: ${message}`)
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
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(meta, null, 2) + '\n')

  return { project: meta }
}
