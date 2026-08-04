import fs from 'node:fs/promises'
import path from 'node:path'
import { type SessionPod, listSessionPods } from '#platform/k8s'
import { removeProjectRegistry } from '#features/cluster'
import { projectDir } from '@yaac/shared/project-paths'
import { cleanupSessionDetached } from '#features/sessions/cleanup'
import { deleteProjectWorktrees } from '#features/sessions/worktree-store'
import { deleteProjectAgentSessions } from '#features/sessions/agent-session-store'
import { ServerError } from '@yaac/shared/errors'

/**
 * Tear down every live session for a project, then remove the project
 * directory entirely. Throws `NOT_FOUND` if the project does not exist.
 */
export async function removeProject(slug: string): Promise<void> {
  const dir = projectDir(slug)
  try {
    await fs.access(path.join(dir, 'project.json'))
  } catch {
    throw new ServerError('NOT_FOUND', `project ${slug} not found`)
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
  // the server-start orphan GC sweeps anything this misses, since the
  // project dir is gone after the rm below.
  try {
    await removeProjectRegistry(slug)
  } catch {
    // cluster unavailable — the orphan GC will catch it
  }

  // Forget the project's sessions: the deleted listing is driven by rows
  // now, and the worktrees and transcripts they point at go with the dir
  // below — leaving them would list sessions whose restart resolves into a
  // project that no longer exists.
  await deleteProjectWorktrees(slug)
  await deleteProjectAgentSessions(slug)

  await fs.rm(dir, { recursive: true, force: true })
}
