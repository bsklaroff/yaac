import { api } from '#commands/api'
import { printTable } from '#commands/table'

/**
 * `yaac workspace conversations <id>`: list a workspace's agent
 * conversations, its history. Live ones come first; the rest were left
 * behind by a `/clear` or a closed session. The id column is the tool's own
 * conversation id, which `yaac workspace create --workspace <id> --resume`
 * takes.
 */
export async function workspaceConversations(idOrName: string): Promise<void> {
  const conversations = await api.workspace[':id'].conversations.$get({
    param: { id: idOrName },
  })

  if (conversations.length === 0) {
    console.log(`No conversations recorded for workspace "${idOrName}".`)
    return
  }

  const sorted = [...conversations].sort((a, b) =>
    Number(b.active) - Number(a.active) || a.ordinal - b.ordinal)

  printTable(
    [{ header: 'CONVERSATION' }, { header: 'TOOL' }, { header: 'STATE' }, { header: 'SESSION' }, { header: 'FIRST MESSAGE' }],
    sorted.map((c) => [
      c.conversationId,
      c.tool,
      c.active ? 'live' : 'ended',
      c.sessionId?.slice(0, 8) ?? '',
      c.prompt ?? '',
    ]),
  )
}
