import { useMemo, type JSX } from 'react'
import clsx from 'clsx'
import { highlightLine, type HighlightLanguage } from '#lib/highlight'
import type { DiffLine } from '#lib/diff'

/**
 * Rendered diff lines: +/− gutters, tinted rows, syntax-highlighted code.
 *
 * Shared by the two panes that show a diff — the changes pane (a parsed `git
 * diff`) and the chat pane (an agent's edit tool call) — so an edit looks the
 * same wherever the user meets it. What differs between them is only what
 * their source can honestly claim: a git hunk knows its file line numbers, an
 * agent's edit fragment does not, so the gutter is optional.
 */
export function DiffView({
  lines,
  language,
  showLineNumbers = true,
}: {
  lines: DiffLine[]
  language: HighlightLanguage | null
  showLineNumbers?: boolean
}): JSX.Element {
  // Tokenize each code line once per (lines, language); hunk headers and the
  // no-language case stay plain. `diff-hl` scopes the tok-* colors (index.css).
  const highlighted = useMemo(
    () => (language ? lines.map((line) => (line.kind === 'hunk' ? null : highlightLine(line.text, language))) : null),
    [lines, language],
  )
  return (
    <div className="diff-hl min-w-full font-mono text-[11px] leading-[1.5]">
      {lines.map((line, idx) => {
        if (line.kind === 'hunk') {
          return (
            <div key={idx} className="whitespace-pre bg-surface-2 px-2 text-text-faint">
              {line.text}
            </div>
          )
        }
        const num = line.kind === 'del' ? line.oldNo : line.newNo
        const segments = highlighted?.[idx] ?? null
        return (
          <div
            key={idx}
            className={clsx(
              'flex whitespace-pre',
              line.kind === 'add' && 'bg-[rgb(63_185_80/0.14)]',
              line.kind === 'del' && 'bg-[rgb(248_81_73/0.14)]',
            )}
          >
            {showLineNumbers && (
              <span className="w-10 shrink-0 select-none px-1 text-right text-text-faint/70">{num ?? ''}</span>
            )}
            <span className={clsx(
              'w-3 shrink-0 select-none text-center',
              line.kind === 'add' && 'text-[#3fb950]',
              line.kind === 'del' && 'text-[#f85149]',
              line.kind === 'context' && 'text-transparent',
            )}>
              {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
            </span>
            <span className="pr-3 text-text">
              {segments
                ? segments.map((seg, i) => <span key={i} className={seg.className}>{seg.text}</span>)
                : line.text}
            </span>
          </div>
        )
      })}
    </div>
  )
}
