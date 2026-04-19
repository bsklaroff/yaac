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
  // If it looks like a URL or SSH-style, don't expand
  if (input.includes('://') || input.includes('@')) return input
  const parts = input.split('/')
  if (parts.length === 2 && parts[0] && parts[1]) {
    return `https://github.com/${parts[0]}/${parts[1]}`
  }
  return input
}

export function validateGithubHttpsUrl(url: string): void {
  // Detect SSH-style URLs first (git@github.com:org/repo)
  if (url.match(/^[\w-]+@[\w.-]+:/)) {
    throw new Error(
      'Only HTTPS GitHub URLs are supported. Use https://github.com/owner/repo or owner/repo instead of SSH URLs.',
    )
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(
      `Invalid URL: "${url}". Use an HTTPS GitHub URL like https://github.com/owner/repo, or just owner/repo.`,
    )
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(
      'Only HTTPS GitHub URLs are supported. Use https://github.com/owner/repo or owner/repo instead.',
    )
  }

  if (parsed.hostname !== 'github.com' && !parsed.hostname.endsWith('.github.com')) {
    throw new Error(
      'Only GitHub repositories are supported (github.com).',
    )
  }
}

export async function projectAdd(input: string): Promise<void> {
  const remoteUrl = expandOwnerRepo(input)

  try {
    validateGithubHttpsUrl(remoteUrl)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
    return
  }

  const slug = deriveSlug(remoteUrl)
  const dir = projectDir(slug)

  await ensureDataDir()

  // Check for duplicate
  try {
    await fs.access(dir)
    console.error(`Project "${slug}" already exists at ${dir}`)
    process.exitCode = 1
    return
  } catch {
    // doesn't exist — good
  }

  const token = await resolveTokenForUrl(remoteUrl)
  if (!token) {
    console.error(`No GitHub token configured for ${remoteUrl}. Run "yaac auth update" to add one.`)
    process.exitCode = 1
    return
  }

  console.log(`Cloning ${remoteUrl} into ${slug}...`)
  await fs.mkdir(dir, { recursive: true })

  try {
    await cloneRepo(remoteUrl, repoDir(slug), token)
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true })
    const message = err instanceof Error ? err.message : String(err)
    console.error(`Failed to clone: ${message}`)
    process.exitCode = 1
    return
  }

  await fs.mkdir(claudeDir(slug), { recursive: true })

  // Seed a placeholder .credentials.json if the host has Claude OAuth creds,
  // so Claude Code inside the new session finds a bundle without ever seeing
  // the real tokens.
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

  console.log(`Project "${slug}" added successfully.`)
}
