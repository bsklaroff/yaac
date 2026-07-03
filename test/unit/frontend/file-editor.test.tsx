// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { FileEditor } from '@/frontend/components/settings/FileEditor'

// Stub the CodeMirror wrapper with a plain textarea — CodeMirror's
// contenteditable doesn't work under jsdom, and this suite only exercises
// FileEditor's load/save/dirty lifecycle, not the editor internals.
vi.mock('@/frontend/components/ui/CodeEditor', () => ({
  CodeEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="editor" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))

afterEach(cleanup)

function saveButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: /save/i })
}

describe('FileEditor', () => {
  it('loads the initial content and keeps Save disabled until edited', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    render(<FileEditor language="json" load={() => Promise.resolve('hello')} save={save} />)

    const editor = await screen.findByLabelText<HTMLTextAreaElement>('editor')
    expect(editor.value).toBe('hello')
    expect(saveButton().disabled).toBe(true)

    fireEvent.change(editor, { target: { value: 'world' } })
    expect(saveButton().disabled).toBe(false)
  })

  it('saves the edited content and shows a Saved indicator', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    render(<FileEditor language="dockerfile" load={() => Promise.resolve('FROM a')} save={save} />)

    const editor = await screen.findByLabelText<HTMLTextAreaElement>('editor')
    fireEvent.change(editor, { target: { value: 'FROM b' } })
    fireEvent.click(saveButton())

    await waitFor(() => expect(save).toHaveBeenCalledWith('FROM b'))
    await screen.findByText('Saved')
    expect(saveButton().disabled).toBe(true)
  })

  it('surfaces a save error and leaves the editor dirty', async () => {
    const save = vi.fn().mockRejectedValue(new Error('boom'))
    render(<FileEditor language="json" load={() => Promise.resolve('{}')} save={save} />)

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
    render(<FileEditor language="json" load={() => Promise.reject(new Error('nope'))} save={save} />)
    await screen.findByText('nope')
  })
})
