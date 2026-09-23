import type { JSX } from 'react'

/** Split a path into directory + basename for two-tone rendering. */
function splitPath(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf('/')
  return i === -1 ? { dir: '', base: path } : { dir: path.slice(0, i + 1), base: path.slice(i + 1) }
}

/** Render a path as a faint directory prefix + a basename. `emphasis="dim"`
 *  mutes the basename (the "from" side of a rename); `baseClassName` colors
 *  it instead (a git status tint). */
export function PathLabel({ path, emphasis = 'text', baseClassName }: {
  path: string
  emphasis?: 'text' | 'dim'
  baseClassName?: string
}): JSX.Element {
  const { dir, base } = splitPath(path)
  return (
    <>
      {dir && <span className="text-text-faint">{dir}</span>}
      <span className={baseClassName ?? (emphasis === 'dim' ? 'text-text-dim' : 'text-text')}>{base}</span>
    </>
  )
}
