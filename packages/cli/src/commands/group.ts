import { api } from '#commands/api'
import { normalizeTitle } from '@yaac/shared/titles'
import type { WorkspaceGroupSummary, WorkspaceListEntry } from '@yaac/shared/types'

/**
 * `yaac group …`: manage the named sidebar groups a project's workspaces are
 * filed under.
 *
 * Groups are addressed by name, since that is all a user (or an agent using
 * `yaac-mama`) sees. The server resolves names (`resolveGroup`) and refuses
 * an ambiguous one.
 */

export async function groupCreate(projectSlug: string, name: string): Promise<void> {
  // Idempotent, like `yaac-mama group create`. A duplicate name would make
  // later `move` and `delete` calls ambiguous.
  const { groups } = await api.workspace.group.list.$get({ query: { project: projectSlug } })
  const existing = resolveLocally(groups, name)
  if (existing.length > 0) {
    console.log(`Group "${existing[0].name}" already exists in ${projectSlug} (${existing[0].groupId}).`)
    return
  }
  const created = await api.workspace.group.create.$post({
    json: { projectSlug, name },
  })
  // Print the server's normalized name, not the typed one.
  console.log(`Created group "${created.name}" in ${projectSlug} (${created.groupId}).`)
}

export async function groupList(projectSlug?: string): Promise<void> {
  const [{ groups }, running] = await Promise.all([
    api.workspace.group.list.$get({ query: projectSlug ? { project: projectSlug } : {} }),
    api.workspace.list.$get({ query: projectSlug ? { project: projectSlug } : {} }),
  ])

  if (groups.length === 0) {
    const suffix = projectSlug ? ` in project "${projectSlug}"` : ''
    console.log(`No workspace groups${suffix}. Create one with: yaac group create <project> <name>`)
    return
  }
  renderGroups(groups, running.workspaces)
}

export async function groupMove(
  workspaceId: string,
  group: string | undefined,
  options: { project?: string } = {},
): Promise<void> {
  const projectSlug = options.project ?? await projectOfWorkspace(workspaceId)
  if (!projectSlug) {
    throw new Error(
      `Could not find a running workspace "${workspaceId}". Pass --project <slug> to move a `
      + 'stopped one.',
    )
  }
  // No group (or `--`) returns the workspace to the default list. An unknown
  // name creates the group, as `--group` does on workspace create.
  const target = group === undefined || group === '--' ? null : group
  const moved = await api.workspace.group.move.$post({
    json: { projectSlug, workspaceId, group: target, create: true },
  })
  // Print the resolved name, so a group passed by id doesn't echo a uuid.
  console.log(target === null
    ? `Moved ${workspaceId.slice(0, 8)} out of its group.`
    : `Moved ${workspaceId.slice(0, 8)} into "${moved.name ?? target}".`)
}

export async function groupDelete(projectSlug: string, group: string): Promise<void> {
  const { groups } = await api.workspace.group.list.$get({ query: { project: projectSlug } })
  const matches = resolveLocally(groups, group)
  if (matches.length === 0) throw new Error(`No such group in ${projectSlug}: ${group}`)
  if (matches.length > 1) {
    throw new Error(
      `"${group}" names ${matches.length} groups in ${projectSlug} — pass the group id instead `
      + `(${matches.map((g) => g.groupId).join(', ')})`,
    )
  }
  const match = matches[0]
  await api.workspace.group.delete.$post({ json: { projectSlug, groupId: match.groupId } })
  console.log(`Deleted group "${match.name}". Its workspaces are back in the default list.`)
}

/**
 * Which project a workspace belongs to, so `yaac group move` can take an id
 * alone. Checks running workspaces, then stopped ones. `--project` covers a
 * workspace old enough to have fallen off the stopped listing.
 */
async function projectOfWorkspace(workspaceId: string): Promise<string | undefined> {
  const matches = (w: { workspaceId: string }): boolean =>
    w.workspaceId === workspaceId || w.workspaceId.startsWith(workspaceId)

  const { workspaces } = await api.workspace.list.$get({ query: {} })
  const running = workspaces.find(matches)
  if (running) return running.projectSlug

  const stopped = await api.workspace['list-stopped'].$get({ query: {} })
  return stopped.find(matches)?.projectSlug
}

/**
 * Find groups by exact id or by name, client-side, for `create` and
 * `delete`. Returns every name match so callers can detect ambiguity. Names
 * are compared after `normalizeTitle`, the normalization the server applies
 * when storing them.
 */
function resolveLocally(
  groups: WorkspaceGroupSummary[],
  group: string,
): WorkspaceGroupSummary[] {
  const byId = groups.find((g) => g.groupId === group)
  if (byId) return [byId]
  const wanted = normalizeTitle(group).toLowerCase()
  return groups.filter((g) => g.name.toLowerCase() === wanted)
}

function renderGroups(groups: WorkspaceGroupSummary[], workspaces: WorkspaceListEntry[]): void {
  const counts = new Map<string, number>()
  for (const w of workspaces) {
    if (w.groupId === undefined) continue
    counts.set(w.groupId, (counts.get(w.groupId) ?? 0) + 1)
  }

  const rows = [...groups]
    .sort((a, b) => a.projectSlug.localeCompare(b.projectSlug)
      || a.createdAt.localeCompare(b.createdAt))
    .map((g) => ({
      name: g.name,
      project: g.projectSlug,
      running: String(counts.get(g.groupId) ?? 0),
      pinned: g.pinned ? 'yes' : '',
      created: g.createdAt,
    }))

  const nameWidth = Math.max('GROUP'.length, ...rows.map((r) => r.name.length))
  const projectWidth = Math.max('PROJECT'.length, ...rows.map((r) => r.project.length))

  console.log('')
  console.log(`${'GROUP'.padEnd(nameWidth)} ${'PROJECT'.padEnd(projectWidth)} ${'RUNNING'.padEnd(7)} ${'PINNED'.padEnd(6)} CREATED`)
  console.log(`${'-'.repeat(nameWidth)} ${'-'.repeat(projectWidth)} ${'-'.repeat(7)} ${'-'.repeat(6)} ${'-'.repeat(19)}`)
  for (const r of rows) {
    console.log(`${r.name.padEnd(nameWidth)} ${r.project.padEnd(projectWidth)} ${r.running.padEnd(7)} ${r.pinned.padEnd(6)} ${r.created}`)
  }
  console.log('')
}
