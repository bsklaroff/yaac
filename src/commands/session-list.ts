import { podman } from '@/lib/podman'

export async function sessionList(projectSlug?: string): Promise<void> {
  const filters: Record<string, string[]> = {
    label: ['yaac.managed=true'],
  }
  if (projectSlug) {
    filters.label.push(`yaac.project=${projectSlug}`)
  }

  let containers
  try {
    containers = await podman.listContainers({ all: true, filters })
  } catch {
    console.error('Failed to connect to Podman. Is the Podman machine running?')
    process.exitCode = 1
    return
  }

  if (containers.length === 0) {
    const suffix = projectSlug ? ` for project "${projectSlug}"` : ''
    console.log(`No active sessions${suffix}. Create one with: yaac session create <project>`)
    return
  }

  console.log('')
  console.log(`${'SESSION'.padEnd(12)} ${'PROJECT'.padEnd(20)} ${'CONTAINER'.padEnd(35)} ${'STATUS'.padEnd(12)} CREATED`)
  console.log(`${'-'.repeat(12)} ${'-'.repeat(20)} ${'-'.repeat(35)} ${'-'.repeat(12)} ${'-'.repeat(20)}`)

  for (const c of containers) {
    const sessionId = c.Labels?.['yaac.session-id'] ?? '?'
    const project = c.Labels?.['yaac.project'] ?? '?'
    const name = c.Names?.[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12)
    const status = c.State ?? 'unknown'
    const created = new Date(c.Created * 1000).toISOString().replace('T', ' ').slice(0, 19)
    console.log(`${sessionId.padEnd(12)} ${project.padEnd(20)} ${name.padEnd(35)} ${status.padEnd(12)} ${created}`)
  }
  console.log('')
}
