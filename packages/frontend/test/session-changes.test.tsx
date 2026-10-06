// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { screen, cleanup, waitFor, fireEvent, within, type RenderResult } from '@testing-library/react'
import type { WorkspaceChanges as SessionChangesData } from '@yaac/shared/types'
import type { ProjectBranches } from '#lib/useProjectBranches'
import { WorkspaceChanges } from '#components/WorkspaceChanges'
import { useUiStore } from '#lib/store'
import { findChord } from '#lib/shortcuts'
import { mockFetch, renderWithClient, type FetchMock } from './harness'

const CHANGES = 'GET /api/workspace/s1/changes'

let server: FetchMock
/** Answer the changes route with this payload. */
const changes = (payload: SessionChangesData): void => server.route(CHANGES, payload)
/** The `base` each changes fetch asked for (undefined: the server default). */
const basesAsked = (): (string | undefined)[] =>
  server.called(CHANGES).map((c) => c.query.get('base') ?? undefined)

const BRANCHES: ProjectBranches = {
  branches: ['main', 'dev', 'feature/x'],
  defaultBranch: 'main',
}

const PAYLOAD: SessionChangesData = {
  base: 'abc123',
  baseResolved: true,
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

function renderPane(
  { baseBranch = 'main', focusKey }: { baseBranch?: string; focusKey?: number } = {},
): RenderResult {
  return renderWithClient(
    <WorkspaceChanges workspaceId="s1" projectId="proj" baseBranch={baseBranch} focusKey={focusKey} />,
  )
}

const BASE_TRIGGER = 'Choose the branch this diff is compared against'

// jsdom has no layout, so scrollTop does nothing. Give it a per-element value
// so the pane's scroll save and restore can be tested.
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
  server = mockFetch({ 'GET /api/project/proj/branches': BRANCHES })
})

// The pane's view state and chosen base live in the shared store, so clear
// them between tests.
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useUiStore.setState({ paneView: {}, changesBase: {} })
})

describe('WorkspaceChanges', () => {
  it('lists changed files and auto-expands the first file’s diff', async () => {
    changes(PAYLOAD)
    renderPane()
    await waitFor(() => expect(screen.getByText('2 files')).toBeTruthy())
    expect(screen.getByText('new1')).toBeTruthy() // first file expanded by default
    // The second file is collapsed until clicked.
    expect(screen.queryByText('alpha')).toBeNull()
  })

  it('expands a file’s diff inline when its row is clicked, and collapses it again', async () => {
    changes(PAYLOAD)
    renderPane()
    await waitFor(() => expect(screen.getByTitle('new.ts')).toBeTruthy())
    fireEvent.click(screen.getByTitle('new.ts'))
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.getByText('new1')).toBeTruthy() // first file stays open (multiple can be)

    fireEvent.click(screen.getByTitle('src/app.ts'))
    expect(screen.queryByText('new1')).toBeNull() // collapsed
  })

  it('restores which files are expanded after the pane unmounts and remounts', async () => {
    changes(PAYLOAD)
    renderPane()
    await waitFor(() => expect(screen.getByTitle('new.ts')).toBeTruthy())
    // Expand the second file (the first auto-opens), then collapse the first.
    fireEvent.click(screen.getByTitle('new.ts'))
    fireEvent.click(screen.getByTitle('src/app.ts'))
    expect(screen.getByText('alpha')).toBeTruthy() // new.ts open
    expect(screen.queryByText('new1')).toBeNull() // src/app.ts collapsed

    // Remounting after navigating away restores the same expanded files.
    cleanup()
    renderPane()
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy())
    expect(screen.queryByText('new1')).toBeNull() // stayed collapsed, not re-opened
  })

  it('records the file list’s scroll offset as the user scrolls', async () => {
    changes(PAYLOAD)
    const { container } = renderPane()
    await waitFor(() => expect(screen.getByText('2 files')).toBeTruthy())
    const list = container.querySelector('.overflow-y-auto')
    if (!list) throw new Error('scroll container not found')
    list.scrollTop = 140
    fireEvent.scroll(list)
    expect(useUiStore.getState().paneView['s1|changes'].scroll).toBe(140)
  })

  it('restores the saved scroll offset when the pane remounts', async () => {
    useUiStore.setState({ paneView: { 's1|changes': { scroll: 220 } } })
    changes(PAYLOAD)
    const { container } = renderPane()
    await waitFor(() => expect(screen.getByText('2 files')).toBeTruthy())
    const list = container.querySelector('.overflow-y-auto')
    if (!list) throw new Error('scroll container not found')
    expect(list.scrollTop).toBe(220)
  })

  it('renders a renamed file as old → new with the old path in its title', async () => {
    changes({
      base: 'abc',
      baseResolved: true,
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
    changes({
      base: 'abc',
      baseResolved: true,
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
    changes({
      base: 'abc',
      baseResolved: true,
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
    changes({ base: 'abc', baseResolved: true, files: [], diff: '', truncated: false })
    renderPane()
    await waitFor(() => expect(screen.getByText('No changes yet')).toBeTruthy())
  })

  // Without a fork point the diff covers only uncommitted work, so an empty
  // result must name the missing branch rather than say "No changes".
  it('distinguishes an unresolved fork point from having no changes', async () => {
    changes({ base: 'abc', baseResolved: false, files: [], diff: '', truncated: false })
    renderPane({ baseBranch: 'never-pushed' })
    await waitFor(() => expect(screen.getByText('Nothing uncommitted')).toBeTruthy())
    expect(screen.queryByText('No changes yet')).toBeNull()
    expect(screen.getByText(/Couldn’t find the fork point for “never-pushed”/)).toBeTruthy()
    // The header pill must not contradict the body.
    expect(screen.getByText('nothing uncommitted')).toBeTruthy()
    expect(screen.queryByText('no changes')).toBeNull()
  })

  it('flags a listed diff as uncommitted-only when the fork point is unresolved', async () => {
    changes({ ...PAYLOAD, baseResolved: false })
    renderPane()
    await waitFor(() => expect(screen.getByText('uncommitted only')).toBeTruthy())
  })

  it('warns when the diff was truncated', async () => {
    changes({ ...PAYLOAD, truncated: true })
    renderPane()
    await waitFor(() => expect(screen.getByText(/truncated/)).toBeTruthy())
  })

  it('shows the effective base branch in the header', async () => {
    changes(PAYLOAD)
    renderPane({ baseBranch: 'main' })
    await waitFor(() => expect(screen.getByText('2 files')).toBeTruthy())
    expect(screen.getByTitle(BASE_TRIGGER).textContent).toContain('main')
  })

  it('lets the user pick a different base, which refetches against it', async () => {
    changes(PAYLOAD)
    renderPane({ baseBranch: 'main' })
    await waitFor(() => expect(screen.getByText('2 files')).toBeTruthy())

    fireEvent.click(screen.getByTitle(BASE_TRIGGER))
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())
    fireEvent.click(within(screen.getByRole('listbox')).getByText('dev'))

    expect(useUiStore.getState().changesBase.s1).toBe('dev')
    await waitFor(() => expect(basesAsked()).toContain('dev'))
  })

  // Picking the workspace's own base branch sends it explicitly. The server
  // default comes from git config, which the agent's `git push -u` points at
  // the pushed branch, so a pushed PR would show "No changes".
  it('sends the session’s own base branch explicitly when it is picked', async () => {
    useUiStore.setState({ changesBase: { s1: 'dev' } })
    changes(PAYLOAD)
    renderPane({ baseBranch: 'main' })
    await waitFor(() => expect(screen.getByText('2 files')).toBeTruthy())
    expect(basesAsked()).toEqual(['dev']) // initial fetch used the override

    fireEvent.click(screen.getByTitle(BASE_TRIGGER))
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())
    fireEvent.click(within(screen.getByRole('listbox')).getByText('main'))

    expect(useUiStore.getState().changesBase.s1).toBe('main')
    await waitFor(() => expect(basesAsked()).toContain('main'))
    expect(basesAsked()).not.toContain(undefined)
  })

  it('filters the file list by a path substring, with a filtered count in the header', async () => {
    changes(PAYLOAD)
    renderPane()
    await waitFor(() => expect(screen.getByText('2 files')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Find in changes'), { target: { value: 'new.ts' } })
    expect(screen.getByText('1 of 2 files')).toBeTruthy()
    expect(screen.getByTitle('new.ts')).toBeTruthy()
    expect(screen.queryByTitle('src/app.ts')).toBeNull()
  })

  it('filters by diff content, not just the path', async () => {
    changes(PAYLOAD)
    renderPane()
    await waitFor(() => expect(screen.getByText('2 files')).toBeTruthy())
    // 'alpha' appears only inside new.ts's diff.
    fireEvent.change(screen.getByLabelText('Find in changes'), { target: { value: 'alpha' } })
    expect(screen.getByTitle('new.ts')).toBeTruthy()
    expect(screen.queryByTitle('src/app.ts')).toBeNull()
  })

  it('shows a no-match state, and Escape clears the query', async () => {
    changes(PAYLOAD)
    renderPane()
    await waitFor(() => expect(screen.getByText('2 files')).toBeTruthy())
    const input = screen.getByLabelText('Find in changes')
    fireEvent.change(input, { target: { value: 'zzz-nothing' } })
    expect(screen.getByText('No files match “zzz-nothing”')).toBeTruthy()
    expect(screen.getByText('0 of 2 files')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(useUiStore.getState().paneView['s1|changes'].find).toBe('')
    expect(screen.getByText('2 files')).toBeTruthy()
  })

  it('keeps the query across a pane unmount/remount (store-backed)', async () => {
    changes(PAYLOAD)
    renderPane()
    await waitFor(() => expect(screen.getByText('2 files')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Find in changes'), { target: { value: 'new.ts' } })
    cleanup()
    renderPane()
    await waitFor(() => expect(screen.getByText('1 of 2 files')).toBeTruthy())
    expect(screen.getByLabelText<HTMLInputElement>('Find in changes').value).toBe('new.ts')
  })

  it('Cmd/Ctrl+F in the focused pane jumps to the find box; other chords do not', async () => {
    changes(PAYLOAD)
    renderPane()
    await waitFor(() => expect(screen.getByText('2 files')).toBeTruthy())
    const input = screen.getByLabelText('Find in changes')
    // Mounting never grabs focus on its own.
    expect(document.activeElement).not.toBe(input)
    const inPane = screen.getByTitle('new.ts')
    const { meta, ctrl } = findChord()
    fireEvent.keyDown(inPane, { code: 'KeyF', altKey: true })
    fireEvent.keyDown(inPane, { code: 'KeyF', metaKey: meta, ctrlKey: ctrl, shiftKey: true })
    expect(document.activeElement).not.toBe(input)
    // Handled, so the browser's find doesn't open.
    expect(fireEvent.keyDown(inPane, { code: 'KeyF', metaKey: meta, ctrlKey: ctrl })).toBe(false)
    expect(document.activeElement).toBe(input)
  })

  it('takes focus once loaded when it is the pane to focus, so Cmd/Ctrl+F needs no click', async () => {
    changes(PAYLOAD)
    renderPane({ focusKey: 1 })
    await waitFor(() => expect(screen.getByText('2 files')).toBeTruthy())
    const root = screen.getByLabelText('Find in changes').closest('[tabindex="-1"]')
    await waitFor(() => expect(document.activeElement).toBe(root))
    const { meta, ctrl } = findChord()
    fireEvent.keyDown(document.activeElement!, { code: 'KeyF', metaKey: meta, ctrlKey: ctrl })
    expect(document.activeElement).toBe(screen.getByLabelText('Find in changes'))
  })

  it('leaves focus in an open dialog when it is the pane to focus', async () => {
    changes(PAYLOAD)
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const prompt = document.createElement('textarea')
    dialog.append(prompt)
    document.body.append(dialog)
    prompt.focus()
    renderPane({ focusKey: 1 })
    await waitFor(() => expect(screen.getByText('2 files')).toBeTruthy())
    expect(document.activeElement).toBe(prompt)
    dialog.remove()
  })

  it('keeps the base picker reachable even when there are no changes', async () => {
    changes({ base: 'abc', baseResolved: true, files: [], diff: '', truncated: false })
    renderPane({ baseBranch: 'main' })
    await waitFor(() => expect(screen.getByText('No changes yet')).toBeTruthy())
    expect(screen.getByTitle(BASE_TRIGGER)).toBeTruthy()
  })
})
