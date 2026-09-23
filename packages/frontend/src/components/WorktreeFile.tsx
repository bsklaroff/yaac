import { useEffect, useReducer, useState, type JSX, type KeyboardEvent } from 'react'
import clsx from 'clsx'
import { ServerError } from '@yaac/shared/errors'
import type { WorktreeFile as WorktreeFileRead } from '@yaac/shared/types'
import { useUiStore } from '#store'
import { CodeEditor } from '#components/ui/CodeEditor'
import { PathLabel } from '#components/ui/PathLabel'
import { languageForPath } from '#lib/highlight'
import { chordMatches, saveChord } from '#lib/shortcuts'
import {
  FileConflict,
  discardFileSavers,
  fileKey,
  fileSaver,
  readWorktreeFile,
  registerFileSaver,
  saveWorktreeFile,
} from '#lib/files'
import { LoadingIcon, SaveIcon, WarningIcon } from '#lib/icons'

/** Idle time after the last edit before it saves itself. */
export const AUTOSAVE_MS = 1000
/** How often a visible pane asks whether the file changed on disk. */
export const POLL_MS = 2000
/** Backoff between retries of a save that failed in transport. */
export const RETRY_MS = [2000, 5000, 10000]

type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'binary' }
  | { kind: 'large'; size: number }
  | { kind: 'ready' }

type SaveStatus = 'idle' | 'saving' | 'saved' | 'retrying'

/**
 * Every write one editor pane makes, and what it knows about the file on
 * disk. One save runs at a time: edits made while it is in flight wait for
 * it and go out against the version it returned, so the pane never races
 * itself. A 409 pauses autosave until the user picks Reload or Overwrite —
 * autosave never overwrites someone else's version, and never recreates a
 * file that is gone.
 */
class Saver {
  /** What the last load or successful save holds. */
  base: { text: string; version: string } | null = null
  text = ''
  phase: Phase = { kind: 'loading' }
  status: SaveStatus = 'idle'
  /** Set when the file moved on under a dirty buffer, or a save was refused:
   *  the version it has now, null when it is gone. Autosave waits while set. */
  conflict: { version: string | null } | null = null
  private debounce: ReturnType<typeof setTimeout> | undefined
  private retry: ReturnType<typeof setTimeout> | undefined
  private retries = 0
  private inFlight: Promise<void> | null = null
  /** Polls are numbered, and one issued before the latest save landed is
   *  ignored: it may have read the file between the write and its answer. */
  private pollSeq = 0
  private landedAt = 0
  /** Set when a save found no worktree at all (the project removed, the
   *  worktree deleted): there is nowhere left to save to, so nothing retries. */
  lost = false
  /** False while no pane shows this saver: it stops polling, not saving. */
  alive = true
  /** Called on every change; the mounted pane re-renders on it. */
  notify: () => void = () => {}

  constructor(
    private readonly worktreeId: string,
    private readonly path: string,
  ) {}

  get dirty(): boolean {
    return this.base !== null && this.text !== this.base.text
  }

  edit(text: string): void {
    this.text = text
    if (this.status === 'saved') this.status = 'idle'
    this.notify()
    if (this.conflict) return
    clearTimeout(this.debounce)
    this.debounce = setTimeout(() => void this.flush(), AUTOSAVE_MS)
  }

  /** Save now; resolves true once the buffer is clean. */
  async flush(): Promise<boolean> {
    this.cancel()
    while (!this.conflict && !this.lost) {
      if (this.inFlight) {
        await this.inFlight
        continue
      }
      if (!this.dirty) break
      await this.save(this.base!.version)
      if (this.status === 'retrying') break
    }
    return !this.dirty
  }

  /** Drop any pending autosave or retry. */
  cancel(): void {
    clearTimeout(this.debounce)
    clearTimeout(this.retry)
  }

  private save(baseVersion: string | null): Promise<void> {
    const sent = this.text
    this.status = 'saving'
    this.notify()
    const run = (async () => {
      try {
        const saved = await saveWorktreeFile(this.worktreeId, this.path, sent, baseVersion)
        this.base = { text: sent, version: saved.version }
        this.landedAt = this.pollSeq
        this.conflict = null
        this.retries = 0
        this.status = 'saved'
      } catch (err) {
        if (err instanceof FileConflict) {
          this.conflict = { version: err.version }
          this.status = 'idle'
        } else if (err instanceof ServerError && err.code === 'NOT_FOUND') {
          this.lost = true
          this.status = 'idle'
          this.phase = { kind: 'error', message: 'This worktree is gone, so its unsaved text cannot be saved.' }
        } else {
          this.status = 'retrying'
          const delay = RETRY_MS[Math.min(this.retries++, RETRY_MS.length - 1)]
          this.retry = setTimeout(() => void this.flush(), delay)
        }
      } finally {
        this.inFlight = null
        this.notify()
      }
    })()
    this.inFlight = run
    return run
  }

  /** Ask the server whether the file moved on. */
  async poll(): Promise<void> {
    if (this.inFlight || this.phase.kind === 'binary' || this.phase.kind === 'large') return
    const seq = ++this.pollSeq
    let file: WorktreeFileRead
    try {
      file = await readWorktreeFile(this.worktreeId, this.path, this.base?.version)
    } catch (err) {
      if (!this.alive || seq <= this.landedAt || this.inFlight) return
      if (err instanceof ServerError && err.code === 'NOT_FOUND') {
        if (this.base === null) this.phase = { kind: 'ready' }
        this.gone()
      } else if (this.base === null) {
        this.phase = { kind: 'error', message: err instanceof Error ? err.message : String(err) }
        this.notify()
      }
      return
    }
    if (!this.alive || seq <= this.landedAt || this.inFlight) return
    this.receive(file)
  }

  private gone(): void {
    this.cancel()
    this.conflict = { version: null }
    this.notify()
  }

  private receive(file: WorktreeFileRead): void {
    if (file.content === null) {
      this.phase = file.binary ? { kind: 'binary' } : { kind: 'large', size: file.size }
      this.notify()
      return
    }
    if (this.base !== null && file.version === this.base.version) {
      // Back on disk as we last knew it — a missing file restored.
      if (this.conflict?.version === null) {
        this.conflict = null
        this.notify()
      }
      return
    }
    if (file.content === undefined) return
    if (this.base === null || !this.dirty) {
      // A clean buffer takes the new text; the editor applies it as one
      // minimal change, so the cursor and scroll survive.
      this.base = { text: file.content, version: file.version }
      this.text = file.content
      this.phase = { kind: 'ready' }
      this.conflict = null
    } else {
      this.cancel()
      this.conflict = { version: file.version }
    }
    this.notify()
  }

  /** Discard the buffer for what is on disk now. */
  async reload(): Promise<void> {
    this.cancel()
    try {
      const file = await readWorktreeFile(this.worktreeId, this.path)
      this.base = null
      this.conflict = null
      this.receive(file)
    } catch (err) {
      if (err instanceof ServerError && err.code === 'NOT_FOUND') this.gone()
    }
  }

  /** Save the buffer over whatever is there now, recreating a file that is
   *  gone — the only way either happens. */
  async overwrite(): Promise<void> {
    this.cancel()
    if (this.inFlight) await this.inFlight
    if (!this.conflict) return
    await this.save(this.conflict.version)
    if (!this.conflict) await this.flush()
  }
}

function formatSize(bytes: number): string {
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

/**
 * One file open for editing (docs/file-editor.md). Kept mounted while hidden
 * so its undo history, cursor and unsaved text survive a tab switch; it polls
 * only while visible. Edits save themselves a second after the last
 * keystroke, and Cmd/Ctrl-S — handled on the pane's root, so it covers the
 * header strip too and never reaches a terminal — saves at once.
 */
export function WorktreeFile({ worktreeId, path, visible, onClose }: {
  worktreeId: string
  path: string
  visible: boolean
  onClose: () => void
}): JSX.Element {
  const [, render] = useReducer((n: number) => n + 1, 0)
  const key = fileKey(worktreeId, path)
  // A saver that outlived an earlier pane of this file still holds its text.
  const [saver] = useState(() => fileSaver<Saver>(key) ?? new Saver(worktreeId, path))
  saver.notify = render
  const setFileDirty = useUiStore((s) => s.setFileDirty)

  useEffect(() => {
    saver.alive = true
    saver.notify = render
    registerFileSaver(key, saver)
    return () => {
      saver.alive = false
      const forget = (): void => {
        discardFileSavers([key])
        useUiStore.getState().setFileDirty(worktreeId, path, false)
      }
      // Closed on purpose (or deleted): nothing it holds is kept.
      if (fileSaver(key) !== saver) {
        saver.cancel()
        useUiStore.getState().setFileDirty(worktreeId, path, false)
        return
      }
      // Nothing to keep, or nowhere left to save it.
      if (!saver.dirty || saver.lost) {
        forget()
        return
      }
      // Unmounted with unsaved text though nobody closed it: its worktree
      // left the snapshot (stopped by the user, the reaper or yaac-mama).
      // The checkout stays and takes writes, so what can be saved is saved,
      // retries and all. A conflicted or failing buffer stays registered and
      // marked dirty — the page guards it — and a pane of the same file, once
      // the worktree is back, picks it up. A worktree that is gone for good
      // ends it: with nowhere to save to, and no pane to show it, it is
      // forgotten rather than retried for the life of the page.
      saver.notify = () => {
        if (!saver.alive && (!saver.dirty || saver.lost) && fileSaver(key) === saver) forget()
      }
      void saver.flush()
    }
  }, [saver, key, worktreeId, path])

  const dirty = saver.dirty
  useEffect(() => { setFileDirty(worktreeId, path, dirty) }, [dirty, setFileDirty, worktreeId, path])

  // Poll while visible, at once whenever the pane comes back; going hidden
  // saves what is pending.
  useEffect(() => {
    if (!visible) {
      void saver.flush()
      return
    }
    void saver.poll()
    const timer = setInterval(() => void saver.poll(), POLL_MS)
    return () => clearInterval(timer)
  }, [visible, saver])

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!chordMatches(saveChord(), e.nativeEvent)) return
    e.preventDefault()
    void saver.flush()
  }

  const { phase, conflict, status } = saver
  const statusLabel = conflict?.version != null
    ? 'Paused: conflict'
    : status === 'saving' ? 'Saving…'
      : status === 'retrying' ? 'Save failed, retrying'
        : status === 'saved' && !dirty ? 'Saved' : ''

  const body = ((): JSX.Element => {
    const center = 'flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-xs text-text-dim'
    switch (phase.kind) {
      case 'loading':
        return <div className={center}><LoadingIcon size={18} className="animate-spin" /></div>
      case 'error':
        return (
          <div className={center}>
            <WarningIcon size={18} className="text-text-faint" />
            <span>{phase.message}</span>
            <button onClick={() => void saver.poll()} className="rounded bg-surface-2 px-2 py-1 text-[11px] hover:text-text">
              Retry
            </button>
          </div>
        )
      case 'binary':
        return <div className={center}>Binary file, not shown</div>
      case 'large':
        return <div className={center}>Too large to edit ({formatSize(phase.size)})</div>
      case 'ready':
        if (conflict?.version === null) {
          return (
            <div className={center}>
              <span>Deleted on disk</span>
              <div className="flex gap-2">
                {dirty && (
                  <button onClick={() => void saver.overwrite()} className="rounded bg-surface-2 px-2 py-1 text-[11px] hover:text-text">
                    Save to recreate
                  </button>
                )}
                <button onClick={onClose} className="rounded bg-surface-2 px-2 py-1 text-[11px] hover:text-text">
                  Close
                </button>
              </div>
            </div>
          )
        }
        return (
          <CodeEditor
            value={saver.text}
            onChange={(v) => saver.edit(v)}
            language={languageForPath(path)}
            height="100%"
            className="min-h-0 flex-1"
            bare
          />
        )
    }
  })()

  return (
    <div
      className="flex h-full flex-col bg-bg"
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) void saver.flush()
      }}
    >
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-hairline bg-surface px-2 text-[11px]">
        <span className="min-w-0 flex-1 truncate font-mono" title={path}>
          <PathLabel path={path} />
          {dirty && <span aria-label="Unsaved changes" className="ml-1.5 text-text-dim">●</span>}
        </span>
        {statusLabel && (
          <span className={clsx('shrink-0', status === 'retrying' || conflict ? 'text-[#d29922]' : 'text-text-faint')}>
            {statusLabel}
          </span>
        )}
        <button
          onClick={() => void saver.flush()}
          disabled={phase.kind !== 'ready' || !!conflict}
          title="Save"
          aria-label="Save"
          className="flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-text-dim transition
            hover:bg-surface-2 hover:text-text disabled:opacity-40"
        >
          <SaveIcon size={11} />
          Save
        </button>
      </div>
      {conflict?.version != null && (
        <div role="alert" className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-hairline
          bg-[#d29922]/10 px-2 py-1 text-[11px] text-text-dim">
          <span>Changed on disk since you started editing:</span>
          <button onClick={() => void saver.reload()} className="font-medium text-text hover:underline">
            Reload
          </button>
          <span className="text-text-faint">(discard yours) ·</span>
          <button onClick={() => void saver.overwrite()} className="font-medium text-text hover:underline">
            Overwrite
          </button>
        </div>
      )}
      {body}
    </div>
  )
}
