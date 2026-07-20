/**
 * Parse a combined `git diff` (unified format) into per-file, per-line
 * structures the changes pane renders. Pure — no DOM, so it's unit-tested
 * directly. Handles new/deleted/binary files and multiple hunks; line numbers
 * are tracked for the diff gutter.
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
