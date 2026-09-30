/**
 * Turns file text, as a tool reported it, into the lines a code view renders
 * (`#components/CodeView` does the rendering). An agent's file reader may
 * print a line-number gutter, and some ACP adapters wrap output in a
 * markdown fence. Neither is part of the file, so both are stripped here.
 */

export interface CodeLine {
  text: string
  /** The file line number, when the tool printed one. A code view shows a
   *  gutter only if some line has one. */
  no?: number
}

/** `   12→const x = 1`: the arrow gutter. Real files don't use arrows as
 *  column separators, so no leading padding is required. */
const ARROW = /^ {0,8}(\d+)→(.*)$/

/** `     12\tconst x = 1`: the tab gutter. Leading padding is required, since
 *  `1\tapple` at column 0 is far more often a TSV file's id column. */
const TAB = /^ {1,8}(\d+)\t(.*)$/

/** A body that is nothing but one fenced block. */
const FENCED = /^```([^\n`]*)\n([\s\S]*?)\n?```[ \t]*\n?$/

/** Split on newlines. A final `\n` ends the last line rather than starting a
 *  blank one. */
function splitLines(text: string): string[] {
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
}

/**
 * Strip a line-number gutter, or return null if the block isn't numbered.
 *
 * The check covers the whole block: nearly every line must be numbered and
 * the numbers must be consecutive. An id or timestamp column ascends with
 * gaps, and a block where only a few lines look numbered is just a file
 * containing numbers.
 */
function numberedLines(raw: string[]): CodeLine[] | null {
  const lines: CodeLine[] = []
  let matched = 0
  let previous: number | undefined
  for (const line of raw) {
    const m = ARROW.exec(line) ?? TAB.exec(line)
    const no = m === null ? undefined : Number(m[1])
    if (m === null || no === undefined || (previous !== undefined && no !== previous + 1)) {
      lines.push({ text: line })
      continue
    }
    matched += 1
    previous = no
    lines.push({ text: m[2], no })
  }
  return matched >= 3 && matched >= raw.length * 0.8 ? lines : null
}

/**
 * Unwrap a body that is a single fenced block, and return the fence's info
 * string, which may be the only hint of the text's language.
 */
export function unfence(text: string): { text: string; fence: string } {
  const m = FENCED.exec(text)
  // Backticks inside mean the outer pair are the first and last fences of a
  // document with several blocks, not a wrapper.
  if (m === null || m[2].includes('```')) return { text, fence: '' }
  return { text: m[2], fence: m[1].trim() }
}

/** A file's text as renderable lines, with line numbers when the tool
 *  printed them. */
export function codeLines(text: string): CodeLine[] {
  const raw = splitLines(text)
  return numberedLines(raw) ?? raw.map((line) => ({ text: line }))
}
