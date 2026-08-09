import { applyHerdEvent, listActiveAgentSessions } from '#features/records'
import { notifySessionListChanged } from '#notify'
import { decideSpawn } from '#main/spawn'
import type { ServerLink } from '#server-link'

/**
 * The server, as its herd is allowed to see it (`#server-link`).
 *
 * Four methods, and each one is a place where the herd stops and the server
 * decides: a discovery becomes a row, a change becomes a pushed snapshot, a
 * drained spawn becomes a policy decision and a create, and a workspace's
 * conversations come back off rows the herd never reads.
 *
 * Built here because `#main` is the one place allowed to know both halves —
 * it is where the DB is opened and the event hub lives — and installed at
 * startup right after the DB, since every handler needs one
 * (docs/plans/herd-split.md).
 */
export function createServerLink(): ServerLink {
  return {
    workspaceEvent: (event) => applyHerdEvent(event),

    workspacesChanged: () => notifySessionListChanged(),

    spawnRequested: (request) => decideSpawn(request),

    recordedConversations: async ({ projectSlug, workspaceId }) =>
      (await listActiveAgentSessions(projectSlug, workspaceId).catch(() => []))
        .flatMap((l) => (l.paneId === undefined
          ? []
          : [{ handle: l.paneId, agentSessionId: l.agentSessionId }])),
  }
}
