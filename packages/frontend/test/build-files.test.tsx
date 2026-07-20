// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { BuildFiles } from '#components/settings/BuildFiles'
import type { BuildFileEntry, BuildFilesApi } from '#lib/buildFilesApi'

// Same stub as file-editor.test.tsx: CodeMirror doesn't run under jsdom.
vi.mock('#components/ui/CodeEditor', () => ({
  CodeEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="editor" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))

// jsdom has no ResizeObserver; Base UI's dialog (FileEditor's expand) needs one.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

afterEach(cleanup)

/** In-memory BuildFilesApi over a Map, mirroring the server's semantics. */
function fakeApi(initial: Record<string, string | Uint8Array> = {}): BuildFilesApi & { store: Map<string, string | Uint8Array> } {
  const store = new Map<string, string | Uint8Array>(Object.entries(initial))
  const entry = (path: string): BuildFileEntry => {
    const data = store.get(path)!
    return typeof data === 'string'
      ? { path, size: data.length, binary: false }
      : { path, size: data.length, binary: true }
  }
  return {
    store,
    list: () => Promise.resolve([...store.keys()].sort().map(entry)),
    read: (path) => {
      const data = store.get(path)
      if (data === undefined) return Promise.reject(new Error(`no build file at ${path}`))
      return Promise.resolve({ ...entry(path), content: typeof data === 'string' ? data : null })
    },
    saveText: (path, content) => {
      store.set(path, content)
      return Promise.resolve(entry(path))
    },
    upload: (path, data) => {
      store.set(path, new Uint8Array(data))
      return Promise.resolve(entry(path))
    },
    rename: (from, to) => {
      if (store.has(to)) return Promise.reject(new Error(`path already exists: ${to}`))
      for (const key of [...store.keys()]) {
        if (key === from || key.startsWith(`${from}/`)) {
          store.set(`${to}${key.slice(from.length)}`, store.get(key)!)
          store.delete(key)
        }
      }
      return Promise.resolve(entry(to))
    },
    remove: (path) => {
      for (const key of [...store.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) store.delete(key)
      }
      return Promise.resolve()
    },
  }
}

describe('BuildFiles', () => {
  it('lists files with sizes and flags binary ones', async () => {
    const filesApi = fakeApi({ 'nvim/init.lua': 'print(1)\n', 'blob.bin': new Uint8Array(2048) })
    render(<BuildFiles filesApi={filesApi} title="demo" />)

    await screen.findByText('nvim/init.lua')
    screen.getByText('blob.bin')
    screen.getByText(/binary · 2\.0 KB/)
    // Binary rows can't open the editor.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'blob.bin' }).disabled).toBe(true)
  })

  it('opens a file in the editor and saves edits back', async () => {
    const filesApi = fakeApi({ 'init.lua': 'print(1)\n' })
    render(<BuildFiles filesApi={filesApi} title="demo" />)

    fireEvent.click(await screen.findByRole('button', { name: 'init.lua' }))
    const editor = await screen.findByLabelText<HTMLTextAreaElement>('editor')
    expect(editor.value).toBe('print(1)\n')

    fireEvent.change(editor, { target: { value: 'print(2)\n' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(filesApi.store.get('init.lua')).toBe('print(2)\n'))
  })

  it('creates a new file and opens it', async () => {
    const filesApi = fakeApi()
    render(<BuildFiles filesApi={filesApi} title="demo" />)

    await screen.findByText('No files yet.')
    fireEvent.change(screen.getByPlaceholderText(/new file path/i), {
      target: { value: 'nvim/init.lua' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'New file' }))

    await screen.findByLabelText('editor')
    expect(filesApi.store.get('nvim/init.lua')).toBe('')
    screen.getByRole('button', { name: 'nvim/init.lua' })
  })

  it('uploads picked files with their relative paths', async () => {
    const filesApi = fakeApi()
    render(<BuildFiles filesApi={filesApi} title="demo" />)
    await screen.findByText('No files yet.')

    const file = new File([new Uint8Array([1, 2, 3])], 'theme.bin')
    fireEvent.change(screen.getByLabelText('Upload files'), { target: { files: [file] } })

    await screen.findByText('theme.bin')
    expect(filesApi.store.get('theme.bin')).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('deletes a file after confirmation', async () => {
    const filesApi = fakeApi({ 'a.txt': 'x' })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    try {
      render(<BuildFiles filesApi={filesApi} title="demo" />)
      fireEvent.click(await screen.findByRole('button', { name: 'Delete a.txt' }))
      await screen.findByText('No files yet.')
      expect(filesApi.store.size).toBe(0)
      expect(confirmSpy).toHaveBeenCalledWith('Delete a.txt?')
    } finally {
      confirmSpy.mockRestore()
    }
  })

  it('renames a file via the prompt', async () => {
    const filesApi = fakeApi({ 'a.txt': 'x' })
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('nvim/b.txt')
    try {
      render(<BuildFiles filesApi={filesApi} title="demo" />)
      fireEvent.click(await screen.findByRole('button', { name: 'Rename a.txt' }))
      await screen.findByText('nvim/b.txt')
      expect(promptSpy).toHaveBeenCalledWith('Rename a.txt to:', 'a.txt')
      expect(filesApi.store.has('a.txt')).toBe(false)
      expect(filesApi.store.get('nvim/b.txt')).toBe('x')
    } finally {
      promptSpy.mockRestore()
    }
  })

  it('surfaces API errors inline', async () => {
    const filesApi = fakeApi()
    filesApi.list = () => Promise.reject(new Error('server exploded'))
    render(<BuildFiles filesApi={filesApi} title="demo" />)
    await screen.findByText('server exploded')
  })
})
