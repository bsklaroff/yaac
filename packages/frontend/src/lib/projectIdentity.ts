/**
 * A project's color and initial, derived from its slug so the desktop rail
 * and the mobile projects list agree without the server storing anything.
 */

/**
 * A stable color for a project. OKLCH keeps every hue at the same perceived
 * brightness. The hue is one of 24 evenly spaced steps so neighboring
 * projects stay distinct.
 */
export function projectColor(slug: string): string {
  let h = 0
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0
  const hue = (h % 24) * 15
  return `oklch(0.74 0.115 ${hue})`
}

/** The single letter a project chip shows. */
export function projectInitial(slug: string): string {
  const c = slug.replace(/[^a-z0-9]/gi, '')[0]
  return (c ?? '?').toUpperCase()
}
