import { getRpcClient } from '#commands/rpc'

export async function projectList(): Promise<void> {
  const client = await getRpcClient()
  const projects = await client.project.list.$get().then((r) => r.json())

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
