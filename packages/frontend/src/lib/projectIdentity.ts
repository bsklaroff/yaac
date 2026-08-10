/**
 * A project's visual identity, derived from its slug alone so every surface
 * that shows a project — the desktop rail chip, the mobile projects list —
 * agrees without the server having to store a color.
 */

/**
 * Deterministic per-project identity color from the slug. OKLCH (not HSL)
 * so every hue reads at the same perceived lightness/chroma — no hue is
 * harshly bright or muddy — with chroma/lightness tuned to sit calmly in
 * the muted dark palette. The hue is quantized to 24 evenly-spaced steps
 * to keep adjacent projects visually distinct.
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
