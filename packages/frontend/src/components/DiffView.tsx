import { useMemo, type JSX } from 'react'
import clsx from 'clsx'
import { highlightLine, type HighlightLanguage } from '#lib/highlight'
import type { DiffLine } from '#lib/diff'

/**
 * Diff lines with +/− markers, tinted rows and syntax highlighting. Used by
 * the changes pane (git diffs) and the chat pane (agent edits). Line numbers
 * are optional because an agent's edit fragment has no file line numbers.
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
  // `diff-hl` below scopes the tok-* colors (index.css).
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
              line.kind === 'add' && 'text-success',
              line.kind === 'del' && 'text-error',
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
