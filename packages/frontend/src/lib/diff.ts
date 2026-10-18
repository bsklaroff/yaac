import { diff } from '@codemirror/merge'
import { DIFF_CUT_LINE } from '@yaac/shared/types'

/**
 * Diff lines for the panes, from two sources: a combined `git diff` (the
 * Changes pane) and a before/after text pair (an ACP edit tool
 * call in the chat pane). Both produce `DiffLine[]`, so one renderer draws
 * both.
 */

export type DiffLineKind = 'add' | 'del' | 'context' | 'hunk'

export interface DiffLine {
  kind: DiffLineKind
  /** Line text without the leading +/-/space marker (full text for a hunk). */
  text: string
  /** 1-based line number in the old/new file, or null where not applicable. */
  oldNo: number | null
  newNo: number | null
}

export interface ParsedFileDiff {
  path: string
  binary: boolean
  lines: DiffLine[]
  /** The server cut this file's part short. */
  cut: boolean
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** Strip git's `a/` or `b/` path prefix and surrounding quotes. */
function cleanPath(raw: string): string {
  let p = raw.trim()
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1)
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2)
  return p
}

/** The destination path for one file chunk (its lines are already split). */
function pathForChunk(header: string[], gitLine: string): string {
  const plus = header.find((l) => l.startsWith('+++ '))
  const minus = header.find((l) => l.startsWith('--- '))
  const plusPath = plus?.slice(4).trim()
  if (plusPath && plusPath !== '/dev/null') return cleanPath(plusPath)
  const minusPath = minus?.slice(4).trim()
  if (minusPath && minusPath !== '/dev/null') return cleanPath(minusPath)
  // Binary or rename-only chunk with no ---/+++: fall back to the git line.
  const m = /^diff --git a\/(.+) b\/(.+)$/.exec(gitLine)
  return m ? cleanPath(m[2]) : ''
}

/** A file's part of a combined diff: its text, without the cut line, and
 *  whether the server cut it short. */
export interface DiffPart {
  text: string
  cut: boolean
}

/**
 * A combined unified diff split into its files' parts, by path. A
 * typechange prints two parts for its one path (a deletion, then a
 * creation), which stay together as one.
 */
export function splitDiff(diff: string): Map<string, DiffPart> {
  const parts = new Map<string, DiffPart>()
  let last: { path: string; part: DiffPart } | undefined
  for (const text of diff.split(/(?=^diff --git )/m)) {
    if (!text.startsWith('diff --git ')) continue
    const lines = text.split('\n')
    const hunk = lines.findIndex((l) => l.startsWith('@@'))
    const path = pathForChunk(lines.slice(1, hunk === -1 ? undefined : hunk), lines[0])
    const cut = text.endsWith(`\n${DIFF_CUT_LINE}\n`)
    const own = cut ? text.slice(0, -DIFF_CUT_LINE.length - 1) : text
    if (last?.path === path) {
      last.part = { text: last.part.text + own, cut }
    } else {
      last = { path, part: { text: own, cut } }
    }
    parts.set(path, last.part)
  }
  return parts
}

/** One file's part parsed into lines. */
export function parseDiffPart(path: string, { text, cut }: DiffPart): ParsedFileDiff {
  const file: ParsedFileDiff = { path, binary: false, lines: [], cut }
  let oldNo = 0
  let newNo = 0
  let header = false
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      header = true
      continue
    }
    // Header lines run up to the first hunk.
    if (header && !line.startsWith('@@')) {
      if (line.startsWith('Binary files')) file.binary = true
      continue
    }
    header = false
    const hunk = HUNK_RE.exec(line)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      file.lines.push({ kind: 'hunk', text: line, oldNo: null, newNo: null })
    } else if (line.startsWith('+')) {
      file.lines.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ })
    } else if (line.startsWith('-')) {
      file.lines.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null })
    } else if (line.startsWith(' ')) {
      file.lines.push({ kind: 'context', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
    }
    // '\ No newline at end of file' and stray lines are ignored.
  }
  return file
}

/**
 * Split text into lines for diffing, ignoring a trailing newline. Empty text
 * has no lines, so replacing an empty file doesn't show a deleted blank line.
 */
function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Changed lines past which `diffTextPair` stops interleaving. */
const DIFF_SCAN_LIMIT = 2_000

/**
 * Diff a before/after text pair into renderable lines.
 *
 * An ACP edit tool call supplies two versions of a fragment (one hunk with
 * context, or a whole new file), not a unified diff. The line numbers are
 * therefore positions within the fragment, not file line numbers, which is
 * why the chat pane's diff view hides the gutter.
 *
 * Each distinct line is diffed as one character, so @codemirror/merge's
 * character diff matches whole lines. Its scan limit bounds the cost of a
 * large rewrite: past that many changed lines a pair is matched coarsely,
 * as one removed block and one added block. Past 55,296 distinct lines the
 * characters reach UTF-16 surrogates, so a fragment that size may pair
 * unequal lines; no edit card is read at that size.
 */
export function diffTextPair(oldText: string | undefined, newText: string): DiffLine[] {
  const a = splitLines(oldText ?? '')
  const b = splitLines(newText)
  const ids = new Map<string, string>()
  const chars = (side: string[]): string => side.map((line) => {
    let id = ids.get(line)
    if (id === undefined) ids.set(line, (id = String.fromCharCode(ids.size)))
    return id
  }).join('')
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  const end = { fromA: a.length, toA: a.length, toB: b.length }
  for (const c of [...diff(chars(a), chars(b), { scanLimit: DIFF_SCAN_LIMIT }), end]) {
    for (; i < c.fromA; i++, j++) lines.push({ kind: 'context', text: a[i], oldNo: i + 1, newNo: j + 1 })
    for (; i < c.toA; i++) lines.push({ kind: 'del', text: a[i], oldNo: i + 1, newNo: null })
    for (; j < c.toB; j++) lines.push({ kind: 'add', text: b[j], oldNo: null, newNo: j + 1 })
  }
  return lines
}
