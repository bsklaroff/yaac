// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { BuildFiles } from '#components/settings/BuildFiles'
import { projectBuildFilesApi, type BuildFileEntry } from '#lib/buildFilesApi'
import { mockFetch, renderWithClient, serverError, type FetchCall } from './harness'

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

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const ROUTE = '/api/project/demo/build-files'

/** The build-files routes over an in-memory Map, mirroring the server's
 *  semantics; a path's value is its text, or its bytes when uploaded. */
function fakeServer(initial: Record<string, string | Uint8Array> = {}): { store: Map<string, string | Uint8Array> } {
  const store = new Map<string, string | Uint8Array>(Object.entries(initial))
  const entry = (path: string): BuildFileEntry => {
    const data = store.get(path)!
    return { path, size: data.length, binary: typeof data !== 'string' }
  }
  mockFetch({
    [`GET ${ROUTE}`]: () => ({ files: [...store.keys()].sort().map(entry) }),
    [`GET ${ROUTE}/file`]: ({ query }: FetchCall) => {
      const path = query.get('path')!
      const data = store.get(path)
      if (data === undefined) return serverError('NOT_FOUND', `no build file at ${path}`, 404)
      return { ...entry(path), content: typeof data === 'string' ? data : null }
    },
    [`PUT ${ROUTE}/file`]: ({ body }: FetchCall) => {
      const { path, content, contentBase64 } = body as { path: string; content?: string; contentBase64?: string }
      store.set(path, content ?? Uint8Array.from(atob(contentBase64!), (c) => c.charCodeAt(0)))
      return entry(path)
    },
    [`POST ${ROUTE}/rename`]: ({ body }: FetchCall) => {
      const { from, to } = body as { from: string; to: string }
      if (store.has(to)) return serverError('CONFLICT', `path already exists: ${to}`, 409)
      for (const key of [...store.keys()]) {
        if (key === from || key.startsWith(`${from}/`)) {
          store.set(`${to}${key.slice(from.length)}`, store.get(key)!)
          store.delete(key)
        }
      }
      return entry(to)
    },
    [`DELETE ${ROUTE}/file`]: ({ query }: FetchCall) => {
      const path = query.get('path')!
      for (const key of [...store.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) store.delete(key)
      }
      return undefined
    },
  })
  return { store }
}

function renderFiles(): void {
  renderWithClient(<BuildFiles filesApi={projectBuildFilesApi('demo')} title="demo" />)
}

describe('BuildFiles', () => {
  it('lists files with sizes and flags binary ones', async () => {
    fakeServer({ 'nvim/init.lua': 'print(1)\n', 'blob.bin': new Uint8Array(2048) })
    renderFiles()

    await screen.findByText('nvim/init.lua')
    screen.getByText('blob.bin')
    screen.getByText(/binary · 2\.0 KB/)
    // Binary rows can't open the editor.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'blob.bin' }).disabled).toBe(true)
  })

  it('opens a file in the editor and saves edits back', async () => {
    const { store } = fakeServer({ 'init.lua': 'print(1)\n' })
    renderFiles()

    fireEvent.click(await screen.findByRole('button', { name: 'init.lua' }))
    const editor = await screen.findByLabelText<HTMLTextAreaElement>('editor')
    expect(editor.value).toBe('print(1)\n')

    fireEvent.change(editor, { target: { value: 'print(2)\n' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(store.get('init.lua')).toBe('print(2)\n'))
  })

  it('creates a new file and opens it', async () => {
    const { store } = fakeServer()
    renderFiles()

    await screen.findByText('No files yet.')
    fireEvent.change(screen.getByPlaceholderText(/new file path/i), {
      target: { value: 'nvim/init.lua' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'New file' }))

    await screen.findByLabelText('editor')
    expect(store.get('nvim/init.lua')).toBe('')
    screen.getByRole('button', { name: 'nvim/init.lua' })
  })

  it('uploads picked files with their relative paths', async () => {
    const { store } = fakeServer()
    renderFiles()
    await screen.findByText('No files yet.')

    const file = new File([new Uint8Array([1, 2, 3])], 'theme.bin')
    fireEvent.change(screen.getByLabelText('Upload files'), { target: { files: [file] } })

    await screen.findByText('theme.bin')
    expect(store.get('theme.bin')).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('deletes a file after confirmation', async () => {
    const { store } = fakeServer({ 'a.txt': 'x' })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    try {
      renderFiles()
      fireEvent.click(await screen.findByRole('button', { name: 'Delete a.txt' }))
      await screen.findByText('No files yet.')
      expect(store.size).toBe(0)
      expect(confirmSpy).toHaveBeenCalledWith('Delete a.txt?')
    } finally {
      confirmSpy.mockRestore()
    }
  })

  it('renames a file via the prompt', async () => {
    const { store } = fakeServer({ 'a.txt': 'x' })
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('nvim/b.txt')
    try {
      renderFiles()
      fireEvent.click(await screen.findByRole('button', { name: 'Rename a.txt' }))
      await screen.findByText('nvim/b.txt')
      expect(promptSpy).toHaveBeenCalledWith('Rename a.txt to:', 'a.txt')
      expect(store.has('a.txt')).toBe(false)
      expect(store.get('nvim/b.txt')).toBe('x')
    } finally {
      promptSpy.mockRestore()
    }
  })

  it('surfaces API errors inline', async () => {
    mockFetch({ [`GET ${ROUTE}`]: serverError('INTERNAL', 'server exploded') })
    renderFiles()
    await screen.findByText('server exploded')
  })
})
