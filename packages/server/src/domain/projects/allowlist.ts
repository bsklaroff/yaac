import fs from 'node:fs/promises'
import path from 'node:path'
import { projectConfigDir } from '@yaac/shared/project-paths'
import { getProjectRow, listProjectRows, setProjectEgressAllowlist } from '#db'
import { serverLog } from '#log'
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

/** A bare hostname or wildcard pattern as `hostMatchesPattern` reads it; no
 *  scheme, path or port. */
const HOST_PATTERN = /^[a-z0-9*._-]+$/

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
    throw new ServerError('VALIDATION', `"${bad}" is not a bare hostname or *.wildcard pattern`)
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

/**
 * Move each project's `addAllowedUrls`/`setAllowedUrls` from its
 * yaac-config.json into its allowlist, then drop the two keys from the file.
 * Hosts merge with any already stored; `setAllowedUrls` turns the defaults
 * off. Entries are kept only where they keep their old effect: one the proxy
 * could never match (uppercase, a scheme, path or port) is dropped, and so is
 * a `*` that was not the whole of `setAllowedUrls`, which matched only
 * single-label names but would now allow everything. A file holding both
 * keys, which never parsed, is left for the user. Run on every start
 * (docs/legacy-compat-shims.md "Moving the egress allowlist out of
 * yaac-config.json").
 */
export async function importConfigAllowlists(): Promise<void> {
  for (const row of await listProjectRows()) {
    const file = path.join(projectConfigDir(row.id), 'yaac-config.json')
    let obj: unknown
    try {
      obj = JSON.parse(await fs.readFile(file, 'utf8'))
    } catch {
      continue
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) continue
    const { addAllowedUrls, setAllowedUrls, ...rest } = obj as Record<string, unknown>
    if (addAllowedUrls === undefined && setAllowedUrls === undefined) continue
    const listed = setAllowedUrls ?? addAllowedUrls
    if (addAllowedUrls !== undefined && setAllowedUrls !== undefined
      || !Array.isArray(listed) || !listed.every((h) => typeof h === 'string')) {
      serverLog(`[server] the allowlist in ${file} does not parse; set it in project settings`)
      continue
    }
    const onlyStar = setAllowedUrls !== undefined && listed.length === 1 && listed[0] === '*'
    const kept = listed.filter((h) => HOST_PATTERN.test(h) && (h !== '*' || onlyStar))
    const dropped = listed.filter((h) => !kept.includes(h))
    if (dropped.length > 0) {
      serverLog(`[server] dropped allowlist entries from ${file} that matched no host: ${dropped.join(', ')}`)
    }
    const current = row.egressAllowlist
    await setProjectEgressAllowlist(row.id, {
      hosts: [...new Set([...current.hosts, ...kept])],
      defaults: current.defaults && setAllowedUrls === undefined,
    })
    await fs.writeFile(file, JSON.stringify(rest, null, 2) + '\n')
    serverLog(`[server] moved the egress allowlist in ${file} to project ${row.name}'s settings`)
  }
}
