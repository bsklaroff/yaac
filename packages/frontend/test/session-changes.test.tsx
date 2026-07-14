// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionChanges as SessionChangesData } from '@yaac/shared/types'

vi.mock('#lib/changesApi', () => ({ getSessionChanges: vi.fn() }))
import { getSessionChanges } from '#lib/changesApi'
import { SessionChanges } from '#components/SessionChanges'
import { useUiStore } from '#store'

const mock = vi.mocked(getSessionChanges)

const PAYLOAD: SessionChangesData = {
  base: 'abc123',
  files: [
    { path: 'src/app.ts', status: 'modified', additions: 2, deletions: 1, binary: false },
    { path: 'new.ts', status: 'added', additions: 2, deletions: 0, binary: false },
  ],
  diff: [
    'diff --git a/src/app.ts b/src/app.ts',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1,2 +1,3 @@',
    ' keep',
    '-old',
    '+new1',
    '+new2',
    'diff --git a/new.ts b/new.ts',
    '--- /dev/null',
    '+++ b/new.ts',
    '@@ -0,0 +1,2 @@',
    '+alpha',
    '+beta',
  ].join('\n'),
  truncated: false,
}

function renderPane(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <SessionChanges sessionId="s1" />
    </QueryClientProvider>,
  )
}

// jsdom has no layout engine, so scrollTop is inert there. Back it with a real
// per-element value so the pane's scroll save + restore can be exercised.
const realScrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop')
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: { _scrollTop?: number }): number { return this._scrollTop ?? 0 },
    set(this: { _scrollTop?: number }, v: number): void { this._scrollTop = v },
  })
})
afterAll(() => {
  if (realScrollTop) Object.defineProperty(HTMLElement.prototype, 'scrollTop', realScrollTop)
})

// The expanded-files set and scroll offset live in the shared store keyed by
// session id, so clear them between tests to keep them isolated.
afterEach(() => {
  cleanup()
  mock.mockReset()
  useUiStore.setState({ changesExpanded: {}, changesScroll: {} })
})

describe('SessionChanges', () => {
  it('lists changed files and auto-expands the first file’s diff', async () => {
    mock.mockResolvedValue(PAYLOAD)
    renderPane()
    await waitFor(() => expect(screen.getByText('2 files')).toBeTruthy())
    expect(screen.getByText('new1')).toBeTruthy() // first file expanded by default
    // The second file is collapsed until clicked.
    expect(screen.queryByText('alpha')).toBeNull()
  })

  it('expands a file’s diff inline when its row is clicked, and collapses it again', async () => {
    mock.mockResolvedValue(PAYLOAD)
    renderPane()
    await waitFor(() => expect(screen.getByTitle('new.ts')).toBeTruthy())
    fireEvent.click(screen.getByTitle('new.ts'))
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.getByText('new1')).toBeTruthy() // first file stays open (multiple can be)

    fireEvent.click(screen.getByTitle('src/app.ts'))
    expect(screen.queryByText('new1')).toBeNull() // collapsed
  })

  it('restores which files are expanded after the pane unmounts and remounts', async () => {
    mock.mockResolvedValue(PAYLOAD)
    renderPane()
    await waitFor(() => expect(screen.getByTitle('new.ts')).toBeTruthy())
    // Expand the second file (the first auto-opens), then collapse the first.
    fireEvent.click(screen.getByTitle('new.ts'))
    fireEvent.click(screen.getByTitle('src/app.ts'))
    expect(screen.getByText('alpha')).toBeTruthy() // new.ts open
    expect(screen.queryByText('new1')).toBeNull() // src/app.ts collapsed

    // Navigating away tears the pane down (a different tab/session). Remounting
    // must reproduce exactly the same accordion state, not re-auto-open.
    cleanup()
    renderPane()
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy())
    expect(screen.queryByText('new1')).toBeNull() // stayed collapsed, not re-opened
  })

  it('records the file list’s scroll offset as the user scrolls', async () => {
    mock.mockResolvedValue(PAYLOAD)
    const { container } = renderPane()
    await waitFor(() => expect(screen.getByText('2 files')).toBeTruthy())
    const list = container.querySelector('.overflow-y-auto')
    if (!list) throw new Error('scroll container not found')
    list.scrollTop = 140
    fireEvent.scroll(list)
    expect(useUiStore.getState().changesScroll.s1).toBe(140)
  })

  it('restores the saved scroll offset when the pane remounts', async () => {
    useUiStore.setState({ changesScroll: { s1: 220 } })
    mock.mockResolvedValue(PAYLOAD)
    const { container } = renderPane()
    await waitFor(() => expect(screen.getByText('2 files')).toBeTruthy())
    const list = container.querySelector('.overflow-y-auto')
    if (!list) throw new Error('scroll container not found')
    expect(list.scrollTop).toBe(220)
  })

  it('renders a renamed file as old → new with the old path in its title', async () => {
    mock.mockResolvedValue({
      base: 'abc',
      files: [
        { path: 'src/new-name.ts', status: 'renamed', additions: 0, deletions: 0, binary: false, oldPath: 'src/old-name.ts' },
      ],
      diff: '',
      truncated: false,
    })
    renderPane()
    // The row title spells out the full rename; both basenames render inline.
    await waitFor(() => expect(screen.getByTitle('src/old-name.ts → src/new-name.ts')).toBeTruthy())
    expect(screen.getByText('old-name.ts')).toBeTruthy()
    expect(screen.getByText('new-name.ts')).toBeTruthy()
  })

  it('syntax-highlights the diff for a recognized language', async () => {
    mock.mockResolvedValue({
      base: 'abc',
      files: [{ path: 'src/app.ts', status: 'added', additions: 1, deletions: 0, binary: false }],
      diff: [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- /dev/null',
        '+++ b/src/app.ts',
        '@@ -0,0 +1 @@',
        '+const answer = 42',
      ].join('\n'),
      truncated: false,
    })
    renderPane()
    expect((await screen.findByText('const')).className).toContain('tok-keyword')
    expect(screen.getByText('42').className).toContain('tok-number')
  })

  it('renders an unrecognized language as plain, un-tokenized text', async () => {
    mock.mockResolvedValue({
      base: 'abc',
      files: [{ path: 'notes.unknownext', status: 'added', additions: 1, deletions: 0, binary: false }],
      diff: [
        'diff --git a/notes.unknownext b/notes.unknownext',
        '--- /dev/null',
        '+++ b/notes.unknownext',
        '@@ -0,0 +1 @@',
        '+const answer = 42',
      ].join('\n'),
      truncated: false,
    })
    renderPane()
    const line = await screen.findByText('const answer = 42')
    expect(line.className).not.toContain('tok-')
  })

  it('shows an empty state when nothing changed', async () => {
    mock.mockResolvedValue({ base: 'abc', files: [], diff: '', truncated: false })
    renderPane()
    await waitFor(() => expect(screen.getByText('No changes yet')).toBeTruthy())
  })

  it('warns when the diff was truncated', async () => {
    mock.mockResolvedValue({ ...PAYLOAD, truncated: true })
    renderPane()
    await waitFor(() => expect(screen.getByText(/truncated/)).toBeTruthy())
  })
})
