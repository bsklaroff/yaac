// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import type { WorkspaceChanges, WorkspaceFiles as WorkspaceFilesData } from '@yaac/shared/types'
import { WorkspaceFiles } from '#components/WorkspaceFiles'
import { FILES_TARGET } from '#lib/files'
import { paneViewKey, useUiStore } from '#lib/store'
import { mockFetch, renderWithClient, serverError, type FetchCall, type FetchMock } from './harness'

/**
 * Uploading into the explorer: files picked from its header, and folders
 * dropped on a row, each file streamed to the upload route under the folder
 * it landed in, with files already there offered for replacing.
 */

const UPLOAD = 'PUT /api/workspace/s1/upload'
const FOLDER = 'POST /api/workspace/s1/folder'

const LISTING: WorkspaceFilesData = {
  version: 'v1',
  root: '/workspace',
  paths: ['README.md', 'src/app.ts'],
  symlinks: {},
  ignored: [],
  emptyDirs: [],
  conflicted: [],
  truncated: false,
}

const CHANGES: WorkspaceChanges = {
  base: 'abc', work: 'w', baseResolved: true, branch: 'main', comparison: null, files: [], truncated: false, listing: LISTING, readMs: 0,
}

let server: FetchMock
/** Where each upload went, and whether it replaced. */
const uploads = (): string[] => server.called(UPLOAD).map((c) => {
  const replace = c.query.get('replace') === '1' ? ' (replace)' : ''
  return `${c.query.get('path')}${replace}`
})

beforeAll(() => {
  // jsdom has no ResizeObserver; Base UI's dialog needs one.
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

beforeEach(() => {
  server = mockFetch({
    'GET /api/workspace/s1/changes': CHANGES,
    [UPLOAD]: ({ query }: FetchCall) => {
      const path = query.get('path')
      if (path === 'README.md' && query.get('replace') !== '1') return serverError('CONFLICT', 'README.md already exists', 409)
      if (path === 'src/kit/bad.bin') return serverError('VALIDATION', 'permission denied: src/kit/bad.bin', 400)
      return { path }
    },
    [FOLDER]: ({ body }: FetchCall) => body,
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useUiStore.setState({ paneView: {}, layouts: {}, activeTabs: {} })
})

/** A dropped file or folder, as `webkitGetAsEntry` hands it over. */
function fileEntry(name: string): FileSystemFileEntry {
  return { isFile: true, isDirectory: false, name, file: (ok: (f: File) => void) => ok(new File(['x'], name)) } as unknown as FileSystemFileEntry
}
/** An entry the browser cannot read, as a broken link inside a folder is. */
function brokenEntry(name: string): FileSystemFileEntry {
  return {
    isFile: true, isDirectory: false, name,
    file: (_ok: unknown, fail: (e: Error) => void) => fail(new Error('A requested file or directory could not be found')),
  } as unknown as FileSystemFileEntry
}
function dirEntry(name: string, children: FileSystemEntry[]): FileSystemDirectoryEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    // Read in batches, ending with an empty one.
    createReader: () => {
      const batches = children.length ? [children.slice(0, 1), children.slice(1), []] : [[]]
      return { readEntries: (ok: (e: FileSystemEntry[]) => void) => ok(batches.shift() ?? []) }
    },
  } as unknown as FileSystemDirectoryEntry
}

describe('WorkspaceFiles uploads', () => {
  it('uploads picked files into the root, and replaces one already there once confirmed', async () => {
    renderWithClient(<WorkspaceFiles workspaceId="s1" projectId="proj" />)
    await screen.findByText('README.md')
    expect(screen.getByLabelText('Upload files')).toBeTruthy()
    const input = document.querySelector<HTMLInputElement>('input[type=file][multiple]')!
    fireEvent.change(input, { target: { files: [new File(['a'], 'notes.txt'), new File(['b'], 'README.md')] } })

    await screen.findByText('Replace “README.md”?')
    expect(uploads().sort()).toEqual(['README.md', 'notes.txt'])
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    await waitFor(() => expect(uploads()).toContain('README.md (replace)'))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('uploads a folder dropped on a row into that folder, keeping its empty folders and past unreadable entries', async () => {
    renderWithClient(<WorkspaceFiles workspaceId="s1" projectId="proj" />)
    const src = await screen.findByText('src')
    const kit = dirEntry('kit', [fileEntry('a.txt'), dirEntry('empty', []), dirEntry('deep', [fileEntry('b.txt')]), fileEntry('bad.bin'), brokenEntry('dangling')])
    const dataTransfer = {
      types: ['Files'],
      items: [{ kind: 'file', webkitGetAsEntry: () => kit }],
      files: [],
      dropEffect: 'none',
    }
    fireEvent.dragOver(src, { dataTransfer })
    expect(src.closest('[data-drop-folder]')!.className).toContain('bg-accent/15')
    fireEvent.drop(src, { dataTransfer })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/^Couldn’t upload 2 files\. /)
    expect(uploads().sort()).toEqual(['src/kit/a.txt', 'src/kit/bad.bin', 'src/kit/deep/b.txt'])
    expect(server.called(FOLDER).map((c) => c.body)).toEqual([{ path: 'src/kit/empty' }])
    expect(src.closest('[data-drop-folder]')!.className).not.toContain('bg-accent/15')
    // The folder it landed in opens, so the upload shows.
    expect(useUiStore.getState().paneView[paneViewKey('s1', FILES_TARGET)]?.expanded).toEqual(['src'])
  })
})
