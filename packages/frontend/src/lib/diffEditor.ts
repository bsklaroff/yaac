/**
 * The file editor's diff modes (`FileDiffMode`), built on @codemirror/merge's
 * unified view: the document stays the editable working copy, changed lines
 * are tinted against `original` (the file at the diff base), and removed
 * lines are read-only widgets between them. The `added` mode hides those
 * widgets with CSS; the `changes` mode folds unchanged stretches away.
 */
import { ChangeSet, type Extension } from '@codemirror/state'
import { EditorView } from '@uiw/react-codemirror'
import { getOriginalDoc, unifiedMergeView, updateOriginalDoc } from '@codemirror/merge'
import type { FileDiffMode } from '#lib/store'

/** The palette's diff tints, matching `DiffView`. */
const diffTheme = EditorView.theme({
  '.cm-changedLine, .cm-inlineChangedLine': { backgroundColor: 'rgb(63 185 80 / 0.14)' },
  '.cm-changedText': { background: 'rgb(63 185 80 / 0.3)' },
  '.cm-deletedChunk': { backgroundColor: 'rgb(248 81 73 / 0.14)', paddingLeft: '0' },
  '.cm-deletedChunk .cm-deletedText': { background: 'rgb(248 81 73 / 0.3)' },
  '.cm-changedLineGutter': { background: 'var(--color-success)' },
  '.cm-deletedLineGutter': { background: 'var(--color-error)' },
  '.cm-collapsedLines': {
    color: 'var(--color-text-faint)',
    background: 'var(--color-surface-2)',
    fontSize: '11px',
  },
  '&.cm-hide-deletions .cm-deletedChunk': { display: 'none' },
})

/** The extensions for one mode; none for `plain`. */
export function diffExtensions(mode: FileDiffMode, original: string): Extension[] {
  if (mode === 'plain') return []
  return [
    unifiedMergeView({
      original,
      mergeControls: false,
      highlightChanges: mode !== 'added',
      syntaxHighlightDeletions: true,
      ...(mode === 'changes' ? { collapseUnchanged: { margin: 3, minSize: 4 } } : {}),
    }),
    diffTheme,
    ...(mode === 'added' ? [EditorView.editorAttributes.of({ class: 'cm-hide-deletions' })] : []),
  ]
}

/**
 * Point a diff-mode editor at a new original. Reconfiguring keeps the merge
 * view's state from the first configuration, so a changed original has to
 * arrive as this effect instead.
 */
export function setOriginal(view: EditorView, original: string): void {
  const current = getOriginalDoc(view.state)
  if (current.toString() === original) return
  view.dispatch({
    effects: updateOriginalDoc.of({
      doc: view.state.toText(original),
      changes: ChangeSet.of([{ from: 0, to: current.length, insert: original }], current.length),
    }),
  })
}
