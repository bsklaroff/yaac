/* How a project is shown beyond its colour and initial (#ui identity): its
 * picture and its name. */

import { useSnapshotSelect } from '#lib/useSnapshot'

/** Where a project's picture loads from. The hash changes with the
 *  picture, so a new one is never served from the browser's cache. */
export function projectIconUrl(projectId: string, iconHash: string): string {
  return `/api/project/${encodeURIComponent(projectId)}/icon?v=${iconHash}`
}

/** Maps a project id to its name, or to the id itself for a project the
 *  snapshot does not list. */
export function useProjectName(): (projectId: string) => string {
  const projects = useSnapshotSelect((s) => s?.projects)
  return (projectId) => projects?.find((p) => p.id === projectId)?.name ?? projectId
}
