import { listLiveWorkspaceRows } from './workspace-store'

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
}

export interface DesiredWorkspace {
  projectId: string
  workspaceId: string
  /** Whether its agent ever started: separates an interrupted create
   *  (`never-started`) from a workspace whose runtime vanished (`orphaned`). */
  ran: boolean
  /** Set while its current life is a restart that has not come up: when the
   *  life before it began. */
  restartedFrom?: Date
}

export async function desiredWorkspaces(): Promise<DesiredWorkspaces> {
  return { live: await listLiveWorkspaceRows() }
}
