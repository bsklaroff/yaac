import { resolveContainerAnyState } from '@/lib/container-resolve'
import { cleanupSession } from '@/lib/session-cleanup'

export async function sessionDelete(idOrName: string): Promise<void> {
  const resolved = await resolveContainerAnyState(idOrName)
  if (!resolved) return

  await cleanupSession({
    containerName: resolved.name,
    projectSlug: resolved.projectSlug,
    sessionId: resolved.sessionId,
  })
}
