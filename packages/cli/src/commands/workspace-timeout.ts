import { api } from '#commands/api'
import { durationOption } from '#commands/workspace-create'
import { formatInZone } from '@yaac/shared/schedule'

/**
 * `yaac workspace timeout <id> <duration|none>`: stop a running workspace
 * that long from now, or never (docs/routines.md "Timeouts").
 */
export async function workspaceTimeout(workspaceId: string, duration: string): Promise<void> {
  const timeout = duration.trim().toLowerCase() === 'none' ? null : durationOption('timeout', duration)
  const result = await api.workspace.timeout.$post({ json: { workspaceId, timeout } })
  if (result.deadline === null) {
    console.log(`Workspace ${result.workspaceId.slice(0, 8)} has no timeout.`)
    return
  }
  const zone = (await api.config['time-zone'].$get()).timeZone ?? 'UTC'
  console.log(`Workspace ${result.workspaceId.slice(0, 8)} stops at about ${formatInZone(new Date(result.deadline), zone)} ${zone}.`)
}
