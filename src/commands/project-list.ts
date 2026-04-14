import fs from 'node:fs/promises'
import path from 'node:path'
import { getDataDir, getProjectsDir } from '@/lib/project/paths'
import { podman } from '@/lib/container/runtime'
import type { ProjectMeta } from '@/types'

export async function projectList(): Promise<void> {
  const projectsDir = getProjectsDir()

  let entries: string[]
  try {
    entries = await fs.readdir(projectsDir)
  } catch {
    console.log('No projects found. Add one with: yaac project add <remote-url>')
    return
  }

  const projects: Array<{ slug: string; remote: string; sessions: number }> = []

  // Get running yaac containers
  let containerCounts: Record<string, number> = {}
  try {
    const containers = await podman.listContainers({
      all: true,
      filters: { label: [`yaac.data-dir=${getDataDir()}`] },
    })
    for (const c of containers) {
      const proj = c.Labels?.['yaac.project']
      if (proj) {
        containerCounts[proj] = (containerCounts[proj] ?? 0) + 1
      }
    }
  } catch {
    // podman not available — just show 0 sessions
    containerCounts = {}
  }

  for (const entry of entries) {
    const metaPath = path.join(projectsDir, entry, 'project.json')
    try {
      const raw = await fs.readFile(metaPath, 'utf8')
      const meta = JSON.parse(raw) as ProjectMeta
      projects.push({
        slug: meta.slug,
        remote: meta.remoteUrl,
        sessions: containerCounts[meta.slug] ?? 0,
      })
    } catch {
      // skip malformed entries
    }
  }

  if (projects.length === 0) {
    console.log('No projects found. Add one with: yaac project add <remote-url>')
    return
  }

  console.log('')
  console.log(`${'PROJECT'.padEnd(20)} ${'REMOTE'.padEnd(50)} SESSIONS`)
  console.log(`${'-'.repeat(20)} ${'-'.repeat(50)} ${'-'.repeat(8)}`)
  for (const p of projects) {
    console.log(`${p.slug.padEnd(20)} ${p.remote.padEnd(50)} ${p.sessions}`)
  }
  console.log('')
}
