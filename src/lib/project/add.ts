import fs from 'node:fs/promises'
import path from 'node:path'
import { ensureDataDir, projectDir, repoDir, claudeDir } from '@/lib/project/paths'
import { cloneRepo } from '@/lib/git'
import { resolveTokenForUrl } from '@/lib/project/credentials'
import {
  loadClaudeCredentialsFile,
  loadCodexCredentialsFile,
  writeProjectClaudePlaceholder,
  writeProjectCodexPlaceholder,
} from '@/lib/project/tool-auth'
import { DaemonError } from '@/lib/daemon/errors'
import type { ProjectMeta } from '@/types'

function deriveSlug(remoteUrl: string): string {
  const lastSegment = remoteUrl.split('/').pop() ?? remoteUrl
  return lastSegment.replace(/\.git$/, '')
}

/**
 * Expand owner/repo shorthand to a full GitHub HTTPS URL.
 * Returns the input unchanged if it's already a URL.
 */
export function expandOwnerRepo(input: string): string {
  if (input.includes('://') || input.includes('@')) return input
  const parts = input.split('/')
  if (parts.length === 2 && parts[0] && parts[1]) {
    return `https://github.com/${parts[0]}/${parts[1]}`
  }
  return input
}

export function validateGithubHttpsUrl(url: string): void {
  if (url.match(/^[\w-]+@[\w.-]+:/)) {
    throw new DaemonError(
      'VALIDATION',
      'Only HTTPS GitHub URLs are supported. Use https://github.com/owner/repo or owner/repo instead of SSH URLs.',
    )
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new DaemonError(
      'VALIDATION',
      `Invalid URL: "${url}". Use an HTTPS GitHub URL like https://github.com/owner/repo, or just owner/repo.`,
    )
  }

  if (parsed.protocol !== 'https:') {
    throw new DaemonError(
      'VALIDATION',
      'Only HTTPS GitHub URLs are supported. Use https://github.com/owner/repo or owner/repo instead.',
    )
  }

  if (parsed.hostname !== 'github.com' && !parsed.hostname.endsWith('.github.com')) {
    throw new DaemonError(
      'VALIDATION',
      'Only GitHub repositories are supported (github.com).',
    )
  }
}

export interface AddProjectResult {
  project: ProjectMeta
}

/**
 * Clone a GitHub repo into the data dir as a yaac project. Throws
 * `DaemonError` for user-facing failures (bad URL, duplicate slug,
 * missing GitHub token, clone failure) so the daemon can map them to
 * the right HTTP status and CLI exit code.
 */
export async function addProject(input: string): Promise<AddProjectResult> {
  const remoteUrl = expandOwnerRepo(input)
  validateGithubHttpsUrl(remoteUrl)

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

  const token = await resolveTokenForUrl(remoteUrl)
  if (!token) {
    throw new DaemonError(
      'AUTH_REQUIRED',
      `No GitHub token configured for ${remoteUrl}. Run "yaac auth update" to add one.`,
    )
  }

  await fs.mkdir(dir, { recursive: true })

  try {
    await cloneRepo(remoteUrl, repoDir(slug), token)
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
