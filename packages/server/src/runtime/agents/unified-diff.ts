/**
 * Each hunk of a one-file unified diff as before/after text, the shape a
 * `diff` tool content entry takes. A "No newline at end of file" marker
 * strips the line break off the side it follows.
 */
export function unifiedDiffHunks(diff: string): Array<{ oldText: string; newText: string }> {
  const hunks: Array<{ old: string[]; new: string[]; previous: string }> = []
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      hunks.push({ old: [], new: [], previous: ' ' })
      continue
    }
    const hunk = hunks.at(-1)
    const sign = line[0]
    if (hunk === undefined || sign === undefined) continue
    if (sign === '\\') {
      if (hunk.previous !== '+') stripBreak(hunk.old)
      if (hunk.previous !== '-') stripBreak(hunk.new)
      continue
    }
    if (sign !== '+') hunk.old.push(`${line.slice(1)}\n`)
    if (sign !== '-') hunk.new.push(`${line.slice(1)}\n`)
    hunk.previous = sign
  }
  return hunks.map((h) => ({ oldText: h.old.join(''), newText: h.new.join('') }))
}

function stripBreak(lines: string[]): void {
  const last = lines.at(-1)
  if (last !== undefined) lines[lines.length - 1] = last.slice(0, -1)
}
