import { getRpcClient, toClientError } from '@/lib/daemon-client'

export async function sessionDelete(idOrName: string): Promise<void> {
  const client = await getRpcClient()
  const res = await client.session.delete.$post({ json: { sessionId: idOrName } })
  if (!res.ok) throw await toClientError(res)
  const info = await res.json()
  console.log(`Session ${info.sessionId} scheduled for cleanup.`)
}
