import { api, projectScope, resolveProjectId } from '#commands/api'
import type { EgressAllowlist } from '@yaac/shared/types'

/**
 * `yaac config egress-allowlist <project> [hosts...] [--none] [--defaults
 * on|off]`: show the hosts a project's workspaces may reach through the
 * egress proxy (docs/workspace-egress.md), or replace the project's own
 * hosts and turn the install's defaults on or off; each keeps its value
 * when only the other is given. k8s only: a containerless server mediates
 * no egress and refuses the route.
 */
export async function configEgressAllowlist(
  project: string,
  hosts: string[],
  opts: { none?: boolean; defaults?: 'on' | 'off' },
): Promise<void> {
  const scope = await projectScope()
  const projectId = await resolveProjectId(project, scope)
  const name = scope.all.find((p) => p.id === projectId)?.name ?? projectId
  const route = api.project[':projectId'].allowlist
  const { allowlist, defaultHosts } = await route.$get({ param: { projectId } })
  const describe = (a: EgressAllowlist): string => {
    const own = a.hosts.length === 0 ? '' : a.hosts.join(', ')
    if (a.defaults) return `the ${defaultHosts.length} default hosts${own ? `, plus ${own}` : ''}`
    return own ? `only ${own}` : 'nothing; all egress is blocked'
  }

  if (hosts.length === 0 && opts.none !== true && opts.defaults === undefined) {
    console.log(`${name}'s workspaces may reach ${describe(allowlist)}.`)
    return
  }
  if (hosts.length > 0 && opts.none === true) throw new Error('Pass hosts or --none, not both.')
  const { allowlist: stored, leavesOut } = await route.$put({
    param: { projectId },
    json: {
      hosts: opts.none === true ? [] : hosts.length > 0 ? hosts : allowlist.hosts,
      defaults: opts.defaults === undefined ? allowlist.defaults : opts.defaults === 'on',
    },
  })
  console.log(`${name}'s workspaces may now reach ${describe(stored)}. Applies to workspaces created from now on.`)
  for (const { host, label } of leavesOut) {
    console.warn(`Warning: this leaves out ${label} (${host}); agent sessions may not work without it.`)
  }
}
