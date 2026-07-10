import { useEffect, useState, type JSX } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { CodeEditor, type CodeLanguage } from '#components/ui/CodeEditor'
import { CollapseIcon, ExpandIcon } from '#lib/icons'

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * A syntax-highlighted file editor with a load/save lifecycle: fetches the
 * initial text via `load`, tracks dirty state, and persists via `save`.
 * `load`/`save` must be stable (memoize with useCallback keyed on the
 * target file) — the editor reloads whenever `load` changes identity, so a
 * new `load` is how the caller points it at a different file.
 *
 * An expand button on the editor frame opens the same buffer in a
 * near-fullscreen overlay (a nested dialog, titled `title`) with the same
 * hint/error/save row below it; the text state is shared, so edits and
 * dirty state survive expanding and collapsing.
 */
export function FileEditor({
  title,
  language,
  load,
  save,
  hint,
}: {
  title: string
  language: CodeLanguage
  load: () => Promise<string>
  save: (text: string) => Promise<void>
  hint?: string
}): JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const [original, setOriginal] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false
    setText(null)
    setError(null)
    setSaved(false)
    load()
      .then((t) => { if (!cancelled) { setText(t); setOriginal(t) } })
      .catch((e: unknown) => { if (!cancelled) { setText(''); setOriginal(''); setError(errMessage(e)) } })
    return () => { cancelled = true }
  }, [load])

  const dirty = text !== null && text !== original

  const onEdit = (v: string): void => {
    setText(v)
    setSaved(false)
    setError(null)
  }

  const onSave = (): void => {
    if (text === null) return
    setBusy(true)
    setError(null)
    setSaved(false)
    save(text)
      .then(() => { setOriginal(text); setSaved(true) })
      .catch((e: unknown) => setError(errMessage(e)))
      .finally(() => setBusy(false))
  }

  if (text === null && error === null) {
    return <p className="text-xs text-text-faint">Loading…</p>
  }

  // Rendered below the editor both inline and expanded.
  const footer = (
    <>
      {hint && <p className="text-[11px] leading-relaxed text-text-faint">{hint}</p>}
      {error && <p className="whitespace-pre-wrap text-xs text-red-400">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={busy || !dirty}
          className="shrink-0 rounded-md bg-surface-3 px-3 py-1.5 text-xs font-medium text-text transition
            hover:bg-border-strong disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {saved && !dirty && <span className="text-xs text-emerald-400">Saved</span>}
      </div>
    </>
  )

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <CodeEditor value={text ?? ''} onChange={onEdit} language={language} />
        <button
          type="button"
          onClick={() => setExpanded(true)}
          title="Expand editor"
          aria-label="Expand editor"
          className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded
            bg-surface-2/80 text-text-faint transition hover:bg-surface-3 hover:text-text"
        >
          <ExpandIcon size={12} />
        </button>
      </div>
      {footer}

      <Dialog.Root open={expanded} onOpenChange={setExpanded}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 bg-black/60 backdrop-blur-[1px] transition-opacity duration-150
            data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
          <Dialog.Popup className="fixed inset-4 flex flex-col gap-2 rounded-xl border border-white/[0.06]
            bg-surface p-4 text-text shadow-[0_16px_48px_rgba(0,0,0,0.5)] outline-none transition duration-150
            data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:scale-95
            data-[ending-style]:opacity-0">
            <div className="flex items-center justify-between">
              <Dialog.Title className="text-xs font-semibold text-text-dim">{title}</Dialog.Title>
              <Dialog.Close
                title="Collapse editor"
                aria-label="Collapse editor"
                className="flex h-6 w-6 items-center justify-center rounded text-text-faint transition
                  hover:bg-surface-2 hover:text-text"
              >
                <CollapseIcon size={14} />
              </Dialog.Close>
            </div>
            <CodeEditor
              value={text ?? ''}
              onChange={onEdit}
              language={language}
              height="100%"
              className="min-h-0 flex-1"
            />
            {footer}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}
