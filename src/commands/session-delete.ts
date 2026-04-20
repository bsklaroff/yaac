import { getClient, exitOnClientError } from '@/lib/daemon-client'
import type { DeletedSessionInfo } from '@/lib/session/delete'

export async function sessionDelete(idOrName: string): Promise<void> {
  let info: DeletedSessionInfo
  try {
    const client = await getClient()
    info = await client.post<DeletedSessionInfo>('/session/delete', { sessionId: idOrName })
  } catch (err) {
    exitOnClientError(err)
  }
  console.log(`Session ${info.sessionId} scheduled for cleanup.`)
}
