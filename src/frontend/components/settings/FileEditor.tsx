import { useEffect, useState, type JSX } from 'react'
import { CodeEditor, type CodeLanguage } from '@/frontend/components/ui/CodeEditor'

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * A syntax-highlighted file editor with a load/save lifecycle: fetches the
 * initial text via `load`, tracks dirty state, and persists via `save`.
 * `load`/`save` must be stable (memoize with useCallback keyed on the
 * target file) — the editor reloads whenever `load` changes identity, so a
 * new `load` is how the caller points it at a different file.
 */
export function FileEditor({
  language,
  load,
  save,
  hint,
}: {
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

  return (
    <div className="flex flex-col gap-2">
      <CodeEditor
        value={text ?? ''}
        onChange={(v) => { setText(v); setSaved(false); setError(null) }}
        language={language}
      />
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
    </div>
  )
}
