import { api } from '#commands/api'

export async function projectList(): Promise<void> {
  const projects = await api.project.list.$get()

  if (projects.length === 0) {
    console.log('No projects found. Add one with: yaac project add <remote-url> <credential>')
    return
  }

  // The id prefix tells apart projects that share a name; any command taking
  // a project accepts either.
  console.log('')
  console.log(`${'PROJECT'.padEnd(20)} ${'ID'.padEnd(10)} ${'REMOTE'.padEnd(50)} WORKSPACES`)
  console.log(`${'-'.repeat(20)} ${'-'.repeat(10)} ${'-'.repeat(50)} ${'-'.repeat(10)}`)
  for (const p of projects) {
    console.log(`${p.name.padEnd(20)} ${p.id.slice(0, 8).padEnd(10)} ${p.remoteUrl.padEnd(50)} ${p.workspaceCount}`)
  }
  console.log('')
}
