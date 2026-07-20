import { type JSX } from 'react'
import clsx from 'clsx'
import CodeMirror from '@uiw/react-codemirror'
import { json } from '@codemirror/lang-json'
import { StreamLanguage } from '@codemirror/language'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'

export type CodeLanguage = 'json' | 'dockerfile' | 'text'

/**
 * Thin controlled CodeMirror wrapper. Keeps the editor library referenced
 * in one place (mirrors lib/icons.ts). Dark theme + a bordered frame so it
 * sits on the app's dark surfaces. To fill a sized container, pass
 * `height="100%"` and size the frame via `className` (e.g. `flex-1 min-h-0`).
 */
export function CodeEditor({
  value,
  onChange,
  language,
  height = '220px',
  className,
}: {
  value: string
  onChange: (value: string) => void
  language: CodeLanguage
  height?: string
  className?: string
}): JSX.Element {
  return (
    <div className={clsx('overflow-hidden rounded-md border border-border focus-within:border-border-strong', className)}>
      <CodeMirror
        value={value}
        onChange={onChange}
        theme="dark"
        height={height}
        className="h-full"
        extensions={
          language === 'json'
            ? [json()]
            : language === 'dockerfile'
              ? [StreamLanguage.define(dockerFile)]
              : [] // 'text': no highlighting
        }
        basicSetup={{ foldGutter: false, highlightActiveLine: false }}
      />
    </div>
  )
}
