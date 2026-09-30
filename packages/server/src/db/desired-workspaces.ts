import { listLiveWorkspaceRows, listStoppedWorkspaceIds } from './workspace-store'

/**
 * The workspaces the server has recorded, which the stale reaper compares
 * against the runtime. A runtime with no record is a leak; a record with no
 * runtime is a create that died. The substrate alone can't tell these apart.
 *
 * Read fresh at the start of each reaper pass. A read failure must make the
 * pass do nothing, never be treated as an empty set.
 */
export interface DesiredWorkspaces {
  live: DesiredWorkspace[]
  /** `<projectSlug>/<workspaceId>` of workspaces recorded as stopped, which
   *  tells a teardown yaac issued apart from an unexpected one. */
  stopped: string[]
}

export interface DesiredWorkspace {
  projectSlug: string
  workspaceId: string
  /** Whether its agent ever started: separates an interrupted create
   *  (`never-started`) from a workspace whose runtime vanished (`orphaned`). */
  ran: boolean
}

export async function desiredWorkspaces(): Promise<DesiredWorkspaces> {
  const [live, stopped] = await Promise.all([
    listLiveWorkspaceRows(),
    listStoppedWorkspaceIds(),
  ])
  return { live, stopped: [...stopped] }
}
