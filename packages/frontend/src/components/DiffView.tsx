import { useMemo, type JSX, type ReactNode } from 'react'
import clsx from 'clsx'
import { highlightLine, type HighlightLanguage, type HighlightSegment } from '#lib/highlight'
import type { DiffLine } from '#lib/diff'

/** A find match in a line's text; the `current` one carries
 *  `data-find-current`, for scrolling to. */
export interface FindMark {
  from: number
  to: number
  current: boolean
}

/** The find highlight colors, the editor's (`ui/CodeEditor`). */
const MARK = 'bg-[rgb(210_153_34/0.3)]'
const CURRENT_MARK = 'bg-[rgb(210_153_34/0.55)] outline outline-1 outline-[rgb(210_153_34)]'

/** A line's segments, cut where the marks start and end, the marked pieces
 *  tinted. */
function withMarks(segments: HighlightSegment[], marks: FindMark[]): ReactNode[] {
  const out: ReactNode[] = []
  let pos = 0
  segments.forEach((seg, i) => {
    const end = pos + seg.text.length
    const cuts = [...new Set([pos, end, ...marks.flatMap((m) => [m.from, m.to]).filter((c) => c > pos && c < end)])]
      .sort((a, b) => a - b)
    for (let k = 0; k + 1 < cuts.length; k++) {
      const mark = marks.find((m) => m.from <= cuts[k] && cuts[k + 1] <= m.to)
      out.push(
        <span
          key={`${i}:${k}`}
          data-find-current={mark?.current || undefined}
          className={clsx(seg.className, mark && (mark.current ? CURRENT_MARK : MARK))}
        >
          {seg.text.slice(cuts[k] - pos, cuts[k + 1] - pos)}
        </span>,
      )
    }
    pos = end
  })
  return out
}

/**
 * Diff lines with +/− markers, tinted rows and syntax highlighting. Used by
 * the Changes pane (git diffs) and the chat pane (agent edits). Line numbers
 * are optional because an agent's edit fragment has no file line numbers.
 */
export function DiffView({
  lines,
  language,
  showLineNumbers = true,
  marks,
}: {
  lines: DiffLine[]
  language: HighlightLanguage | null
  showLineNumbers?: boolean
  /** Find matches, by index into `lines`. */
  marks?: ReadonlyMap<number, FindMark[]>
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
        const lineMarks = marks?.get(idx)
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
              {lineMarks
                ? withMarks(segments ?? [{ text: line.text, className: '' }], lineMarks)
                : segments
                  ? segments.map((seg, i) => <span key={i} className={seg.className}>{seg.text}</span>)
                  : line.text}
            </span>
          </div>
        )
      })}
    </div>
  )
}
