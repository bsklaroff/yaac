import { getRpcClient, toClientError } from '@/commands/rpc'

export async function projectList(): Promise<void> {
  const client = await getRpcClient()
  const res = await client.project.list.$get()
  if (!res.ok) throw await toClientError(res)
  const projects = await res.json()

  if (projects.length === 0) {
    console.log('No projects found. Add one with: yaac project add <remote-url>')
    return
  }

  console.log('')
  console.log(`${'PROJECT'.padEnd(20)} ${'REMOTE'.padEnd(50)} SESSIONS`)
  console.log(`${'-'.repeat(20)} ${'-'.repeat(50)} ${'-'.repeat(8)}`)
  for (const p of projects) {
    console.log(`${p.slug.padEnd(20)} ${p.remoteUrl.padEnd(50)} ${p.sessionCount}`)
  }
  console.log('')
}
