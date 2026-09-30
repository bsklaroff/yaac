import { api } from '#commands/api'

/**
 * `yaac workspace rename <workspace-id> <title>` — set the label the sidebar
 * and the listings show in place of a workspace's id.
 *
 * Resolves in any state, like the route it calls: renaming a stopped or
 * still-waiting workspace is fine, because a title lives on the host rather
 * than in the container.
 */
export async function workspaceRename(workspaceId: string, title: string): Promise<void> {
  await api.workspace[':id'].title.$post({
    param: { id: workspaceId },
    json: { title },
  })
  console.log(`Renamed ${workspaceId.slice(0, 8)} to "${title.trim()}".`)
}
