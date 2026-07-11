import { useMemo, useState, type JSX } from 'react'
import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import { getSessionChanges } from '@/frontend/lib/changesApi'
import { indexDiffsByPath, type DiffLine } from '@/frontend/lib/diff'
import { LoadingIcon, WarningIcon } from '@/frontend/lib/icons'
import type { ChangeStatus, SessionChange } from '@/shared/types'

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

/**
 * The session review pane: what the agent changed in its worktree since it
 * forked from the base branch. A file list on the left, the selected file's
 * unified diff on the right. Polls the daemon so it updates as work lands;
 * read-only for now.
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

  const [picked, setPicked] = useState<string | null>(null)
  const current = picked && files.some((f) => f.path === picked) ? picked : files[0]?.path ?? null
  const currentDiff = current ? diffMap.get(current) : undefined

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

      <div className="flex min-h-0 flex-1">
        {/* File list */}
        <div className="w-52 shrink-0 overflow-y-auto border-r border-hairline py-1">
          {files.map((f) => (
            <FileRow key={f.path} file={f} active={f.path === current} onClick={() => setPicked(f.path)} />
          ))}
        </div>
        {/* Diff for the selected file */}
        <div className="min-w-0 flex-1 overflow-auto bg-bg">
          {currentDiff && !currentDiff.binary && currentDiff.lines.length > 0 ? (
            <DiffView lines={currentDiff.lines} />
          ) : (
            <div className="flex h-full items-center justify-center text-[11px] text-text-faint">
              {current && files.find((f) => f.path === current)?.binary
                ? 'Binary file — no preview'
                : 'No textual diff'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function FileRow({ file, active, onClick }: { file: SessionChange; active: boolean; onClick: () => void }): JSX.Element {
  const meta = STATUS_META[file.status]
  const { dir, base } = splitPath(file.path)
  return (
    <button
      onClick={onClick}
      title={file.path}
      className={clsx(
        'flex w-full items-center gap-2 px-3 py-1 text-left text-[11px] transition',
        active ? 'bg-surface-3 text-text' : 'text-text-dim hover:bg-surface-2',
      )}
    >
      <span className={clsx('w-2 shrink-0 text-center font-mono font-semibold', meta.className)}>{meta.letter}</span>
      <span className="min-w-0 flex-1 truncate">
        {dir && <span className="text-text-faint">{dir}</span>}
        <span>{base}</span>
      </span>
      {!file.binary && (
        <span className="shrink-0 font-mono text-[10px] text-text-faint">
          {file.additions > 0 && <span className="text-[#3fb950]">+{file.additions}</span>}
          {file.additions > 0 && file.deletions > 0 && ' '}
          {file.deletions > 0 && <span className="text-[#f85149]">−{file.deletions}</span>}
        </span>
      )}
    </button>
  )
}

function DiffView({ lines }: { lines: DiffLine[] }): JSX.Element {
  return (
    <div className="min-w-full font-mono text-[11px] leading-[1.5]">
      {lines.map((line, idx) => {
        if (line.kind === 'hunk') {
          return (
            <div key={idx} className="whitespace-pre bg-surface-2 px-2 text-text-faint">
              {line.text}
            </div>
          )
        }
        const num = line.kind === 'del' ? line.oldNo : line.newNo
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
            <span className="pr-3 text-text">{line.text}</span>
          </div>
        )
      })}
    </div>
  )
}
