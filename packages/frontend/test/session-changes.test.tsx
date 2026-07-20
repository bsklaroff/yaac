// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionChanges as SessionChangesData } from '@yaac/shared/types'
import type { ProjectBranches } from '#lib/projectApi'

vi.mock('#lib/changesApi', () => ({ getSessionChanges: vi.fn() }))
vi.mock('#lib/projectApi', () => ({
  getProjectBranches: vi.fn(),
  projectBranchesKey: (slug: string) => ['project-branches', slug],
}))
import { getSessionChanges } from '#lib/changesApi'
import { getProjectBranches } from '#lib/projectApi'
import { SessionChanges } from '#components/SessionChanges'
import { useUiStore } from '#store'

const mock = vi.mocked(getSessionChanges)

const BRANCHES: ProjectBranches = {
  branches: ['main', 'dev', 'feature/x'],
  defaultBranch: 'main',
  referenceBranch: null,
}

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

function renderPane({ baseBranch = 'main' }: { baseBranch?: string } = {}): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <SessionChanges sessionId="s1" projectSlug="proj" baseBranch={baseBranch} />
    </QueryClientProvider>,
  )
}

const BASE_TRIGGER = 'Choose the branch this diff is compared against'

// jsdom has no layout engine, so scrollTop is inert there. Back it with a real
// per-element value so the pane's scroll save + restore can be exercised.
const realScrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop')
beforeAll(() => {
  // jsdom has no ResizeObserver; Base UI's popover positioner needs one to exist.
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: { _scrollTop?: number }): number { return this._scrollTop ?? 0 },
    set(this: { _scrollTop?: number }, v: number): void { this._scrollTop = v },
  })
})
afterAll(() => {
  if (realScrollTop) Object.defineProperty(HTMLElement.prototype, 'scrollTop', realScrollTop)
})

beforeEach(() => {
  vi.mocked(getProjectBranches).mockResolvedValue(BRANCHES)
})

// The expanded-files set, scroll offset, and chosen base live in the shared
// store keyed by session id, so clear them between tests to keep them isolated.
afterEach(() => {
  cleanup()
  mock.mockReset()
  useUiStore.setState({
    changesExpanded: {}, changesScroll: {}, changesBase: {},
    changesFind: {}, changesFindPending: false,
  })
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

  it('shows the effective base branch in the header', async () => {
    mock.mockResolvedValue(PAYLOAD)
    renderPane({ baseBranch: 'main' })
    await waitFor(() => expect(screen.getByText('2 files')).toBeTruthy())
    expect(screen.getByTitle(BASE_TRIGGER).textContent).toContain('main')
  })

  it('lets the user pick a different base, which refetches against it', async () => {
    mock.mockResolvedValue(PAYLOAD)
    renderPane({ baseBranch: 'main' })
    await waitFor(() => expect(screen.getByText('2 files')).toBeTruthy())

    fireEvent.click(screen.getByTitle(BASE_TRIGGER))
    await waitFor(() => expect(screen.getByRole('list')).toBeTruthy())
    fireEvent.click(within(screen.getByRole('list')).getByText('dev'))

    expect(useUiStore.getState().changesBase.s1).toBe('dev')
    await waitFor(() => expect(mock).toHaveBeenCalledWith('s1', 'dev'))
  })

  it('clears the override when the session’s own base branch is picked', async () => {
    useUiStore.setState({ changesBase: { s1: 'dev' } })
    mock.mockResolvedValue(PAYLOAD)
    renderPane({ baseBranch: 'main' })
    await waitFor(() => expect(screen.getByText('2 files')).toBeTruthy())
    expect(mock).toHaveBeenCalledWith('s1', 'dev') // initial fetch used the override

    fireEvent.click(screen.getByTitle(BASE_TRIGGER))
    await waitFor(() => expect(screen.getByRole('list')).toBeTruthy())
    fireEvent.click(within(screen.getByRole('list')).getByText('main'))

    expect(useUiStore.getState().changesBase.s1).toBeUndefined()
    await waitFor(() => expect(mock).toHaveBeenCalledWith('s1', undefined))
  })

  it('filters the file list by a path substring, with a filtered count in the header', async () => {
    mock.mockResolvedValue(PAYLOAD)
    renderPane()
    await waitFor(() => expect(screen.getByText('2 files')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Find in changes'), { target: { value: 'new.ts' } })
    expect(screen.getByText('1 of 2 files')).toBeTruthy()
    expect(screen.getByTitle('new.ts')).toBeTruthy()
    expect(screen.queryByTitle('src/app.ts')).toBeNull()
  })

  it('filters by diff content, not just the path', async () => {
    mock.mockResolvedValue(PAYLOAD)
    renderPane()
    await waitFor(() => expect(screen.getByText('2 files')).toBeTruthy())
    // 'alpha' appears only inside new.ts's diff.
    fireEvent.change(screen.getByLabelText('Find in changes'), { target: { value: 'alpha' } })
    expect(screen.getByTitle('new.ts')).toBeTruthy()
    expect(screen.queryByTitle('src/app.ts')).toBeNull()
  })

  it('shows a no-match state, and Escape clears the query', async () => {
    mock.mockResolvedValue(PAYLOAD)
    renderPane()
    await waitFor(() => expect(screen.getByText('2 files')).toBeTruthy())
    const input = screen.getByLabelText('Find in changes')
    fireEvent.change(input, { target: { value: 'zzz-nothing' } })
    expect(screen.getByText('No files match “zzz-nothing”')).toBeTruthy()
    expect(screen.getByText('0 of 2 files')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(useUiStore.getState().changesFind.s1).toBeUndefined()
    expect(screen.getByText('2 files')).toBeTruthy()
  })

  it('keeps the query across a pane unmount/remount (store-backed)', async () => {
    mock.mockResolvedValue(PAYLOAD)
    renderPane()
    await waitFor(() => expect(screen.getByText('2 files')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Find in changes'), { target: { value: 'new.ts' } })
    cleanup()
    renderPane()
    await waitFor(() => expect(screen.getByText('1 of 2 files')).toBeTruthy())
    expect(screen.getByLabelText<HTMLInputElement>('Find in changes').value).toBe('new.ts')
  })

  it('consumes a pending find-focus request by focusing the find box', async () => {
    mock.mockResolvedValue(PAYLOAD)
    useUiStore.setState({ changesFindPending: true })
    renderPane()
    await waitFor(() => expect(useUiStore.getState().changesFindPending).toBe(false))
    expect(document.activeElement).toBe(screen.getByLabelText('Find in changes'))
  })

  it('does not grab focus when the pane mounts without a pending request', async () => {
    mock.mockResolvedValue(PAYLOAD)
    renderPane()
    await waitFor(() => expect(screen.getByText('2 files')).toBeTruthy())
    expect(document.activeElement).not.toBe(screen.getByLabelText('Find in changes'))
  })

  it('keeps the base picker reachable even when there are no changes', async () => {
    mock.mockResolvedValue({ base: 'abc', files: [], diff: '', truncated: false })
    renderPane({ baseBranch: 'main' })
    await waitFor(() => expect(screen.getByText('No changes yet')).toBeTruthy())
    expect(screen.getByTitle(BASE_TRIGGER)).toBeTruthy()
  })
})
