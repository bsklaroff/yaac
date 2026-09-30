import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import clsx from 'clsx'
import CodeMirror, { EditorView, ExternalChange, type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { syntaxHighlighting } from '@codemirror/language'
import { classHighlighter } from '@lezer/highlight'
import { editorLanguage, type HighlightLanguage } from '#lib/highlight'
import { findPanel } from '#components/ui/FindPanel'

/**
 * Editor theme from the palette's CSS variables. Tokens use the diff view's
 * `tok-*` classes (index.css) so editors and diffs match.
 */
const editorTheme = [
  EditorView.theme({
    '&': { color: 'var(--color-text)', backgroundColor: 'var(--color-bg)' },
    '.cm-content': { caretColor: 'var(--color-text)' },
    '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-text)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'var(--color-surface-3)',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--color-bg)', color: 'var(--color-text-faint)', border: 'none',
    },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--color-hairline-soft)' },
    '.cm-selectionMatch': { backgroundColor: 'var(--color-surface-2)' },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: 'var(--color-surface-3)', outline: 'none',
    },
    '.cm-panels': { backgroundColor: 'var(--color-surface)', color: 'var(--color-text)' },
    '.cm-panels-top': { borderBottom: '1px solid var(--color-hairline)' },
    '.cm-searchMatch': { backgroundColor: 'rgb(210 153 34 / 0.3)' },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'rgb(210 153 34 / 0.55)', outline: '1px solid rgb(210 153 34)',
    },
  }),
  syntaxHighlighting(classHighlighter),
  EditorView.lineWrapping,
  findPanel,
]

/** The single edit that turns `from` into `to`, leaving their common prefix
 *  and suffix alone so a cursor outside the edit stays put. */
function minimalChange(from: string, to: string): { from: number; to: number; insert: string } {
  let start = 0
  const max = Math.min(from.length, to.length)
  while (start < max && from[start] === to[start]) start++
  let end = 0
  while (end < max - start && from[from.length - 1 - end] === to[to.length - 1 - end]) end++
  return { from: start, to: from.length - end, insert: to.slice(start, to.length - end) }
}

/**
 * Controlled CodeMirror wrapper. To fill a sized container, pass
 * `height="100%"` and size the frame via `className` (e.g. `flex-1 min-h-0`).
 *
 * An outside change to `value` (e.g. a reload from disk) is applied as one
 * minimal edit, so the cursor and scroll position survive.
 */
export function CodeEditor({
  value,
  onChange,
  language,
  height = '220px',
  className,
  bare = false,
  fontSize,
  onCreateEditor,
}: {
  value: string
  onChange: (value: string) => void
  /** Null: plain text. */
  language: HighlightLanguage | null
  height?: string
  className?: string
  /** No frame — for an editor that fills a pane of its own. */
  bare?: boolean
  /** Text size in px; unset inherits the page's. */
  fontSize?: number
  onCreateEditor?: (view: EditorView) => void
}): JSX.Element {
  const ref = useRef<ReactCodeMirrorRef>(null)
  const [initial] = useState(value)
  const extensions = useMemo(() => [
    ...(language ? [editorLanguage(language)] : []),
    ...(fontSize ? [EditorView.theme({ '&': { fontSize: `${fontSize}px` } })] : []),
  ], [language, fontSize])
  useEffect(() => {
    const view = ref.current?.view
    if (!view) return
    const doc = view.state.doc.toString()
    if (doc === value) return
    view.dispatch({ changes: minimalChange(doc, value), annotations: ExternalChange.of(true) })
  }, [value])
  return (
    <div className={clsx(
      'overflow-hidden',
      !bare && 'rounded-md border border-border focus-within:border-border-strong',
      className,
    )}>
      <CodeMirror
        ref={ref}
        value={initial}
        onChange={onChange}
        theme={editorTheme}
        height={height}
        className="h-full"
        extensions={extensions}
        onCreateEditor={onCreateEditor}
        basicSetup={{ foldGutter: false, highlightActiveLine: false }}
      />
    </div>
  )
}
