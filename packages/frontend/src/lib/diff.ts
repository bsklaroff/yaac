/**
 * Diff structures the panes render, from the two sources that produce them:
 * a combined `git diff` (the changes pane) and a before/after text pair (an
 * ACP edit tool call, in the chat pane). Both land on the same `DiffLine[]`,
 * so one renderer draws both. Pure — no DOM, so it's unit-tested directly.
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

/** Index parsed file diffs by path for quick lookup from the file list. */
export function indexDiffsByPath(diff: string): Map<string, ParsedFileDiff> {
  const map = new Map<string, ParsedFileDiff>()
  for (const f of parseUnifiedDiff(diff)) map.set(f.path, f)
  return map
}

/**
 * Split a text into lines for diffing, without the phantom last line a
 * trailing newline would otherwise produce. An empty text is no lines at all,
 * not one blank one — an empty file being replaced should not read as a
 * deleted blank line.
 */
function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Number each distinct line, so the matching below compares integers.
 *
 * Without this the cap bounds how many cells the table has but not what one
 * costs: every cell is a string comparison, and lines that are long and
 * near-identical — a lockfile, a generated file, anything an agent can put in
 * front of us — make each comparison walk the whole line before answering.
 * Interning makes them all O(1), so the cap means what it says.
 */
function internLines(a: string[], b: string[]): { a: Int32Array; b: Int32Array } {
  const ids = new Map<string, number>()
  const idOf = (line: string): number => {
    const seen = ids.get(line)
    if (seen !== undefined) return seen
    ids.set(line, ids.size)
    return ids.size - 1
  }
  return { a: Int32Array.from(a, idOf), b: Int32Array.from(b, idOf) }
}

/**
 * Above this many cells the line-matching table costs more than the result is
 * worth. An agent's edit block is a hunk with a little context, so a fragment
 * this large means something unusual — a whole-file rewrite — where showing
 * the old block then the new one reads just as well as an interleaved diff.
 */
const MAX_DIFF_CELLS = 1_000_000

/** Every line of one side, as one kind. The fallback for a pair too large to
 *  match line by line, and the whole answer when one side is absent. */
function wholeSide(text: string, kind: 'add' | 'del'): DiffLine[] {
  return splitLines(text).map((line, i) => ({
    kind,
    text: line,
    oldNo: kind === 'del' ? i + 1 : null,
    newNo: kind === 'add' ? i + 1 : null,
  }))
}

/**
 * Diff a before/after pair of texts into renderable lines.
 *
 * This is what an ACP edit tool call hands us: not a unified diff, but the two
 * versions of a *fragment* — one hunk of a file, with context lines around the
 * change, or the entire contents when a file is being created. So the line
 * numbers here are positions within the fragment, and a renderer showing them
 * as file line numbers would be lying; the chat pane's diff view leaves the
 * gutter off for that reason.
 *
 * The matching is a plain longest-common-subsequence over lines, which is what
 * makes context lines render as context instead of as a delete and an add of
 * the same text.
 */
export function diffTextPair(oldText: string | undefined, newText: string): DiffLine[] {
  if (oldText === undefined) return wholeSide(newText, 'add')
  const a = splitLines(oldText)
  const b = splitLines(newText)
  if ((a.length + 1) * (b.length + 1) > MAX_DIFF_CELLS) {
    return [...wholeSide(oldText, 'del'), ...wholeSide(newText, 'add')]
  }

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:],
  // in one flat row-major table. Both sides are compared as interned ids; the
  // strings themselves are only ever read for the text of an emitted line.
  const { a: ia, b: ib } = internLines(a, b)
  const width = b.length + 1
  const lcs = new Int32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] = ia[i] === ib[j]
        ? lcs[(i + 1) * width + j + 1] + 1
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1])
    }
  }

  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (ia[i] === ib[j]) {
      lines.push({ kind: 'context', text: a[i], oldNo: i + 1, newNo: j + 1 })
      i++
      j++
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      lines.push({ kind: 'del', text: a[i], oldNo: i + 1, newNo: null })
      i++
    } else {
      lines.push({ kind: 'add', text: b[j], oldNo: null, newNo: j + 1 })
      j++
    }
  }
  for (; i < a.length; i++) lines.push({ kind: 'del', text: a[i], oldNo: i + 1, newNo: null })
  for (; j < b.length; j++) lines.push({ kind: 'add', text: b[j], oldNo: null, newNo: j + 1 })
  return lines
}

/** How many lines a diff adds and removes — the +N/−N a file header shows. */
export function diffStats(lines: DiffLine[]): { additions: number; deletions: number } {
  return {
    additions: lines.filter((l) => l.kind === 'add').length,
    deletions: lines.filter((l) => l.kind === 'del').length,
  }
}

/**
 * Whether a changed file matches a find query: a case-insensitive substring
 * of its path (either side of a rename) or of any code line in its diff.
 * Hunk headers are skipped — their line numbers aren't content. An empty
 * query matches everything, so an unfiltered list needs no special case.
 */
export function changeMatchesQuery(
  file: { path: string; oldPath?: string },
  diff: ParsedFileDiff | undefined,
  query: string,
): boolean {
  const q = query.toLowerCase()
  if (q === '') return true
  if (file.path.toLowerCase().includes(q)) return true
  if (file.oldPath && file.oldPath.toLowerCase().includes(q)) return true
  return diff?.lines.some((l) => l.kind !== 'hunk' && l.text.toLowerCase().includes(q)) ?? false
}
