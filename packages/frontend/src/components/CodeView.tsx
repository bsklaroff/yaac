import { useMemo, type JSX } from 'react'
import clsx from 'clsx'
import { highlightLine, type HighlightLanguage } from '#lib/highlight'
import type { CodeLine } from '#lib/code'

/**
 * Source lines, syntax-highlighted — the plain-code counterpart to `DiffView`.
 *
 * The two are the same rendering with different gutters, and both are used in
 * the chat pane: an edit tool call is a diff, a read tool call is the file. The
 * `diff-hl` class is what scopes the `tok-*` colors (index.css), so code in a
 * message, a read, and the changes pane are all the same colors.
 *
 * Highlighting is per line for the reason it is in the diff view: the tokenizer
 * sees one line at a time, so a construct spanning several (a block comment)
 * is only recognized where the parser can see it.
 */
export function CodeView({
  lines,
  language,
  className,
}: {
  lines: CodeLine[]
  language: HighlightLanguage | null
  className?: string
}): JSX.Element {
  const highlighted = useMemo(
    () => (language ? lines.map((line) => highlightLine(line.text, language)) : null),
    [lines, language],
  )
  // One block's lines are numbered or none are, so the gutter is a property of
  // the block rather than something that appears and disappears down it.
  const numbered = lines.some((line) => line.no !== undefined)
  return (
    <div className={clsx('diff-hl min-w-full font-mono text-[11px] leading-[1.5] text-text', className)}>
      {lines.map((line, idx) => {
        const segments = highlighted?.[idx] ?? null
        return (
          <div key={idx} className="flex whitespace-pre">
            {numbered && (
              <span className="w-10 shrink-0 select-none px-1 text-right text-text-faint/70">{line.no ?? ''}</span>
            )}
            <span className="pr-3">
              {segments
                ? segments.map((seg, i) => <span key={i} className={seg.className}>{seg.text}</span>)
                : line.text}
              {/* A blank line still has a line's height. */}
              {line.text === '' && ' '}
            </span>
          </div>
        )
      })}
    </div>
  )
}
