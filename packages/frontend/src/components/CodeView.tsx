import { useMemo, type JSX } from 'react'
import clsx from 'clsx'
import { highlightLine, type HighlightLanguage } from '#lib/highlight'
import type { CodeLine } from '#lib/code'

/**
 * Syntax-highlighted source lines; the plain-code counterpart to `DiffView`.
 * The `diff-hl` class scopes the `tok-*` colors (index.css). Highlighting is
 * per line, so constructs spanning lines (block comments) are not recognized.
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
  // Show the gutter for the whole block if any line is numbered.
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
