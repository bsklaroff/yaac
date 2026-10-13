import { api } from '#commands/api'
import { printTable } from '#commands/table'

/**
 * `yaac workspace agents <id>`: list a workspace's agent conversations.
 *
 * Active ones come first, since a restart brings those back; the rest are
 * history (left behind by `/clear` or a closed window). The id column is the
 * tool's own conversation id, for resuming one by hand inside the workspace.
 */
export async function workspaceAgents(idOrName: string): Promise<void> {
  const agents = await api.workspace[':id']['agent-sessions'].$get({
    param: { id: idOrName },
  })

  if (agents.length === 0) {
    console.log(`No agent sessions recorded for workspace "${idOrName}".`)
    return
  }

  const sorted = [...agents].sort((a, b) =>
    Number(b.active) - Number(a.active) || a.ordinal - b.ordinal)

  printTable(
    [{ header: 'AGENT SESSION' }, { header: 'TOOL' }, { header: 'STATE' }, { header: 'FIRST MESSAGE' }],
    sorted.map((a) => [a.agentSessionId, a.tool, a.active ? 'open' : 'closed', a.prompt ?? '']),
  )
}
