import { api } from '#commands/api'

/**
 * `yaac workspace stop <id>`: stop the workspace's processes but keep its
 * checkout, branch, and changes, less its gitignored files
 * (docs/workspace-storage.md "Ignored files at stop"); `yaac workspace
 * restart` brings its sessions back. One still being created is rolled
 * back, and its prompt kept as a draft.
 *
 * With `--session`, `<id>` names a session instead, and only it closes
 * (docs/sessions.md): its agent stops, its conversations stay in the
 * workspace's history, and the workspace keeps running.
 */
export async function workspaceStop(idOrName: string, options: { session?: boolean } = {}): Promise<void> {
  if (options.session === true) {
    await closeSession(idOrName)
    return
  }
  const info = await api.workspace.stop.$post({ json: { workspaceId: idOrName } })
  console.log(info.provisioning === true
    ? `Workspace ${info.workspaceId} stopped while it was starting.`
    : `Workspace ${info.workspaceId} stopped; its checkout is kept, except files its .gitignore `
      + 'matches that are not kept under Settings → Project Config.')
}

/** Close the open session `id` (or a unique prefix of it) names. */
async function closeSession(id: string): Promise<void> {
  const { workspaces } = await api.workspace.list.$get({ query: {} })
  const open = workspaces.flatMap((w) => w.sessions.map((s) => ({ workspace: w, session: s })))
  const exact = open.filter((o) => o.session.sessionId === id)
  const matches = exact.length > 0 ? exact : open.filter((o) => o.session.sessionId.startsWith(id))
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `No open session matches "${id}". Run "yaac workspace list" to see sessions.`
      : `"${id}" matches more than one session; use a longer prefix.`)
  }
  const [{ workspace, session }] = matches
  await api.workspace[':id'].sessions[':sessionId'].close.$post({
    param: { id: workspace.workspaceId, sessionId: session.sessionId },
  })
  const rest = workspace.sessions.length - 1
  console.log(`Session ${session.sessionId} closed; its conversations stay in workspace ${workspace.workspaceId}'s history. `
    + (rest === 0 ? 'The workspace keeps running with no agent.' : 'The workspace keeps running.'))
}
