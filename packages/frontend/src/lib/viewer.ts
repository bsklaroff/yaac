import { useQuery } from '@tanstack/react-query'
import { api } from '#lib/api'
import { useUiStore } from '#lib/store'
import type { ProjectSummary, ServerSnapshot, Whoami } from '@yaac/shared/types'

/**
 * Who is looking, and at whose data. The snapshot carries every user's rows
 * (docs/multi-user.md "Snapshot and webapp"); the SPA shows
 * one user's at a time: the caller's own, or a teammate's picked in the
 * user switcher, read-only.
 */

/** `GET /whoami`: the caller and the install's users. App's bootstrap. */
export const whoamiQuery = {
  queryKey: ['whoami'],
  queryFn: () => api.whoami.$get(),
}

export function useWhoami(): Whoami | undefined {
  return useQuery(whoamiQuery).data
}

/** The user whose projects are shown: the switcher's pick, else the caller. */
export function useViewedUserId(): string | undefined {
  const viewed = useUiStore((s) => s.viewedUserId)
  const me = useWhoami()?.userId
  return viewed ?? me
}

/** Whether another user's data is shown, rather than the caller's own. */
export function useTeammateView(): boolean {
  const viewed = useUiStore((s) => s.viewedUserId)
  const me = useWhoami()?.userId
  return viewed !== null && me !== undefined && viewed !== me
}

/** The viewed user's name while it is a teammate's data that is shown:
 *  whose answers and attention their workspaces wait on. */
export function useTeammateName(): string | undefined {
  const teammate = useTeammateView()
  const viewed = useViewedUserId()
  const name = useWhoami()?.users.find((u) => u.id === viewed)?.name
  return teammate ? name ?? 'its owner' : undefined
}

/**
 * Whether the active project is shown read-only: it is another user's, or a
 * share its source's owner removed, which its owner can still read but no
 * longer change (docs/hosted-projects.md "Sharing"). Every control is then
 * off, and views skip the writes they would make as a side effect
 * (remembering create choices), since the server refuses them.
 */
export function useReadOnly(): boolean {
  const teammate = useTeammateView()
  const removed = useUiStore((s) =>
    s.snapshot?.projects.find((p) => p.id === s.activeProjectId)?.sharedFrom?.revoked === true)
  return teammate || removed
}

/** The projects `userId` owns, in snapshot order. */
export function projectsOf(projects: ProjectSummary[], userId: string | undefined): ProjectSummary[] {
  return projects.filter((p) => p.owner === userId)
}

/**
 * The snapshot cut to one user's projects and the rows in them. Rows carry
 * no owner of their own: each belongs to its project's owner.
 */
export function ownedBy(snapshot: ServerSnapshot, userId: string): ServerSnapshot {
  const projects = projectsOf(snapshot.projects, userId)
  const ids = new Set(projects.map((p) => p.id))
  const theirs = <T extends { projectId: string }>(rows: T[]): T[] => rows.filter((r) => ids.has(r.projectId))
  return {
    ...snapshot,
    projects,
    workspaces: theirs(snapshot.workspaces),
    workspaceGroups: theirs(snapshot.workspaceGroups),
    stale: theirs(snapshot.stale),
    provisioning: theirs(snapshot.provisioning),
    queuedWorkspaces: theirs(snapshot.queuedWorkspaces),
    heldWorkspaces: theirs(snapshot.heldWorkspaces),
    draftWorkspaces: theirs(snapshot.draftWorkspaces),
    routines: theirs(snapshot.routines),
  }
}
