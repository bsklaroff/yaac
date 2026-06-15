import fs from 'node:fs/promises'
import path from 'node:path'
import { listSessionPods, type SessionPod } from '@/lib/k8s/pods'
import { removeProjectRegistry } from '@/lib/k8s/project-registry'
import { projectDir } from '@/lib/project/paths'
import { cleanupSessionDetached } from '@/lib/session/cleanup'
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

  let pods: SessionPod[] = []
  try {
    pods = await listSessionPods(slug)
  } catch {
    // cluster unavailable — skip session cleanup, still nuke the dir.
  }

  for (const p of pods) {
    try {
      await cleanupSessionDetached({
        jobName: p.jobName,
        projectSlug: slug,
        sessionId: p.sessionId,
      })
    } catch {
      // best-effort cleanup — continue with the next session
    }
  }

  // Per-project push registry (virtualCluster sessions). Best-effort —
  // the daemon-start orphan GC sweeps anything this misses, since the
  // project dir is gone after the rm below.
  try {
    await removeProjectRegistry(slug)
  } catch {
    // cluster unavailable — the orphan GC will catch it
  }

  await fs.rm(dir, { recursive: true, force: true })
}
