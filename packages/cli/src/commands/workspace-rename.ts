import { api } from '#commands/api'

/**
 * `yaac workspace rename <workspace-id> <title>`: set the title the sidebar
 * and listings show for a workspace. Works in any state, including stopped.
 */
export async function workspaceRename(workspaceId: string, title: string): Promise<void> {
  await api.workspace[':id'].title.$post({
    param: { id: workspaceId },
    json: { title },
  })
  console.log(`Renamed ${workspaceId.slice(0, 8)} to "${title.trim()}".`)
}
