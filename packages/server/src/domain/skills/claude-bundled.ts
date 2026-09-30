/**
 * Claude's bundled skills: the `/` built-ins in the Claude binary
 * (code-review, verify, deep-research, …). They are in no mounted dir, but
 * the official commands reference marks each with `[Skill]` or `[Workflow]`.
 * The page is fetched once per server start and cached in memory; a failed
 * fetch just omits this tier until the next start. Reading the docs avoids
 * reverse-engineering the minified binary.
 */

const COMMANDS_MD_URL = 'https://code.claude.com/docs/en/commands.md'

export interface BundledSkill {
  name: string
  description: string
}

let cache: BundledSkill[] = []

/** The bundled skills fetched at startup; empty until the fetch resolves. */
export function getClaudeBundledSkills(): BundledSkill[] {
  return cache
}

/** Overwrite the in-memory cache. Used by the startup refresh and by tests. */
export function setClaudeBundledSkills(skills: BundledSkill[]): void {
  cache = skills
}

/**
 * Parse the commands-reference markdown into name and description for every
 * table row whose Purpose cell links to the bundled-skills or
 * bundled-workflows anchor. Cells split on unescaped pipes only, since the
 * docs write literal pipes as `\|`.
 */
export function parseBundledSkills(md: string): BundledSkill[] {
  const out: BundledSkill[] = []
  const seen = new Set<string>()
  for (const line of md.split('\n')) {
    if (!line.startsWith('|')) continue
    const cells = line.split(/(?<!\\)\|/)
    if (cells.length < 4) continue // `| cmd | purpose |` → ['', cmd, purpose, '']
    const cmd = cells[1].trim()
    const purpose = cells.slice(2, cells.length - 1).join('|').trim()
    if (!/\[(?:Skill|Workflow)\]\(\/en\/(?:skills#bundled-skills|workflows#bundled-workflows)\)/.test(purpose)) {
      continue
    }
    const nameMatch = /^`?\/([a-z][a-z0-9-]*)/.exec(cmd)
    if (!nameMatch) continue
    const name = nameMatch[1]
    const description = cleanDescription(purpose)
    if (description && !seen.has(name)) {
      seen.add(name)
      out.push({ name, description })
    }
  }
  return out
}

/** Strip the row marker, version notes, and markdown link syntax down to plain
 *  prose suitable for a one-line summary. */
function cleanDescription(purpose: string): string {
  return purpose
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ') // {/* min-version: … */} notes
    .replace(/\*\*\[(?:Skill|Workflow)\]\([^)]*\)\.\*\*/g, '') // the leading **[Skill](…).** marker
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](url) → text
    .replace(/\\\|/g, '|') // unescape pipes
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Fetch the commands reference and refresh the cache. Best-effort: a failed
 * or empty fetch leaves the cache unchanged.
 */
export async function refreshClaudeBundledSkills(): Promise<void> {
  try {
    const res = await fetch(COMMANDS_MD_URL, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return
    const skills = parseBundledSkills(await res.text())
    if (skills.length > 0) setClaudeBundledSkills(skills)
  } catch {
    // Keep the existing cache.
  }
}
