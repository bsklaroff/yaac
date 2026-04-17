import { resolveContainerAnyState } from '@/lib/container/resolve'
import { cleanupSessionDetached } from '@/lib/session/cleanup'

export async function sessionDelete(idOrName: string): Promise<void> {
  const resolved = await resolveContainerAnyState(idOrName)
  if (!resolved) return

  console.log(`Session ${resolved.sessionId} scheduled for cleanup.`)
  await cleanupSessionDetached({
    containerName: resolved.name,
    projectSlug: resolved.projectSlug,
    sessionId: resolved.sessionId,
  })
}
