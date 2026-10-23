import { api, projectScope, resolveProjectId } from '#commands/api'
import { confirmDefault } from '@yaac/shared/confirm'

/**
 * `yaac config workspace-auto-delete <project> [days|off]`: show after how
 * many days the project's stopped workspaces are deleted, or set it. A number
 * of days has the server delete each workspace once it has been stopped that
 * long, checkout and history included, starting with the ones already past
 * it. Since that cannot be undone it is only ever set interactively: it says
 * how many go at once at most and asks, defaulting to no, then reports what
 * went and what was kept for now. With no terminal to ask on it refuses.
 * `off` deletes nothing, so it does not ask.
 */
export async function configWorkspaceAutoDelete(project: string, value: string | undefined): Promise<void> {
  const scope = await projectScope()
  const projectId = await resolveProjectId(project, scope)
  const summary = scope.all.find((p) => p.id === projectId)
  const name = summary?.name ?? projectId
  const autoDelete = api.project[':projectId']['workspace-auto-delete']

  if (value === undefined) {
    const days = summary?.stoppedWorkspaceRetentionDays
    console.log(days === undefined
      ? `${name} keeps stopped workspaces until you delete them.`
      : `${name} deletes a workspace once it has been stopped ${days} days.`)
    return
  }
  if (value === 'off') {
    await autoDelete.$put({ param: { projectId }, json: { days: null } })
    console.log(`${name} now keeps stopped workspaces until you delete them.`)
    return
  }
  const days = Number(value)
  if (!/^\d+$/.test(value) || days < 1) {
    throw new Error(`${value} is not a whole number of days; pass off to keep stopped workspaces.`)
  }
  // A script reading the exit code must not take a change that never ran
  // for success.
  if (!process.stdin.isTTY) {
    console.error('Auto-delete is only turned on from a terminal, where you confirm what it deletes.')
    process.exitCode = 1
    return
  }
  const { expired, before } = await autoDelete.$get({ param: { projectId }, query: { days: String(days) } })
  if (!await confirmDefault(
    `This permanently deletes every stopped workspace in ${name} once it has been stopped ${days} days: `
    + 'its checkout, unpushed commits, uncommitted changes and conversation history, which cannot be '
    + `recovered. Up to ${expired} workspace(s) are already past that and will be deleted irretrievably `
    + 'right now. Continue?',
  )) {
    console.log('Aborted — nothing was changed or deleted.')
    return
  }
  const { deleted, kept } = await autoDelete.$put({ param: { projectId }, json: { days, before } })
  console.log(`${name} now deletes a workspace once it has been stopped ${days} days; deleted ${deleted} now.`)
  if (kept.length > 0) {
    console.log(`Kept ${kept.length} for now, deleted once they can be:`)
    for (const { reason } of kept) console.log(`  ${reason}`)
  }
}
