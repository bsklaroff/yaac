import { api } from '#commands/api'
import type { WorktreeGroupSummary, WorktreeListEntry } from '@yaac/shared/types'

/**
 * `yaac group …` — the named sidebar groups a project's worktrees are filed
 * under, from the terminal.
 *
 * Groups are addressed by NAME here, never by the uuid the webapp drags
 * around: a name is the only handle a person (or an agent running
 * `yaac-mama`) has ever seen. The server resolves it (`resolveGroupId`),
 * which is also where an ambiguous name is refused rather than guessed.
 */

export async function groupCreate(projectSlug: string, name: string): Promise<void> {
  // Idempotent, like `yaac-mama group create`: the two surfaces have to agree
  // on what "create a group called X" means, and making a second group with
  // the same name only manufactures the ambiguity that `move` and `delete`
  // then have to refuse.
  const { groups } = await api.worktree.group.list.$get({ query: { project: projectSlug } })
  const existing = resolveLocally(groups, name)
  if (existing.length > 0) {
    console.log(`Group "${existing[0].name}" already exists in ${projectSlug} (${existing[0].groupId}).`)
    return
  }
  const { groupId } = await api.worktree.group.create.$post({
    json: { projectSlug, name },
  })
  console.log(`Created group "${name}" in ${projectSlug} (${groupId}).`)
}

export async function groupList(projectSlug?: string): Promise<void> {
  const [{ groups }, running] = await Promise.all([
    api.worktree.group.list.$get({ query: projectSlug ? { project: projectSlug } : {} }),
    api.worktree.list.$get({ query: projectSlug ? { project: projectSlug } : {} }),
  ])

  if (groups.length === 0) {
    const suffix = projectSlug ? ` in project "${projectSlug}"` : ''
    console.log(`No worktree groups${suffix}. Create one with: yaac group create <project> <name>`)
    return
  }
  renderGroups(groups, running.worktrees)
}

export async function groupMove(
  worktreeId: string,
  group: string | undefined,
  options: { project?: string } = {},
): Promise<void> {
  const projectSlug = options.project ?? await projectOfWorktree(worktreeId)
  if (!projectSlug) {
    console.error(
      `Could not find a running worktree "${worktreeId}". Pass --project <slug> to move a `
      + 'stopped one.',
    )
    process.exitCode = 1
    return
  }
  // No group named returns the worktree to the default list; any name is a
  // group, created when it matches none (the same bargain `--group` makes on
  // create — the caller is naming a group, not picking one).
  const target = group === undefined || group === '--' ? null : group
  const moved = await api.worktree.group.move.$post({
    json: { projectSlug, worktreeId, group: target, create: true },
  })
  // The name the server resolved, not what was typed: passing an id (which
  // the ambiguity error asks for) would otherwise echo a uuid back.
  console.log(target === null
    ? `Moved ${worktreeId.slice(0, 8)} out of its group.`
    : `Moved ${worktreeId.slice(0, 8)} into "${moved.name ?? target}".`)
}

export async function groupDelete(projectSlug: string, group: string): Promise<void> {
  const { groups } = await api.worktree.group.list.$get({ query: { project: projectSlug } })
  const matches = resolveLocally(groups, group)
  if (matches.length === 0) {
    console.error(`No such group in ${projectSlug}: ${group}`)
    process.exitCode = 1
    return
  }
  // Refused rather than guessed, like every other name resolution here —
  // and more so, because this one destroys the row it picks.
  if (matches.length > 1) {
    console.error(
      `"${group}" names ${matches.length} groups in ${projectSlug} — pass the group id instead `
      + `(${matches.map((g) => g.groupId).join(', ')})`,
    )
    process.exitCode = 1
    return
  }
  const match = matches[0]
  await api.worktree.group.delete.$post({ json: { projectSlug, groupId: match.groupId } })
  // Worth stating: the members are released, not stopped — the delete is safe
  // precisely because nothing is torn down.
  console.log(`Deleted group "${match.name}". Its worktrees are back in the default list.`)
}

/**
 * Which project a worktree belongs to, so `yaac group move` can take an id
 * alone. Running worktrees first, then the stopped listing — filing a
 * stopped worktree is a normal thing to do (its group is where it comes back
 * when restarted), so it should not be the case that needs a flag.
 *
 * `--project` remains for the one thing this cannot answer: an id so old it
 * has fallen off the stopped listing's cap.
 */
async function projectOfWorktree(worktreeId: string): Promise<string | undefined> {
  const matches = (w: { worktreeId: string }): boolean =>
    w.worktreeId === worktreeId || w.worktreeId.startsWith(worktreeId)

  const { worktrees } = await api.worktree.list.$get({ query: {} })
  const running = worktrees.find(matches)
  if (running) return running.projectSlug

  const stopped = await api.worktree['list-stopped'].$get({ query: {} })
  return stopped.find(matches)?.projectSlug
}

/**
 * Local name/id match, for the one command that needs an id the server's
 * resolver would not hand back (delete takes a group id).
 *
 * Every match, not the first: names are not unique, and the caller has to be
 * able to tell one hit from several before deleting anything. An exact id is
 * never ambiguous, so it short-circuits.
 */
function resolveLocally(
  groups: WorktreeGroupSummary[],
  group: string,
): WorktreeGroupSummary[] {
  const byId = groups.find((g) => g.groupId === group)
  if (byId) return [byId]
  return groups.filter((g) => g.name.toLowerCase() === group.toLowerCase())
}

function renderGroups(groups: WorktreeGroupSummary[], worktrees: WorktreeListEntry[]): void {
  const counts = new Map<string, number>()
  for (const w of worktrees) {
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
