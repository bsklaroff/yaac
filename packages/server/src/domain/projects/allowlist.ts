import { getProjectRow, setProjectEgressAllowlist } from '#db'
import { ServerError } from '@yaac/shared/errors'
import { assertProjectExists } from './detail'
import type { EgressAllowlist } from '@yaac/shared/types'
import { authorizeProject, type Actor } from '#domain/access'

/*
 * A project's egress allowlist (docs/workspace-egress.md). It is a project
 * setting stored in the DB, like the environment, so a client on another
 * machine edits it through the API. Each workspace picks it up when it is
 * registered with the proxy, at create or claim.
 */

/** A bare hostname, IPv4 address or wildcard pattern as `hostMatchesPattern`
 *  reads it; no scheme, path or port, and no IPv6 address, since the proxy
 *  dials IPv4 only (docs/workspace-egress.md "IPv4 only"). */
export const HOST_PATTERN = /^[a-z0-9*._-]+$/

/** The project's allowlist. */
export async function getProjectAllowlist(projectId: string): Promise<EgressAllowlist> {
  const row = await getProjectRow(projectId)
  if (!row) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  return row.egressAllowlist
}

/** Replace the project's allowlist, lowercasing and de-duplicating hosts.
 *  Applies to workspaces registered afterwards. */
export async function setProjectAllowlist(
  principal: Actor,
  projectId: string,
  allowlist: EgressAllowlist,
): Promise<EgressAllowlist> {
  await assertProjectExists(projectId)
  await authorizeProject(principal, projectId)
  const hosts = [...new Set(allowlist.hosts.map((h) => h.trim().toLowerCase()))]
  const bad = hosts.find((h) => !HOST_PATTERN.test(h))
  if (bad !== undefined) {
    throw new ServerError('VALIDATION', `"${bad}" is not a bare hostname or wildcard pattern`)
  }
  const saved = { hosts, defaults: allowlist.defaults }
  await setProjectEgressAllowlist(projectId, saved)
  return saved
}

/** Add one host to the project's allowlist, so future workspaces inherit
 *  it. No-op if already present. */
export async function addAllowedHostToProject(principal: Actor, projectId: string, host: string): Promise<void> {
  const current = await getProjectAllowlist(projectId)
  await setProjectAllowlist(principal, projectId, { ...current, hosts: [...current.hosts, host] })
}
