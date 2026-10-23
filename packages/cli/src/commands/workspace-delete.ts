import { api } from '#commands/api'
import { confirmDefault } from '@yaac/shared/confirm'

/**
 * `yaac workspace delete <id>`: discard a queued workspace (one scheduled
 * for later, say), or delete a stopped workspace's checkout and
 * local branches, unpushed commits, uncommitted changes and conversation
 * history for good. Anything pushed stays on the remote. Asks first unless
 * `--yes`; with no terminal to ask on, it fails naming `--yes`.
 */
export async function workspaceDelete(idOrName: string, opts: { yes?: boolean }): Promise<void> {
  const token = idOrName.trim().toLowerCase()
  const queued = (await api.workspace.queue.list.$get()).filter((e) => e.id.startsWith(token))
  if (queued.length > 1) throw new Error(`"${idOrName}" matches more than one queued workspace; use a longer prefix.`)
  if (queued.length === 1) {
    // Nothing of it exists yet but the request, so there is nothing to lose.
    await api.workspace.queue.discard.$post({ json: { id: queued[0].id } })
    console.log(`Queued workspace ${queued[0].id} discarded.`)
    return
  }
  // A script reading the exit code must not take a delete that never ran
  // for success.
  if (!opts.yes && !process.stdin.isTTY) {
    console.error('No terminal to confirm on; pass --yes to delete without asking.')
    process.exitCode = 1
    return
  }
  if (!opts.yes && !await confirmDefault(
    `This permanently deletes workspace ${idOrName}: its checkout, unpushed commits, `
    + 'uncommitted changes and conversation history. Continue?',
  )) {
    console.log('Aborted — nothing was deleted.')
    return
  }
  const { workspaceId } = await api.workspace.delete.$post({ json: { workspaceId: idOrName } })
  console.log(`Workspace ${workspaceId} deleted.`)
}
