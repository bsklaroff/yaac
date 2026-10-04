import { api } from '#commands/api'

/**
 * `yaac workspace stop <id>`: stop the workspace's processes but keep its
 * checkout, branch, and changes; `yaac workspace restart` brings the agents
 * back. One still being created is rolled back, and its prompt kept as a
 * draft.
 */
export async function workspaceStop(idOrName: string): Promise<void> {
  const info = await api.workspace.stop.$post({ json: { workspaceId: idOrName } })
  console.log(info.provisioning === true
    ? `Workspace ${info.workspaceId} stopped while it was starting.`
    : `Workspace ${info.workspaceId} stopped; its checkout is kept.`)
}
