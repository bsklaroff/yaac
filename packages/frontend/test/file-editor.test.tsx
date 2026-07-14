// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { FileEditor } from '#components/settings/FileEditor'

// Stub the CodeMirror wrapper with a plain textarea — CodeMirror's
// contenteditable doesn't work under jsdom, and this suite only exercises
// FileEditor's load/save/dirty lifecycle, not the editor internals.
vi.mock('#components/ui/CodeEditor', () => ({
  CodeEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="editor" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))

// jsdom has no ResizeObserver; Base UI's dialog needs one to exist.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

afterEach(cleanup)

function saveButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: /save/i })
}

describe('FileEditor', () => {
  it('loads the initial content and keeps Save disabled until edited', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    render(<FileEditor title="a.json" language="json" load={() => Promise.resolve('hello')} save={save} />)

    const editor = await screen.findByLabelText<HTMLTextAreaElement>('editor')
    expect(editor.value).toBe('hello')
    expect(saveButton().disabled).toBe(true)

    fireEvent.change(editor, { target: { value: 'world' } })
    expect(saveButton().disabled).toBe(false)
  })

  it('saves the edited content and shows a Saved indicator', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    render(<FileEditor title="Dockerfile" language="dockerfile" load={() => Promise.resolve('FROM a')} save={save} />)

    const editor = await screen.findByLabelText<HTMLTextAreaElement>('editor')
    fireEvent.change(editor, { target: { value: 'FROM b' } })
    fireEvent.click(saveButton())

    await waitFor(() => expect(save).toHaveBeenCalledWith('FROM b'))
    await screen.findByText('Saved')
    expect(saveButton().disabled).toBe(true)
  })

  it('surfaces a save error and leaves the editor dirty', async () => {
    const save = vi.fn().mockRejectedValue(new Error('boom'))
    render(<FileEditor title="a.json" language="json" load={() => Promise.resolve('{}')} save={save} />)

    const editor = await screen.findByLabelText<HTMLTextAreaElement>('editor')
    fireEvent.change(editor, { target: { value: '{ bad' } })
    fireEvent.click(saveButton())

    await screen.findByText('boom')
    expect(saveButton().disabled).toBe(false)

    // Editing again clears the stale error.
    fireEvent.change(editor, { target: { value: '{ still editing' } })
    expect(screen.queryByText('boom')).toBeNull()
  })

  it('shows the load error when loading fails', async () => {
    const save = vi.fn()
    render(<FileEditor title="a.json" language="json" load={() => Promise.reject(new Error('nope'))} save={save} />)
    await screen.findByText('nope')
  })

  it('expands into a titled overlay and saves from there', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    render(<FileEditor title="proj · yaac-config.json" language="json" load={() => Promise.resolve('{}')} save={save} />)

    await screen.findByLabelText('editor')
    fireEvent.click(screen.getByRole('button', { name: 'Expand editor' }))
    await screen.findByText('proj · yaac-config.json')

    // The overlay hosts a second editor over the same buffer; edit and save there.
    const editors = screen.getAllByLabelText<HTMLTextAreaElement>('editor')
    expect(editors.length).toBe(2)
    const expandedEditor = editors[editors.length - 1]
    expect(expandedEditor.value).toBe('{}')
    fireEvent.change(expandedEditor, { target: { value: '{"a":1}' } })

    const saveButtons = screen.getAllByRole<HTMLButtonElement>('button', { name: /save/i })
    fireEvent.click(saveButtons[saveButtons.length - 1])
    await waitFor(() => expect(save).toHaveBeenCalledWith('{"a":1}'))
  })

  it('keeps unsaved edits when collapsing the overlay', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    render(<FileEditor title="Dockerfile.user" language="dockerfile" load={() => Promise.resolve('FROM a')} save={save} />)

    await screen.findByLabelText('editor')
    fireEvent.click(screen.getByRole('button', { name: 'Expand editor' }))

    const editors = screen.getAllByLabelText<HTMLTextAreaElement>('editor')
    fireEvent.change(editors[editors.length - 1], { target: { value: 'FROM b' } })
    fireEvent.click(screen.getByRole('button', { name: 'Collapse editor' }))

    // Back to the inline editor only, with the edit and dirty state intact.
    await waitFor(() => expect(screen.getAllByLabelText('editor').length).toBe(1))
    expect(screen.getByLabelText<HTMLTextAreaElement>('editor').value).toBe('FROM b')
    expect(saveButton().disabled).toBe(false)
  })
})
