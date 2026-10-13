/**
 * A column of `printTable`. An `optional` column is left out when every
 * row's cell in it is empty.
 */
export interface Column {
  header: string
  optional?: boolean
}

/**
 * Print `rows` under a header and a dashed rule, framed by blank lines.
 * Every column but the last is padded to its widest cell. The last holds
 * free text (a prompt), so it is flattened to one line and cut to what the
 * terminal has left.
 */
export function printTable(columns: Column[], rows: string[][]): void {
  const kept = columns.flatMap((c, i) => c.optional && rows.every((r) => r[i] === '') ? [] : [i])
  const widths = kept.map((i) => Math.max(columns[i].header.length, ...rows.map((r) => r[i].length)))
  const last = kept.length - 1
  const usedWidth = widths.slice(0, last).reduce((sum, w) => sum + w + 1, 1)
  const lastWidth = Math.max(10, (process.stdout.columns || 120) - usedWidth)
  const line = (cells: string[]): string =>
    cells.slice(0, last).map((c, j) => c.padEnd(widths[j])).join(' ') + '  ' + cells[last]

  console.log('')
  console.log(line(kept.map((i) => columns[i].header)))
  console.log(line(widths.map((w, j) => '-'.repeat(j === last ? Math.min(w, lastWidth, 40) : w))))
  for (const row of rows) {
    console.log(line(kept.map((i, j) => j === last ? truncatePrompt(row[i], lastWidth) : row[i])))
  }
  console.log('')
}

export function truncatePrompt(prompt: string | undefined, maxWidth: number): string {
  if (!prompt) return ''
  const flat = prompt.replace(/\s+/g, ' ').trim()
  if (flat.length <= maxWidth) return flat
  return flat.slice(0, maxWidth - 1) + '…'
}
