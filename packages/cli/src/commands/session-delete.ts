import { getRpcClient } from '#commands/rpc'

export async function sessionDelete(idOrName: string): Promise<void> {
  const client = await getRpcClient()
  const info = await client.session.delete.$post({ json: { sessionId: idOrName } }).then((r) => r.json())
  console.log(`Session ${info.sessionId} scheduled for cleanup.`)
}
