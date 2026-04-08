import fs from 'node:fs/promises'
import path from 'node:path'
import { ensureDataDir, projectDir, repoDir, claudeDir } from '@/lib/paths'
import { cloneRepo } from '@/lib/git'
import type { ProjectMeta } from '@/types'

function deriveSlug(remoteUrl: string): string {
  const lastSegment = remoteUrl.split('/').pop() ?? remoteUrl
  return lastSegment.replace(/\.git$/, '')
}

export async function projectAdd(remoteUrl: string): Promise<void> {
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

  console.log(`Cloning ${remoteUrl} into ${slug}...`)
  await fs.mkdir(dir, { recursive: true })

  try {
    await cloneRepo(remoteUrl, repoDir(slug))
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
