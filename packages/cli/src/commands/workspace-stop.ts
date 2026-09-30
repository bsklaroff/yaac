import { api } from '#commands/api'

/**
 * `yaac workspace stop <id>`: stop the workspace's processes but keep its
 * checkout, branch, and changes; `yaac workspace restart` brings the agents
 * back.
 */
export async function workspaceStop(idOrName: string): Promise<void> {
  const info = await api.workspace.stop.$post({ json: { workspaceId: idOrName } })
  console.log(`Workspace ${info.workspaceId} stopped; its checkout is kept.`)
}
