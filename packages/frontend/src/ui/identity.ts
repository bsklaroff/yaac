/**
 * How a project or user is drawn without the server storing anything: a
 * colour family and an initial, so the rail, the mobile project list and
 * the avatars agree. The family comes from the id, which is stable and
 * unique; the name is not unique, so it only gives the initial.
 */

/** The eight project colour families (`--color-proj-<family>-*` in
 *  styles/tokens.css), matched in lightness so no project is louder than
 *  another. */
export const IDENTITY_FAMILIES = ['violet', 'orange', 'green', 'pink', 'teal', 'sky', 'yellow', 'coral'] as const
export type IdentityFamily = typeof IDENTITY_FAMILIES[number]

/** A stable colour family for a project or user id. */
export function identityFamily(id: string): IdentityFamily {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return IDENTITY_FAMILIES[h % IDENTITY_FAMILIES.length]
}

/** A family's tile colours: the solid fill when lit (current or hovered),
 *  else the tint with the initial in ink. */
export function identityStyle(family: IdentityFamily, lit: boolean): { background: string; color: string } {
  return lit
    ? { background: `var(--proj-${family}-fill)`, color: 'var(--proj-on)' }
    : { background: `var(--proj-${family}-tint)`, color: `var(--proj-${family}-ink)` }
}

/** The single letter a project chip or user avatar shows, from its name. */
export function identityInitial(name: string): string {
  const c = name.replace(/[^a-z0-9]/gi, '')[0]
  return (c ?? '?').toUpperCase()
}
