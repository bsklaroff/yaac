/**
 * Claude's bundled ("system") skills — the `/`-invokable built-ins baked into
 * the Claude binary (code-review, dataviz, verify, deep-research, …). Their
 * names and descriptions live in no mounted dir, but Anthropic publishes them
 * in the official commands reference, where each bundled row is marked
 * `[Skill]` (or `[Workflow]`, e.g. deep-research). We fetch that page once on
 * server start and cache it in memory — the set changes only across Claude
 * releases, so a per-start refresh is plenty and a failed fetch just means no
 * bundled tier that run (the viewer degrades to the on-disk tiers).
 *
 * This is deliberately unofficial-but-stable: it reads human-maintained docs,
 * not the minified binary, so it never needs per-release deobfuscation.
 */

const COMMANDS_MD_URL = 'https://code.claude.com/docs/en/commands.md'

export interface BundledSkill {
  name: string
  description: string
}

let cache: BundledSkill[] = []

/** The bundled skills fetched at startup — empty until the fetch resolves. */
export function getClaudeBundledSkills(): BundledSkill[] {
  return cache
}

/** Overwrite the in-memory cache. Used by the startup refresh and by tests. */
export function setClaudeBundledSkills(skills: BundledSkill[]): void {
  cache = skills
}

/**
 * Parse the commands-reference markdown, returning every bundled row (a table
 * row whose Purpose cell is marked `[Skill]`/`[Workflow]` and links to the
 * bundled-skills/-workflows anchor) as a name + cleaned description. Pure.
 *
 * Cells split on *unescaped* pipes — the docs escape literal pipes in argument
 * lists (`[low\|medium\|…]`) as `\|`, so those stay inside a cell.
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
 * Fetch the commands reference and refresh the in-memory cache. Best-effort:
 * a failed/empty fetch leaves the cache untouched, so a transient network
 * error at startup just means the bundled tier is absent until the next start.
 */
export async function refreshClaudeBundledSkills(): Promise<void> {
  try {
    const res = await fetch(COMMANDS_MD_URL, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return
    const skills = parseBundledSkills(await res.text())
    if (skills.length > 0) setClaudeBundledSkills(skills)
  } catch {
    // offline / unreachable / parse yield-nothing → keep whatever we had
  }
}
