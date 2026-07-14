import { api } from '#commands/api'

export async function sessionDelete(idOrName: string): Promise<void> {
  const info = await api.session.delete.$post({ json: { sessionId: idOrName } })
  console.log(`Session ${info.sessionId} scheduled for cleanup.`)
}
