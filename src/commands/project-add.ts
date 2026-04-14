import fs from 'node:fs/promises'
import path from 'node:path'
import { ensureDataDir, projectDir, repoDir, claudeDir } from '@/lib/paths'
import { cloneRepo } from '@/lib/git'
import { getGithubToken } from '@/lib/credentials'
import type { ProjectMeta } from '@/types'

function deriveSlug(remoteUrl: string): string {
  const lastSegment = remoteUrl.split('/').pop() ?? remoteUrl
  return lastSegment.replace(/\.git$/, '')
}

export function isLocalPath(url: string): boolean {
  return url.startsWith('/') || url.startsWith('./') || url.startsWith('../')
}

export function validateGithubHttpsUrl(url: string): void {
  // Allow local file paths (used in development and testing)
  if (isLocalPath(url)) return

  // Detect SSH-style URLs first (git@github.com:org/repo)
  if (url.match(/^[\w-]+@[\w.-]+:/)) {
    throw new Error(
      'Only HTTPS GitHub URLs are supported. Use https://github.com/org/repo instead of SSH URLs.',
    )
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(
      `Invalid URL: "${url}". Use an HTTPS GitHub URL like https://github.com/org/repo`,
    )
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(
      'Only HTTPS GitHub URLs are supported. Use https://github.com/org/repo instead.',
    )
  }

  if (parsed.hostname !== 'github.com' && !parsed.hostname.endsWith('.github.com')) {
    throw new Error(
      'Only GitHub repositories are supported (github.com).',
    )
  }
}

export async function projectAdd(remoteUrl: string): Promise<void> {
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

  const token = await getGithubToken()

  console.log(`Cloning ${remoteUrl} into ${slug}...`)
  await fs.mkdir(dir, { recursive: true })

  try {
    await cloneRepo(remoteUrl, repoDir(slug), token ?? undefined)
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true })
    const message = err instanceof Error ? err.message : String(err)
    console.error(`Failed to clone: ${message}`)
    process.exitCode = 1
    return
  }

  await fs.mkdir(claudeDir(slug), { recursive: true })

  const meta: ProjectMeta = {
    slug,
    remoteUrl,
    addedAt: new Date().toISOString(),
  }
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(meta, null, 2) + '\n')

  console.log(`Project "${slug}" added successfully.`)
}
