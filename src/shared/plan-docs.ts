import type { PlanPhase } from '@/shared/types'

/**
 * Pure plan-doc frontmatter helpers, shared by the daemon (doc listing,
 * promote flip) and the webapp (preview rendering). Only the tiny YAML
 * subset yaac writes is understood — scalar values and inline string
 * lists; unknown lines are preserved verbatim by the editing helpers.
 */

const PHASES: readonly PlanPhase[] = ['plan', 'build', 'review']

export function isPlanPhase(v: unknown): v is PlanPhase {
  return typeof v === 'string' && (PHASES as readonly string[]).includes(v)
}

export interface ParsedPlanDoc {
  phase: PlanPhase
  sessions: string[]
  title: string
  /** Markdown body without the frontmatter block. */
  body: string
}

export interface FrontmatterBlock {
  /** Raw lines between the `---` fences (no fences). */
  lines: string[]
  body: string
}

/**
 * Split a leading YAML frontmatter block off a markdown document.
 * Returns null when the document doesn't start with a `---` fence.
 */
export function splitFrontmatter(md: string): FrontmatterBlock | null {
  const normalized = md.startsWith('\uFEFF') ? md.slice(1) : md
  if (!/^---\r?\n/.test(normalized)) return null
  const end = normalized.search(/\r?\n---(\r?\n|$)/)
  if (end < 0) return null
  const inner = normalized.slice(normalized.indexOf('\n') + 1, end)
  const rest = normalized.slice(end).replace(/^\r?\n---(\r?\n|$)/, '')
  return { lines: inner.length ? inner.split(/\r?\n/) : [], body: rest }
}

function parseScalar(lines: string[], key: string): string | undefined {
  const re = new RegExp(`^${key}\\s*:\\s*(.*)$`)
  for (const line of lines) {
    const m = re.exec(line)
    if (m) return m[1].trim().replace(/^['"]|['"]$/g, '')
  }
  return undefined
}

/** Parse `sessions: [a, b]` (the only list form yaac writes). */
export function parseSessionsList(lines: string[]): string[] {
  const raw = parseScalar(lines, 'sessions')
  if (!raw) return []
  const inner = raw.replace(/^\[|\]$/g, '')
  return inner
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter((s) => s.length > 0)
}

/** First `# ` heading of the body, used as the doc title fallback. */
export function firstHeading(body: string): string | undefined {
  const m = /^#\s+(.+)$/m.exec(body)
  return m?.[1].trim()
}

/** Wiki filename → human title ('offline-sync.md' → 'offline sync'). */
export function titleFromFileName(fileName: string): string {
  return fileName.replace(/\.md$/, '').replace(/[-_]+/g, ' ').trim()
}

export function parsePlanDoc(md: string, fileName: string): ParsedPlanDoc {
  const block = splitFrontmatter(md)
  const lines = block?.lines ?? []
  const body = block?.body ?? md
  const phaseRaw = parseScalar(lines, 'phase')
  return {
    phase: isPlanPhase(phaseRaw) ? phaseRaw : 'plan',
    sessions: parseSessionsList(lines),
    title: parseScalar(lines, 'title') ?? firstHeading(body) ?? titleFromFileName(fileName),
    body,
  }
}

/**
 * Rewrite a doc's frontmatter: set `phase` and/or append a session id.
 * Unknown frontmatter lines are preserved; a missing block is created.
 * Pure (string → string) so the promote flip is unit-testable.
 */
export function updateFrontmatter(
  md: string,
  changes: { phase?: PlanPhase; appendSession?: string },
): string {
  const block = splitFrontmatter(md)
  const lines = [...(block?.lines ?? [])]
  const body = block?.body ?? md

  if (changes.phase) {
    const idx = lines.findIndex((l) => /^phase\s*:/.test(l))
    const line = `phase: ${changes.phase}`
    if (idx >= 0) lines[idx] = line
    else lines.unshift(line)
  }
  if (changes.appendSession) {
    const existing = parseSessionsList(lines)
    if (!existing.includes(changes.appendSession)) {
      const next = `sessions: [${[...existing, changes.appendSession].join(', ')}]`
      const idx = lines.findIndex((l) => /^sessions\s*:/.test(l))
      if (idx >= 0) lines[idx] = next
      else lines.push(next)
    }
  }
  return `---\n${lines.join('\n')}\n---\n${body}`
}
