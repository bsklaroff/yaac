import { diff } from '@codemirror/merge'

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

/** Split a combined unified diff into per-file parsed diffs. */
export function parseUnifiedDiff(diff: string): ParsedFileDiff[] {
  if (!diff.trim()) return []
  const files: ParsedFileDiff[] = []
  const lines = diff.split('\n')

  let i = 0
  while (i < lines.length) {
    if (!lines[i].startsWith('diff --git ')) { i++; continue }
    const gitLine = lines[i]
    i++
    // Header lines up to the first hunk (or the next file).
    const header: string[] = []
    while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git ')) {
      header.push(lines[i])
      i++
    }
    const binary = header.some((l) => l.startsWith('Binary files'))
    const file: ParsedFileDiff = { path: pathForChunk(header, gitLine), binary, lines: [] }

    let oldNo = 0
    let newNo = 0
    while (i < lines.length && !lines[i].startsWith('diff --git ')) {
      const line = lines[i]
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
      i++
    }
    files.push(file)
  }
  return files
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
