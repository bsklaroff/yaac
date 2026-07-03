import { type JSX } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { json } from '@codemirror/lang-json'
import { StreamLanguage } from '@codemirror/language'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'

export type CodeLanguage = 'json' | 'dockerfile'

/**
 * Thin controlled CodeMirror wrapper. Keeps the editor library referenced
 * in one place (mirrors lib/icons.ts). Dark theme + a bordered frame so it
 * sits on the app's dark surfaces.
 */
export function CodeEditor({
  value,
  onChange,
  language,
  height = '220px',
}: {
  value: string
  onChange: (value: string) => void
  language: CodeLanguage
  height?: string
}): JSX.Element {
  return (
    <div className="overflow-hidden rounded-md border border-border focus-within:border-border-strong">
      <CodeMirror
        value={value}
        onChange={onChange}
        theme="dark"
        height={height}
        extensions={language === 'json' ? [json()] : [StreamLanguage.define(dockerFile)]}
        basicSetup={{ foldGutter: false, highlightActiveLine: false }}
      />
    </div>
  )
}
