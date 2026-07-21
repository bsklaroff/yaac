/**
 * Parses `SKILL.md` frontmatter — the YAML block between the leading `---`
 * fences — with the `yaml` library. Locating the fenced block is a simple text
 * split (what every frontmatter reader does); the block's contents are handed
 * to a real YAML parser rather than parsed by hand.
 *
 * Claude Code loads a skill even when its frontmatter is malformed (the body
 * still works, the metadata is just empty), so a parse error is swallowed:
 * malformed frontmatter degrades to an empty map plus the raw body, never a
 * throw. A frontmatter block that isn't a YAML mapping (a bare scalar or list)
 * is likewise treated as no metadata.
 */

import { parse as parseYamlRaw } from 'yaml'

/** `yaml.parse` retyped to return `unknown` rather than the library's `any`. */
const parseYaml = parseYamlRaw as (src: string) => unknown

export interface ParsedSkillMd {
  /** The frontmatter mapping — arbitrary YAML values (strings, numbers,
   *  booleans, lists, nested maps like `metadata:`). Empty when absent/invalid. */
  frontmatter: Record<string, unknown>
  /** Markdown after the frontmatter block (or the whole input if none). */
  body: string
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/

export function parseSkillMd(raw: string): ParsedSkillMd {
  const input = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  const m = FENCE.exec(input)
  if (!m) return { frontmatter: {}, body: input }

  const body = m[2] ?? ''
  let parsed: unknown
  try {
    parsed = parseYaml(m[1])
  } catch {
    return { frontmatter: {}, body } // malformed → skill still loads, no metadata
  }
  const frontmatter =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  return { frontmatter, body }
}

/** Stringify one YAML value for display: primitives directly, maps/arrays as
 *  JSON. Keeps `no-base-to-string` happy and never yields "[object Object]". */
function stringify(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  return JSON.stringify(v) ?? '' // objects/arrays; symbols/functions never occur in YAML
}

/** Read a frontmatter field as a scalar string (first item if it's a list). */
export function fmString(fm: Record<string, unknown>, key: string): string | undefined {
  const v = fm[key]
  if (v == null) return undefined
  if (Array.isArray(v)) {
    const first: unknown = (v as unknown[])[0]
    return first == null ? undefined : stringify(first)
  }
  if (typeof v === 'object') return undefined // nested mapping is not a scalar
  return stringify(v)
}

/** Read a frontmatter field as a boolean, or undefined when absent/non-boolean. */
export function fmBool(fm: Record<string, unknown>, key: string): boolean | undefined {
  const v = fm[key]
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase()
    if (t === 'true') return true
    if (t === 'false') return false
  }
  return undefined
}

/** Read a frontmatter field as a list, splitting a scalar on spaces/commas. */
export function fmList(fm: Record<string, unknown>, key: string): string[] | undefined {
  const v = fm[key]
  if (v == null) return undefined
  let items: string[]
  if (Array.isArray(v)) items = (v as unknown[]).map(stringify)
  else if (typeof v === 'string') items = v.split(/[\s,]+/)
  else return undefined
  const cleaned = items.map((s) => s.trim()).filter((s) => s.length > 0)
  return cleaned.length > 0 ? cleaned : undefined
}

/** Flatten frontmatter to display strings (lists joined, maps JSON-encoded). */
export function flattenFrontmatter(fm: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(fm)) {
    if (v == null) continue
    out[k] = Array.isArray(v) ? (v as unknown[]).map(stringify).join(', ') : stringify(v)
  }
  return out
}
