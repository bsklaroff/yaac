import { api, resolveProject } from '#commands/api'
import type { PortForwardConfig } from '@yaac/shared/types'

/*
 * `yaac config port-forwards|cache-volumes|nested-containers|npm-cache`:
 * the settings a project's workspaces launch with besides their checkout
 * (docs/project-config.md). Each prints the setting given no value, or
 * replaces it and prints what was stored. They apply to workspaces created
 * afterwards.
 */

const APPLIES = 'Workspaces created from now on use this.'

export function formatPortForwards(ports: PortForwardConfig[]): string {
  return ports.length === 0 ? 'none' : ports.map((p) =>
    p.hostPortStart === p.containerPort ? String(p.containerPort) : `${p.containerPort} (host ${p.hostPortStart} up)`).join(', ')
}

export function formatCacheVolumes(volumes: Record<string, string>): string {
  const entries = Object.entries(volumes)
  return entries.length === 0 ? 'none' : entries.map(([name, at]) => `${name} at ${at}`).join(', ')
}

export const onOff = (on: boolean): string => (on ? 'on' : 'off')

/** `<container>` or `<container>:<host start>`, as `yaac forward -p` takes. */
function parsePortForward(arg: string): PortForwardConfig {
  const m = /^(\d+)(?::(\d+))?$/.exec(arg)
  if (!m) throw new Error(`"${arg}" is not a port or <container>:<host> pair.`)
  return { containerPort: Number(m[1]), hostPortStart: Number(m[2] ?? m[1]) }
}

export async function configPortForwards(project: string, ports: string[], opts: { none?: boolean }): Promise<void> {
  const summary = await resolveProject(project)
  if (ports.length === 0 && opts.none !== true) {
    console.log(`Forwarded ports in ${summary.name}: ${formatPortForwards(summary.portForwards)}`)
    return
  }
  if (ports.length > 0 && opts.none === true) throw new Error('Pass ports or --none, not both.')
  const stored = await api.project[':projectId']['port-forwards'].$put({
    param: { projectId: summary.id },
    json: { ports: ports.map(parsePortForward) },
  })
  console.log(`Forwarded ports in ${summary.name} are now: ${formatPortForwards(stored.portForwards)}. ${APPLIES}`)
}

export async function configCacheVolumes(project: string, volumes: string[], opts: { none?: boolean }): Promise<void> {
  const summary = await resolveProject(project)
  if (volumes.length === 0 && opts.none !== true) {
    console.log(`Cache volumes in ${summary.name}: ${formatCacheVolumes(summary.cacheVolumes)}`)
    return
  }
  if (volumes.length > 0 && opts.none === true) throw new Error('Pass volumes or --none, not both.')
  const wanted = Object.fromEntries(volumes.map((arg) => {
    const at = arg.indexOf('=')
    if (at <= 0) throw new Error(`"${arg}" is not <name>=<absolute path>.`)
    return [arg.slice(0, at), arg.slice(at + 1)]
  }))
  const stored = await api.project[':projectId']['cache-volumes'].$put({ param: { projectId: summary.id }, json: { volumes: wanted } })
  console.log(`Cache volumes in ${summary.name} are now: ${formatCacheVolumes(stored.cacheVolumes)}. ${APPLIES}`)
}

export async function configNestedContainers(project: string, state: 'on' | 'off' | undefined): Promise<void> {
  const summary = await resolveProject(project)
  if (state === undefined) {
    console.log(`Nested containers in ${summary.name}: ${onOff(summary.nestedContainers)}`)
    return
  }
  const stored = await api.project[':projectId']['nested-containers'].$put({
    param: { projectId: summary.id },
    json: { enabled: state === 'on' },
  })
  console.log(`Nested containers in ${summary.name} are now ${onOff(stored.nestedContainers)}. ${APPLIES}`)
}

export async function configNpmCache(project: string, state: 'on' | 'off' | undefined): Promise<void> {
  const summary = await resolveProject(project)
  if (state === undefined) {
    console.log(`npm cache in ${summary.name}: ${onOff(summary.npmCache)}`)
    return
  }
  const stored = await api.project[':projectId']['npm-cache'].$put({
    param: { projectId: summary.id },
    json: { enabled: state === 'on' },
  })
  console.log(`npm cache in ${summary.name} is now ${onOff(stored.npmCache)}. ${APPLIES}`)
}
