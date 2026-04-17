import { isTmuxSessionAlive, cleanupSessionDetached } from '@/lib/session/cleanup'
import { getSessionFirstMessage } from '@/lib/session/status'
import type { AgentTool } from '@/types'

export type AttachOutcome = 'detached' | 'closed_blank' | 'closed_prompted'

interface FinalizeAttachedSessionParams {
  containerName: string
  projectSlug: string
  sessionId: string
  tool: AgentTool
  cleaning?: Set<string>
}

export async function finalizeAttachedSession(params: FinalizeAttachedSessionParams): Promise<AttachOutcome> {
  const { containerName, projectSlug, sessionId, tool, cleaning } = params

  if (isTmuxSessionAlive(containerName)) {
    return 'detached'
  }

  const firstMessage = await getSessionFirstMessage(projectSlug, sessionId, tool)
  const toolLabel = tool === 'codex' ? 'Codex' : 'Claude Code'
  console.log(`${toolLabel} exited. Cleaning up session...`)
  cleaning?.add(sessionId)
  await cleanupSessionDetached({ containerName, projectSlug, sessionId })

  return firstMessage ? 'closed_prompted' : 'closed_blank'
}
