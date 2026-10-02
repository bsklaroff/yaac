import { useState, type JSX } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CodeEditor } from '#components/ui/CodeEditor'
import { Modal } from '#components/ui/Modal'
import type { HighlightLanguage } from '#lib/highlight'
import { CollapseIcon, ExpandIcon } from '#lib/icons'
import { useUiStore } from '#lib/store'

/**
 * A syntax-highlighted file editor that loads text via `load` (cached under
 * `queryKey`, and refetched each time the editor mounts), tracks dirty
 * state, and saves via `save`. A caller switches files by changing
 * `queryKey`.
 *
 * An expand button opens the same buffer in a near-fullscreen dialog titled
 * `title`; edits carry over in both directions. Text size follows the file
 * pane's text-size setting.
 */
export function FileEditor({
  title,
  language,
  queryKey,
  load,
  save,
  hint,
}: {
  title: string
  language: HighlightLanguage | null
  queryKey: readonly unknown[]
  load: () => Promise<string>
  save: (text: string) => Promise<void>
  hint?: string
}): JSX.Element {
  const queryClient = useQueryClient()
  const loaded = useQuery({ queryKey, queryFn: load, staleTime: 0 })
  // The edited text; null while it matches what was loaded or saved.
  const [edit, setEdit] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const fontSize = useUiStore((s) => s.editorFontSize)
  const saving = useMutation({
    mutationFn: save,
    onSuccess: (_, text) => {
      queryClient.setQueryData(queryKey, text)
      setEdit(null)
    },
  })

  if (loaded.isPending) return <p className="text-xs text-text-faint">Loading…</p>

  const text = edit ?? loaded.data ?? ''
  const dirty = edit !== null && edit !== loaded.data
  const error = saving.error ?? loaded.error
  const onEdit = (v: string): void => {
    setEdit(v)
    saving.reset()
  }
  const onSave = (): void => saving.mutate(text)

  const footer = (
    <>
      {hint && <p className="text-[11px] leading-relaxed text-text-faint">{hint}</p>}
      {error && <p className="whitespace-pre-wrap text-xs text-red-400">{error.message}</p>}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={saving.isPending || !dirty}
          className="shrink-0 rounded-md bg-surface-3 px-3 py-1.5 text-xs font-medium text-text transition
            hover:bg-border-strong disabled:opacity-50"
        >
          {saving.isPending ? 'Saving…' : 'Save'}
        </button>
        {saving.isSuccess && !dirty && <span className="text-xs text-emerald-400">Saved</span>}
      </div>
    </>
  )

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <CodeEditor value={text} onChange={onEdit} language={language} fontSize={fontSize} />
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

      <Modal
        open={expanded}
        onOpenChange={setExpanded}
        variant="sheet"
        title={title}
        closeLabel="Collapse editor"
        closeIcon={<CollapseIcon size={14} />}
      >
        <CodeEditor
          value={text}
          onChange={onEdit}
          language={language}
          fontSize={fontSize}
          height="100%"
          className="min-h-0 flex-1"
        />
        {footer}
      </Modal>
    </div>
  )
}
