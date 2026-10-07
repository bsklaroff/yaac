// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { act, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
import type { WorkspaceChanges, WorkspaceFiles as WorkspaceFilesData } from '@yaac/shared/types'
import { WorkspaceFiles } from '#components/WorkspaceFiles'
import { GitStatusBar } from '#components/GitStatusBar'
import { FILES_TARGET } from '#lib/files'
import { IS_MAC } from '#lib/platform'
import { paneViewKey, useUiStore } from '#lib/store'
import { mockFetch, renderWithClient, testQueryClient, type FetchMock } from './harness'

/**
 * The explorer's changes view and the status bar's way into it: the files
 * changed since the diff base, their line counts, diffs and stages.
 */

const CHANGES = 'GET /api/workspace/s1/changes'
const VIEW = paneViewKey('s1', FILES_TARGET)
const BASE_TRIGGER = 'Choose the branch changes are compared against'

const LISTING: WorkspaceFilesData = {
  paths: ['README.md', 'src/app.ts', 'src/new.ts', 'src/same.ts'],
  symlinks: {},
  ignored: [],
  emptyDirs: [],
  conflicted: ['README.md'],
  truncated: false,
}

const PAYLOAD: WorkspaceChanges = {
  base: 'abc1234def',
  baseResolved: true,
  files: [
    {
      path: 'src/app.ts', status: 'modified', additions: 2, deletions: 1, binary: false,
      stages: { committed: { additions: 1, deletions: 0 }, modified: { additions: 1, deletions: 1 } },
    },
    {
      path: 'src/new.ts', status: 'added', additions: 2, deletions: 0, binary: false,
      stages: { untracked: { additions: 2, deletions: 0 } },
    },
    {
      path: 'gone.ts', status: 'deleted', additions: 0, deletions: 4, binary: false,
      stages: { committed: { additions: 0, deletions: 4 } },
    },
  ],
  diff: [
    'diff --git a/src/app.ts b/src/app.ts',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1,2 +1,3 @@',
    ' keep',
    '-old',
    '+needle1',
    '+new2',
    'diff --git a/src/new.ts b/src/new.ts',
    '--- /dev/null',
    '+++ b/src/new.ts',
    '@@ -0,0 +1,2 @@',
    '+alpha',
    '+beta',
  ].join('\n'),
  truncated: false,
}

let server: FetchMock
const basesAsked = (): (string | undefined)[] =>
  server.called(CHANGES).map((c) => c.query.get('base') ?? undefined)

beforeAll(() => {
  // jsdom has no ResizeObserver; Base UI's popover positioner needs one.
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

beforeEach(() => {
  server = mockFetch({
    'GET /api/workspace/s1/files': LISTING,
    [CHANGES]: PAYLOAD,
    'GET /api/project/proj/branches': { branches: ['main', 'dev'], defaultBranch: 'main' },
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useUiStore.setState({ paneView: {}, changesBase: {}, layouts: {}, activeTabs: {}, filesFindPending: false })
})

const renderExplorer = (): void => {
  renderWithClient(<WorkspaceFiles workspaceId="s1" projectId="proj" baseBranch="main" />)
}
/** A file's row, whose title is its path. */
const row = (path: string): HTMLElement => screen.getByTitle(path)

describe('WorkspaceFiles changes', () => {
  // Colors and badges say how a file differs from the diff base; a merge
  // conflict outranks that.
  it('shows each changed file’s line counts and status in the full tree', async () => {
    useUiStore.getState().setPaneView(VIEW, { expanded: ['src'] })
    renderExplorer()
    await waitFor(() => expect(within(row('src/app.ts')).getByText('+2')).toBeTruthy())
    expect(within(row('src/app.ts')).getByText('−1')).toBeTruthy()
    expect(within(row('src/same.ts')).queryByText(/^\+/)).toBeNull()
    // The badge is a letter per stage the file's changes sit in; its name's
    // color is how it differs from the base.
    expect(within(row('src/app.ts')).getByTitle('Committed').textContent).toBe('C')
    expect(within(row('src/app.ts')).getByTitle('Modified').textContent).toBe('M')
    expect(within(row('src/app.ts')).queryByTitle('Staged')).toBeNull()
    expect(within(row('src/app.ts')).getByText('app.ts').className).toContain('text-warning')
    expect(within(row('src/new.ts')).getByTitle('Untracked').textContent).toBe('U')
    expect(within(row('src/new.ts')).getByText('new.ts').className).toContain('text-success')
    expect(within(row('README.md')).getByTitle('Conflicted').textContent).toBe('!')
    expect(within(row('src/same.ts')).queryByTitle(/./)).toBeNull()
    expect(within(row('src')).getByLabelText('modified')).toBeTruthy()

    // One button collapses every folder while any is open, and expands them
    // all once none is.
    fireEvent.click(screen.getByLabelText('Collapse all folders'))
    expect(screen.queryByTitle('src/app.ts')).toBeNull()
    fireEvent.click(screen.getByLabelText('Expand all folders'))
    expect(screen.getByTitle('src/app.ts')).toBeTruthy()
    expect(screen.getByLabelText('Collapse all folders')).toBeTruthy()
    // The full tree lists only what is on disk, so the deleted file is absent.
    expect(screen.queryByText('gone.ts')).toBeNull()
  })

  it('lists only changed files, flat first or as an open tree, each with its diff', async () => {
    // A tree and folds chosen last time do not carry over: the view opens
    // flat, with every diff open.
    useUiStore.getState().setPaneView(VIEW, { flat: false, foldedDiffs: ['src/app.ts'] })
    renderExplorer()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Show only changed files'))
    await waitFor(() => expect(screen.getByText('needle1')).toBeTruthy())
    expect(screen.getByTitle('src/app.ts').textContent).toContain('src/app.ts')
    // The strip totals the shown files, then breaks them down by stage.
    expect(screen.getByText('+4').closest('.items-baseline')?.textContent)
      .toBe('total+4 −5·committed+1 −4·modified+1 −1·untracked+2')
    expect(screen.queryByRole('button', { name: /^src$/ })).toBeNull()
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.getAllByText('No textual diff')).toHaveLength(1)
    // Creating files and folding the whole tree belong to the full tree.
    for (const label of ['New file', 'New folder', 'Collapse all folders', 'Show ignored files']) {
      expect(screen.queryByLabelText(label)).toBeNull()
    }

    // One button folds every diff while any is open, and opens them all once
    // none is.
    fireEvent.click(screen.getByLabelText('Collapse all changes'))
    expect(screen.queryByText('needle1')).toBeNull()
    expect(screen.queryByText('alpha')).toBeNull()
    fireEvent.click(screen.getByLabelText('Show all changes'))
    expect(screen.getByText('needle1')).toBeTruthy()
    expect(screen.getByText('alpha')).toBeTruthy()

    // As a tree, folders start open; unchanged files are gone; a deletion
    // shows struck through and its name does not open it.
    fireEvent.click(screen.getByLabelText('Show as a tree'))
    await waitFor(() => expect(screen.getByText('app.ts')).toBeTruthy())
    expect(screen.queryByText('README.md')).toBeNull()
    expect(screen.queryByText('same.ts')).toBeNull()
    expect(screen.getByText('3 changed')).toBeTruthy()
    expect(screen.getByText('gone.ts').className).toContain('line-through')
    expect(screen.queryByTitle('Open gone.ts')).toBeNull()
    fireEvent.click(screen.getByTitle('Open src/app.ts'))
    expect(useUiStore.getState().activeTabs.s1).toBe('file:src/app.ts')

    // The filter matches a line of a diff, not only a path.
    fireEvent.change(screen.getByLabelText('Filter files'), { target: { value: 'needle' } })
    expect(screen.getByText('1 of 3 changed')).toBeTruthy()
    expect(screen.queryByText('alpha')).toBeNull()
    fireEvent.change(screen.getByLabelText('Filter files'), { target: { value: 'zzz' } })
    expect(screen.getByText('No changes match “zzz”')).toBeTruthy()
  })

  // A row folds its own diff; only the name opens the file.
  it('folds one file’s diff from its row, in the tree and the flat list', async () => {
    useUiStore.getState().setPaneView(VIEW, { changedOnly: true, flat: false })
    renderExplorer()
    await waitFor(() => expect(screen.getByText('needle1')).toBeTruthy())

    fireEvent.click(row('src/app.ts'))
    expect(screen.queryByText('needle1')).toBeNull()
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(useUiStore.getState().layouts.s1).toBeUndefined()
    expect(screen.getByLabelText('Show the diff of src/app.ts').getAttribute('aria-expanded')).toBe('false')

    // The fold holds across the flat list, and the chevron unfolds it.
    fireEvent.click(screen.getByLabelText('Show as a flat list'))
    expect(screen.queryByText('needle1')).toBeNull()
    fireEvent.click(screen.getByLabelText('Show the diff of src/app.ts'))
    expect(screen.getByText('needle1')).toBeTruthy()

    // Folding each one by hand turns the header button to "Show all".
    for (const path of ['src/app.ts', 'src/new.ts', 'gone.ts']) fireEvent.click(row(path))
    expect(screen.getByLabelText('Show all changes')).toBeTruthy()
  })

  it('picks the diff base, and says what an unresolved base or a cut diff leaves out', async () => {
    useUiStore.getState().setPaneView(VIEW, { changedOnly: true })
    server.route(CHANGES, { ...PAYLOAD, baseResolved: false, truncated: true })
    renderExplorer()
    await waitFor(() => expect(screen.getByText('uncommitted only')).toBeTruthy())
    expect(screen.getByText('diff truncated (large changeset)')).toBeTruthy()
    expect(screen.getByTitle(BASE_TRIGGER).textContent).toContain('main')

    fireEvent.click(screen.getByTitle(BASE_TRIGGER))
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())
    fireEvent.click(within(screen.getByRole('listbox')).getByText('dev'))
    expect(useUiStore.getState().changesBase.s1).toBe('dev')
    await waitFor(() => expect(basesAsked()).toContain('dev'))

    server.route(CHANGES, { ...PAYLOAD, files: [], diff: '', baseResolved: false })
    useUiStore.getState().setChangesBase('s1', 'main')
    await waitFor(() => expect(screen.getByText('Nothing uncommitted')).toBeTruthy())
    // The picker stays reachable with nothing to list.
    expect(screen.getByTitle(BASE_TRIGGER)).toBeTruthy()
  })
})

describe('WorkspaceFiles changes, at scale', () => {
  // Opening the view with every diff open must not mount every diff: a
  // chunk mounts only once it comes near the screen, holding its height
  // until then.
  it('mounts a diff only when it comes near the screen', async () => {
    const observed: { el: Element; notify: (near: boolean) => void }[] = []
    vi.stubGlobal('IntersectionObserver', class {
      constructor(private readonly cb: IntersectionObserverCallback) {}
      observe(el: Element): void {
        observed.push({ el, notify: (near) => this.cb([{ target: el, isIntersecting: near } as unknown as IntersectionObserverEntry], this as never) })
      }
      unobserve(): void {}
    })
    useUiStore.getState().setPaneView(VIEW, { changedOnly: true })
    renderExplorer()
    await waitFor(() => expect(screen.getByTitle('src/app.ts')).toBeTruthy())
    await waitFor(() => expect(observed).toHaveLength(2))
    expect(screen.queryByText('needle1')).toBeNull()
    // app.ts's diff is a hunk header and four lines, 16.5px each.
    expect((observed[0].el as HTMLElement).style.height).toBe(`${5 * 16.5}px`)

    act(() => observed[0].notify(true))
    expect(screen.getByText('needle1')).toBeTruthy()
    expect(screen.queryByText('alpha')).toBeNull()
    act(() => observed[0].notify(false))
    expect(screen.queryByText('needle1')).toBeNull()
  })

  // Every reader of a workspace's changes shares one query, which carries
  // the diff body while any of them shows it.
  it('polls once for the status bar and the changes view together', async () => {
    useUiStore.getState().setPaneView(VIEW, { changedOnly: true })
    const client = testQueryClient()
    renderWithClient(
      <>
        <GitStatusBar workspaceId="s1" />
        <WorkspaceFiles workspaceId="s1" projectId="proj" baseBranch="main" />
      </>,
      client,
    )
    await waitFor(() => expect(screen.getByText('needle1')).toBeTruthy())
    const active = client.getQueryCache().findAll({ queryKey: ['changes', 's1'], type: 'active' })
    expect(active.map((q) => q.queryKey)).toEqual([['changes', 's1', null, true]])
    expect(server.called(CHANGES).at(-1)?.query.get('diff')).toBe('1')
  })

  // Opening the view focuses its filter, so typing filters and Cmd/Ctrl-F
  // needs no click; from anywhere in the explorer the chord returns there.
  it('focuses its filter when opened, and on Cmd/Ctrl-F', async () => {
    renderExplorer()
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    act(() => useUiStore.getState().openChanges('s1'))
    const filter = screen.getByLabelText('Filter files')
    await waitFor(() => expect(document.activeElement).toBe(filter))

    filter.blur()
    const list = screen.getByTitle('src/app.ts')
    fireEvent.keyDown(list, { key: 'f', code: 'KeyF', ctrlKey: !IS_MAC, metaKey: IS_MAC })
    expect(document.activeElement).toBe(filter)
  })
})

describe('GitStatusBar changes', () => {
  it('totals the changed lines and opens the changes view', async () => {
    server.route('GET /api/workspace/s1/git-status', { base: 'main', comparison: { ref: 'origin/main', ahead: 2, behind: 0 } })
    renderWithClient(<GitStatusBar workspaceId="s1" />)
    const button = await screen.findByTitle('Review changes')
    expect(button.textContent).toBe('+4 −5')
    fireEvent.click(button)
    expect(useUiStore.getState().activeTabs.s1).toBe(FILES_TARGET)
    expect(useUiStore.getState().paneView[VIEW]).toMatchObject({ changedOnly: true, flat: true, foldedDiffs: [] })
  })
})
