import { useEffect, useLayoutEffect, useMemo, useRef, type JSX } from 'react'
import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import { useUiStore } from '#store'
import { getSessionChanges } from '#lib/changesApi'
import { indexDiffsByPath, type DiffLine, type ParsedFileDiff } from '#lib/diff'
import { highlightLine, languageForPath, type HighlightLanguage } from '#lib/highlight'
import { LoadingIcon, WarningIcon, ChevronIcon } from '#lib/icons'
import type { ChangeStatus, SessionChange } from '@yaac/shared/types'

/** One-letter status badge, colored per change kind. */
const STATUS_META: Record<ChangeStatus, { letter: string; className: string }> = {
  added: { letter: 'A', className: 'text-[#3fb950]' },
  modified: { letter: 'M', className: 'text-[#d29922]' },
  deleted: { letter: 'D', className: 'text-[#f85149]' },
  renamed: { letter: 'R', className: 'text-[#58a6ff]' },
  copied: { letter: 'C', className: 'text-[#58a6ff]' },
  typechange: { letter: 'T', className: 'text-text-dim' },
}

/** Split a path into directory + basename for two-tone rendering. */
function splitPath(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf('/')
  return i === -1 ? { dir: '', base: path } : { dir: path.slice(0, i + 1), base: path.slice(i + 1) }
}

/** Render a path as a faint directory prefix + a basename; `emphasis="dim"`
 *  mutes the basename (used for the "from" side of a rename). */
function PathLabel({ path, emphasis = 'text' }: { path: string; emphasis?: 'text' | 'dim' }): JSX.Element {
  const { dir, base } = splitPath(path)
  return (
    <>
      {dir && <span className="text-text-faint">{dir}</span>}
      <span className={emphasis === 'dim' ? 'text-text-dim' : 'text-text'}>{base}</span>
    </>
  )
}

/**
 * The session review pane: what the agent changed in its worktree since it
 * forked from the base branch. Files are an accordion — click one to expand
 * its diff inline (full width), so nothing is wasted on a side column. Polls
 * the server so it updates as work lands; read-only for now.
 */
export function SessionChanges({ sessionId }: { sessionId: string }): JSX.Element {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['changes', sessionId],
    queryFn: () => getSessionChanges(sessionId),
    refetchInterval: 3000,
    staleTime: 1500,
  })

  const files = data?.files ?? []
  const diffMap = useMemo(() => indexDiffsByPath(data?.diff ?? ''), [data?.diff])

  // Which files are expanded. This lives in the store keyed by session id, not
  // in local state, so it survives the pane being torn down off-screen when the
  // user switches tabs or sessions. A missing entry means we haven't loaded
  // this session's changes yet: auto-open the first file so the pane isn't
  // empty on arrival, then leave it to the user — an existing entry (even an
  // empty one) is their choice and never gets re-seeded.
  const expandedList = useUiStore((s) => s.changesExpanded[sessionId])
  const setChangesExpanded = useUiStore((s) => s.setChangesExpanded)
  const expanded = useMemo(() => new Set(expandedList ?? []), [expandedList])
  useEffect(() => {
    if (expandedList === undefined && files.length > 0) {
      setChangesExpanded(sessionId, [files[0].path])
    }
  }, [expandedList, files, sessionId, setChangesExpanded])
  const toggle = (path: string): void => {
    const next = new Set(expanded)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setChangesExpanded(sessionId, [...next])
  }

  // Scroll offset also lives in the store, so returning to the pane lands where
  // the user left off. On remount the diff is already cached and the expanded
  // state is applied synchronously, so the content height is present by layout
  // time; restore once (guarded), then let the user drive. Later polls that
  // don't change the file list won't re-run this — and if they do, the guard
  // keeps us from yanking the scroll out from under the user.
  const setChangesScroll = useUiStore((s) => s.setChangesScroll)
  const listRef = useRef<HTMLDivElement | null>(null)
  const restoredScroll = useRef(false)
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el || restoredScroll.current) return
    restoredScroll.current = true
    el.scrollTop = useUiStore.getState().changesScroll[sessionId] ?? 0
  }, [sessionId, files.length])

  const totals = files.reduce((a, f) => ({ add: a.add + f.additions, del: a.del + f.deletions }), { add: 0, del: 0 })

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-surface text-text-dim">
        <LoadingIcon size={18} className="animate-spin" />
      </div>
    )
  }
  if (isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-surface text-xs text-text-dim">
        <WarningIcon size={18} className="text-text-faint" />
        <span>Couldn’t load changes.</span>
        <button
          onClick={() => void refetch()}
          className="rounded bg-surface-2 px-2 py-1 text-[11px] text-text-dim transition hover:text-text"
        >
          Retry
        </button>
      </div>
    )
  }
  if (files.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 bg-surface px-4 text-center">
        <p className="text-xs text-text-dim">No changes yet</p>
        <p className="text-[11px] text-text-faint">Edits the agent makes in its worktree show up here.</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex h-7 shrink-0 items-center gap-3 border-b border-hairline px-3 text-[11px] text-text-dim">
        <span>{files.length} file{files.length === 1 ? '' : 's'}</span>
        <span className="text-[#3fb950]">+{totals.add}</span>
        <span className="text-[#f85149]">−{totals.del}</span>
        {data?.truncated && (
          <span className="ml-auto text-text-faint">diff truncated (large changeset)</span>
        )}
      </div>

      <div
        ref={listRef}
        onScroll={(e) => setChangesScroll(sessionId, e.currentTarget.scrollTop)}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {files.map((f) => (
          <FileAccordion
            key={f.path}
            file={f}
            open={expanded.has(f.path)}
            diff={diffMap.get(f.path)}
            onToggle={() => toggle(f.path)}
          />
        ))}
      </div>
    </div>
  )
}

function FileAccordion({
  file, open, diff, onToggle,
}: {
  file: SessionChange
  open: boolean
  diff: ParsedFileDiff | undefined
  onToggle: () => void
}): JSX.Element {
  const meta = STATUS_META[file.status]
  // Renames/copies show `old → new`; git only sets oldPath for those.
  const renamedFrom = file.oldPath && file.oldPath !== file.path ? file.oldPath : undefined
  return (
    <div className="border-b border-hairline">
      <button
        onClick={onToggle}
        title={renamedFrom ? `${renamedFrom} → ${file.path}` : file.path}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] text-text-dim
          transition hover:bg-surface-2"
      >
        <ChevronIcon size={12} className={clsx('shrink-0 text-text-faint transition-transform', open && 'rotate-90')} />
        <span className={clsx('w-2 shrink-0 text-center font-mono font-semibold', meta.className)}>{meta.letter}</span>
        <span className="min-w-0 flex-1 truncate">
          {renamedFrom && (
            <>
              <PathLabel path={renamedFrom} emphasis="dim" />
              <span className="text-text-faint"> → </span>
            </>
          )}
          <PathLabel path={file.path} />
        </span>
        {!file.binary && (
          <span className="shrink-0 font-mono text-[10px] text-text-faint">
            {file.additions > 0 && <span className="text-[#3fb950]">+{file.additions}</span>}
            {file.additions > 0 && file.deletions > 0 && ' '}
            {file.deletions > 0 && <span className="text-[#f85149]">−{file.deletions}</span>}
          </span>
        )}
      </button>
      {open && (
        <div className="overflow-x-auto border-t border-hairline bg-bg">
          {diff && !diff.binary && diff.lines.length > 0 ? (
            <DiffView lines={diff.lines} language={languageForPath(file.path)} />
          ) : (
            <div className="px-3 py-2 text-[11px] text-text-faint">
              {file.binary ? 'Binary file — no preview' : 'No textual diff'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function DiffView({ lines, language }: { lines: DiffLine[]; language: HighlightLanguage | null }): JSX.Element {
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
            <span className="w-10 shrink-0 select-none px-1 text-right text-text-faint/70">{num ?? ''}</span>
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
