import { useQuery } from '@tanstack/react-query'
import { api } from '#lib/api'
import { useUiStore } from '#lib/store'
import type { ProjectSummary, ServerSnapshot, Whoami } from '@yaac/shared/types'

/**
 * Who is looking, and at whose data. The snapshot carries every user's rows
 * (docs/plans/multi-user-deployment.md "Snapshot and SPA"); the SPA shows
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

/**
 * Whether another user's data is shown. Every control is then off, and
 * views skip the writes they would make as a side effect (marking a death
 * seen), since only the owner may make them.
 */
export function useReadOnly(): boolean {
  const viewed = useUiStore((s) => s.viewedUserId)
  const me = useWhoami()?.userId
  return viewed !== null && me !== undefined && viewed !== me
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
  }
}
