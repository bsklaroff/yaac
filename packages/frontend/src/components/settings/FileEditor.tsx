import { useState, type JSX, type ReactNode } from 'react'
import { CodeEditor } from '#components/CodeEditor'
import type { HighlightLanguage } from '#lib/highlight'
import { CollapseIcon, ExpandIcon } from '#lib/icons'
import { useUiStore } from '#lib/store'
import { YButton, YDialog } from '#ui'

/**
 * A syntax-highlighted editor for one file whose text the caller holds;
 * without `onChange` it is a read-only viewer.
 *
 * An expand button opens the same text in a near-fullscreen dialog titled
 * `title`, with `footer` under it there too. Text size follows the file
 * pane's text-size setting.
 */
export function FileEditor({ title, language, value, onChange, footer }: {
  title: string
  language: HighlightLanguage | null
  value: string
  onChange?: (text: string) => void
  footer?: ReactNode
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const fontSize = useUiStore((s) => s.editorFontSize)
  const edit = onChange ?? (() => {})

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <CodeEditor value={value} onChange={edit} language={language} fontSize={fontSize} readOnly={!onChange} />
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
          value={value}
          onChange={edit}
          language={language}
          fontSize={fontSize}
          readOnly={!onChange}
          height="100%"
          className="min-h-0 flex-1"
        />
        {footer}
      </YDialog>
    </div>
  )
}
