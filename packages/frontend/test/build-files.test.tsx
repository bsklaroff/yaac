import { useState, type JSX } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { screen, fireEvent, cleanup } from '@testing-library/react'

// CodeMirror doesn't run under jsdom; the file editor gets a textarea.
vi.mock('#components/CodeEditor', () => ({
  CodeEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="editor" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))

import { BuildFiles, type EditedFiles } from '#components/settings/BuildFiles'
import { renderWithClient } from './harness'

afterEach(cleanup)

/** BuildFiles over `initial`, holding each change as its caller would;
 *  `held()` reads the set as it stands. */
function renderFiles(initial: EditedFiles): { held: () => EditedFiles } {
  let latest = initial
  function Holder(): JSX.Element {
    const [files, setFiles] = useState(initial)
    latest = files
    return (
      <BuildFiles
        files={files}
        onChange={setFiles}
        upload={() => Promise.resolve({ sha256: 'h', size: 0 })}
        readText={() => Promise.resolve('stored')}
        title="node"
      />
    )
  }
  renderWithClient(<Holder />)
  return { held: () => latest }
}

const newFile = (path: string): void => {
  fireEvent.change(screen.getByPlaceholderText(/new file path/), { target: { value: path } })
  fireEvent.click(screen.getByRole('button', { name: 'New file' }))
}

describe('BuildFiles', () => {
  it('creates, renames and deletes files, refusing a path that is taken', () => {
    const prompt = vi.spyOn(window, 'prompt')
    try {
      const { held } = renderFiles({ 'a.txt': { sha256: 'h-a', size: 1 }, 'nvim/init.lua': { text: 'x' } })

      newFile('a.txt')
      expect(screen.getByText('a.txt already exists')).toBeTruthy()
      newFile('nvim')
      expect(screen.getByText('nvim clashes with nvim/init.lua')).toBeTruthy()
      expect(Object.keys(held())).toEqual(['a.txt', 'nvim/init.lua'])

      // A new file opens empty in the editor, and what is typed is held.
      newFile('b.txt')
      expect(screen.queryByText(/clashes with/)).toBeNull()
      fireEvent.change(screen.getByLabelText('editor'), { target: { value: 'hi' } })
      expect(held()['b.txt']).toEqual({ text: 'hi' })

      prompt.mockReturnValue('a.txt')
      fireEvent.click(screen.getByRole('button', { name: 'Rename b.txt' }))
      expect(prompt).toHaveBeenCalledWith('Rename b.txt to:', 'b.txt')
      expect(screen.getByText('a.txt already exists')).toBeTruthy()
      expect(held()['b.txt']).toEqual({ text: 'hi' })

      // The open file follows its rename.
      prompt.mockReturnValue('c/b.txt')
      fireEvent.click(screen.getByRole('button', { name: 'Rename b.txt' }))
      expect(held()).toEqual({ 'a.txt': { sha256: 'h-a', size: 1 }, 'c/b.txt': { text: 'hi' }, 'nvim/init.lua': { text: 'x' } })
      expect(screen.getByLabelText<HTMLTextAreaElement>('editor').value).toBe('hi')

      fireEvent.click(screen.getByRole('button', { name: 'Delete c/b.txt' }))
      expect(screen.queryByLabelText('editor')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Delete a.txt' }))
      expect(held()).toEqual({ 'nvim/init.lua': { text: 'x' } })
      expect(screen.getAllByTitle(/^Open /).map((b) => b.textContent)).toEqual(['nvim/init.lua'])
    } finally {
      prompt.mockRestore()
    }
  })
})
