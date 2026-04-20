import fs from 'node:fs/promises'
import path from 'node:path'
import { podman } from '@/lib/container/runtime'
import { getDataDir, projectDir } from '@/lib/project/paths'
import { cleanupSession } from '@/lib/session/cleanup'
import { DaemonError } from '@/daemon/errors'

/**
 * Tear down every live session for a project, then remove the project
 * directory entirely. Throws `NOT_FOUND` if the project does not exist.
 */
export async function removeProject(slug: string): Promise<void> {
  const dir = projectDir(slug)
  try {
    await fs.access(path.join(dir, 'project.json'))
  } catch {
    throw new DaemonError('NOT_FOUND', `project ${slug} not found`)
  }

  let containers: Awaited<ReturnType<typeof podman.listContainers>> = []
  try {
    containers = await podman.listContainers({
      all: true,
      filters: { label: [`yaac.data-dir=${getDataDir()}`, `yaac.project=${slug}`] },
    })
  } catch {
    // podman unavailable — skip container cleanup, still nuke the dir.
  }

  for (const c of containers) {
    const name = c.Names?.[0]?.replace(/^\//, '') ?? c.Id
    const sessionId = c.Labels?.['yaac.session-id'] ?? ''
    try {
      await cleanupSession({ containerName: name, projectSlug: slug, sessionId })
    } catch {
      // best-effort cleanup — continue with the next container
    }
  }

  await fs.rm(dir, { recursive: true, force: true })
}
