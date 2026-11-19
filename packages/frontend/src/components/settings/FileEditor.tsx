import { useState, type JSX } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CodeEditor } from '#components/CodeEditor'
import type { HighlightLanguage } from '#lib/highlight'
import { CollapseIcon, ExpandIcon } from '#lib/icons'
import { useUiStore } from '#lib/store'
import { YButton, YDialog } from '#ui'

/**
 * A syntax-highlighted file editor that loads text via `load` (cached under
 * `queryKey`, and refetched each time the editor mounts), tracks dirty
 * state, and saves via `save`; without `save` it is a read-only viewer. A
 * caller switches files by changing `queryKey`.
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
  save?: (text: string) => Promise<void>
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

  if (loaded.isPending) return <p className="text-md text-subtle">Loading…</p>

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
      {hint && <p className="text-sm leading-relaxed text-subtle">{hint}</p>}
      {error && <p className="whitespace-pre-wrap text-md text-danger">{error.message}</p>}
      {save && <div className="flex items-center gap-2">
        <YButton variant="primary" onClick={onSave} disabled={saving.isPending || !dirty}>
          {saving.isPending ? 'Saving…' : 'Save'}
        </YButton>
        {saving.isSuccess && !dirty && <span className="text-md text-success">Saved</span>}
      </div>}
    </>
  )

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <CodeEditor value={text} onChange={onEdit} language={language} fontSize={fontSize} readOnly={!save} />
        <YButton
          size="sm"
          icon={ExpandIcon}
          onClick={() => setExpanded(true)}
          title="Expand editor"
          aria-label="Expand editor"
          className="absolute right-1.5 top-1.5"
        />
      </div>
      {footer}

      <YDialog
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
          readOnly={!save}
          height="100%"
          className="min-h-0 flex-1"
        />
        {footer}
      </YDialog>
    </div>
  )
}
