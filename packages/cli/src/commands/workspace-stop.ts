import { api } from '#commands/api'

/**
 * `yaac workspace stop <id>` — tear down the container and keep the git
 * workspace. The checkout, its branch, and its diff all survive; a later
 * `yaac workspace restart` brings the agents back.
 */
export async function workspaceStop(idOrName: string): Promise<void> {
  const info = await api.workspace.stop.$post({ json: { workspaceId: idOrName } })
  console.log(`Workspace ${info.workspaceId} stopped; its checkout is kept.`)
}
