// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import type { EditorView } from '@uiw/react-codemirror'
import { getSearchQuery, openSearchPanel } from '@codemirror/search'
import { CodeEditor } from '#components/ui/CodeEditor'
import { COUNT_DEBOUNCE_MS } from '#components/ui/FindPanel'
import { COUNT_TIMEOUT_MS, countMatches, type QuerySpec } from '#lib/matchCount'

/** A pattern the fake worker never finishes — a regex that backtracks forever. */
const HANGS = '(a|aa)+b'

/** jsdom has no Worker: this one counts with the real `countMatches`, a tick
 *  later, and never answers for HANGS. */
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  private terminated = false
  postMessage(msg: { id: number; doc: string; spec: QuerySpec }): void {
    if (msg.spec.search === HANGS) return
    setTimeout(() => {
      if (!this.terminated) this.onmessage?.({ data: { id: msg.id, matches: countMatches(msg.doc, msg.spec) } } as MessageEvent)
    }, 0)
  }
  terminate(): void { this.terminated = true }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal('Worker', FakeWorker)
  // CodeMirror measures ranges when it scrolls a match into view.
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => new DOMRect()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const settle = (ms = COUNT_DEBOUNCE_MS + 1): Promise<void> => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const status = (): string => screen.getByRole('status').textContent ?? ''
const find = (): HTMLInputElement => screen.getByRole<HTMLInputElement>('textbox', { name: 'Find' })

describe('FindPanel', () => {
  it('counts off the main thread across edits, and never hands a slow regex to the editor', async () => {
    const onChange = vi.fn()
    let view!: EditorView
    const doc = 'one needle\ntwo needle\nthree\n'
    const { rerender } = render(
      <CodeEditor value={doc} onChange={onChange} language={null} onCreateEditor={(v) => { view = v }} />,
    )
    act(() => { openSearchPanel(view) })
    expect(document.activeElement).toBe(find())

    // Typing counts and jumps to the first match from the cursor.
    fireEvent.change(find(), { target: { value: 'needle' } })
    await settle()
    expect(status()).toBe('1 of 2')
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('needle')

    // An edit in the editor recounts.
    act(() => { view.dispatch({ changes: { from: doc.length, insert: 'needle\n' } }) })
    await settle()
    expect(status()).toBe('1 of 3')

    // So does text replaced from outside (a reload from disk).
    rerender(<CodeEditor value={'needle\n'} onChange={onChange} language={null} />)
    await settle()
    expect(status()).toBe('1 result')

    // Replace all is an edit like any other: the owner hears of it.
    onChange.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Show replace' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Replace' }), { target: { value: 'pin' } })
    fireEvent.click(screen.getByRole('button', { name: 'Replace all' }))
    expect(onChange).toHaveBeenLastCalledWith('pin\n', expect.anything())
    await settle()
    expect(status()).toBe('No results')

    // A broken pattern says so.
    fireEvent.click(screen.getByRole('button', { name: 'Regular expression' }))
    fireEvent.change(find(), { target: { value: '(' } })
    await settle()
    expect(status()).toBe('Invalid pattern')

    // A regex that never finishes is killed, and stays out of the editor —
    // its highlighter and next/previous would run it on this thread.
    fireEvent.change(find(), { target: { value: HANGS } })
    await settle(COUNT_DEBOUNCE_MS + COUNT_TIMEOUT_MS)
    expect(status()).toBe('Too slow to count')
    expect(getSearchQuery(view.state).search).not.toBe(HANGS)

    // Escape closes the bar and goes no further: a dialog around the editor
    // dismisses on a document-level Escape.
    const outside = vi.fn()
    document.addEventListener('keydown', outside)
    fireEvent.keyDown(find(), { key: 'Escape', code: 'Escape', keyCode: 27 })
    document.removeEventListener('keydown', outside)
    expect(outside).not.toHaveBeenCalled()
    await settle(0)
    expect(screen.queryByRole('textbox', { name: 'Find' })).toBeNull()
  })
})
