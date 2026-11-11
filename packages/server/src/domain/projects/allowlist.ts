import { addProjectEgressHost, getProjectRow, setProjectEgressAllowlist, type RepoRow } from '#db'
import { ServerError } from '@yaac/shared/errors'
import { assertProjectExists } from './detail'
import type { EgressAllowlist } from '@yaac/shared/types'
import { authorizeProject, type Actor } from '#domain/access'
import { workspacesSandboxed } from '#drivers/driver'
import { repoHostToAllow } from '@yaac/shared/allowed-hosts'

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
  const saved = { hosts: [...new Set(allowlist.hosts.map(checkedHost))], defaults: allowlist.defaults }
  await setProjectEgressAllowlist(projectId, saved)
  return saved
}

/** Add one host to the project's allowlist, so future workspaces inherit
 *  it. No-op if already present. */
export async function addAllowedHostToProject(principal: Actor, projectId: string, host: string): Promise<void> {
  await assertProjectExists(projectId)
  await authorizeProject(principal, projectId)
  await addProjectEgressHost(projectId, checkedHost(host))
}

/** A host as the allowlist stores it: trimmed and lowercased, and refused
 *  unless `HOST_PATTERN` reads it. */
function checkedHost(host: string): string {
  const name = host.trim().toLowerCase()
  if (!HOST_PATTERN.test(name)) {
    throw new ServerError('VALIDATION', `"${name}" is not a bare hostname or wildcard pattern`)
  }
  return name
}

/**
 * Add the host of a repo just linked into a project to the project's
 * allowlist when the list does not admit it, since a workspace could not
 * fetch the repo otherwise. Answers the host added, for the client to tell
 * the user, or null when nothing changed: the repo is hosted, the host is
 * already allowed or no literal hostname (`repoHostToAllow`), or
 * workspaces run without an egress proxy. The caller has already
 * authorized the link.
 */
export async function allowRepoHost(projectId: string, repo: RepoRow): Promise<string | null> {
  if (repo.hosted || !workspacesSandboxed()) return null
  const host = repoHostToAllow(await getProjectAllowlist(projectId), repo.remoteUrl)
  if (host !== null) await addProjectEgressHost(projectId, host)
  return host
}
