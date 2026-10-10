import { useSnapshot } from '#lib/useSnapshot'

/**
 * How a project is shown: its name, plus a color and initial so the desktop
 * rail and the mobile projects list agree without the server storing
 * anything. The user switcher's avatars use the same color and initial. The
 * color comes from the id, which is stable and unique; the name is not
 * unique, so it only labels.
 */

/**
 * A stable color for a project or user id. OKLCH keeps every hue at the
 * same perceived brightness. The hue is one of 24 evenly spaced steps so
 * neighbors stay distinct.
 */
export function identityColor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  const hue = (h % 24) * 15
  return `oklch(0.74 0.115 ${hue})`
}

/** The single letter a project chip or user avatar shows, from its name. */
export function identityInitial(name: string): string {
  const c = name.replace(/[^a-z0-9]/gi, '')[0]
  return (c ?? '?').toUpperCase()
}

/** Maps a project id to its name, or to the id itself for a project the
 *  snapshot does not list. */
export function useProjectName(): (projectId: string) => string {
  const projects = useSnapshot()?.projects
  return (projectId) => projects?.find((p) => p.id === projectId)?.name ?? projectId
}
