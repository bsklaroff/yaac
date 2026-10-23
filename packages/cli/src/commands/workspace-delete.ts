import { api } from '#commands/api'
import { confirmDefault } from '@yaac/shared/confirm'

/**
 * `yaac workspace delete <id>`: delete a stopped workspace's checkout and
 * local branches, unpushed commits, uncommitted changes and conversation
 * history for good. Anything pushed stays on the remote. Asks first unless
 * `--yes`; with no terminal to ask on, it fails naming `--yes`.
 */
export async function workspaceDelete(idOrName: string, opts: { yes?: boolean }): Promise<void> {
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
