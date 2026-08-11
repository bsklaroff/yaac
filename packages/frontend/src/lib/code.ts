/**
 * Turning a blob of file text into the lines a code view renders.
 *
 * Pure, so it is unit-tested directly; the rendering half lives in
 * `#components/CodeView`. What is here is the small amount of guessing that
 * separates "the file's text" from "the file's text as a tool reported it":
 * an agent's file reader prints a numbered gutter, and some ACP adapters wrap
 * a tool's output in a markdown fence. Neither is part of the file, and both
 * would otherwise be tokenized as if they were — a leading `12→` makes every
 * line start with a number, and a fence's backticks are three characters the
 * file never contained.
 */

export interface CodeLine {
  text: string
  /** The file line this is, when the source said so. A code view shows a
   *  gutter only if something in the block answers this. */
  no?: number
}

/** `   12→const x = 1` — the arrow spelling of the gutter. A data file whose
 *  columns are separated by arrows is not a real shape, so this one needs no
 *  alignment padding to tell it from a file's own text. */
const ARROW = /^ {0,8}(\d+)→(.*)$/

/** `     12\tconst x = 1` — the tab spelling, which must carry the padding a
 *  right-aligning reader emits. `1\tapple` at column 0 is a tab-separated file
 *  keyed by an id far more often than it is a gutter, and lifting there would
 *  delete the file's first column in front of someone reading it. */
const TAB = /^ {1,8}(\d+)\t(.*)$/

/** A body that is nothing but one fenced block. */
const FENCED = /^```([^\n`]*)\n([\s\S]*?)\n?```[ \t]*\n?$/

/** Split on newlines, dropping the trailing empty line a final `\n` produces —
 *  that newline ends the last line rather than starting a blank one. */
function splitLines(text: string): string[] {
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
}

/**
 * Read a numbered gutter off every line that has one, or answer null for a
 * block that isn't numbered.
 *
 * The test is deliberately whole-block: the numbers must be *consecutive*, and
 * nearly every line must carry one. Consecutive rather than merely ascending is
 * what separates a gutter from a first column — every file reader numbers the
 * lines it prints one after the next, while an ascending id or timestamp column
 * has gaps. A block where a few lines happen to look numbered is a file that
 * happens to contain numbers, and lifting there deletes the file's own text.
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
 * Unwrap a body that is a single fenced block, answering the fence's info
 * string alongside — for a read whose path names no language we recognize, the
 * fence is the only thing that says what the text is.
 */
export function unfence(text: string): { text: string; fence: string } {
  const m = FENCED.exec(text)
  // A wrapper wraps everything. Backticks left inside mean the outer pair was
  // not a wrapper but the first and last fence of a document, and taking them
  // off would splice what is between them into one block.
  if (m === null || m[2].includes('```')) return { text, fence: '' }
  return { text: m[2], fence: m[1].trim() }
}

/** A file's text as renderable lines, with the reader's line numbers when it
 *  gave any. */
export function codeLines(text: string): CodeLine[] {
  const raw = splitLines(text)
  return numberedLines(raw) ?? raw.map((line) => ({ text: line }))
}
