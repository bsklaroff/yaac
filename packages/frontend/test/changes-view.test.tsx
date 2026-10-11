// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { act, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
import type { WorkspaceChanges, WorkspaceFiles as WorkspaceFilesData } from '@yaac/shared/types'
import { WorkspaceFiles } from '#components/WorkspaceFiles'
import { GitStatusBar } from '#components/GitStatusBar'
import { CHANGES_TARGET, FILES_TARGET } from '#lib/files'
import { useWorkspaceChanges } from '#lib/useWorkspaceChanges'
import { QueryClientProvider } from '@tanstack/react-query'
import { IS_MAC } from '#lib/platform'
import { MAX_COUNTED } from '#lib/matchCount'
import { paneViewKey, useUiStore } from '#lib/store'
import { FakeWorker, mockFetch, renderWithClient, serverError, testQueryClient, type FetchMock } from './harness'

/**
 * The Changes pane and the status bar's way into it: the files changed
 * since the diff base, their line counts, diffs and stages, and find across
 * the diffs. The explorer shows the same counts and stages in its tree.
 */

const CHANGES = 'GET /api/workspace/s1/changes'
const VIEW = paneViewKey('s1', FILES_TARGET)
const CHANGES_VIEW = paneViewKey('s1', CHANGES_TARGET)
const BASE_TRIGGER = 'Choose the branch changes are compared against'

const LISTING: WorkspaceFilesData = {
  version: 'v1',
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
  branch: 'main',
  comparison: null,
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

/** The changes route's answer: `payload`, without its diff body under
 *  `diff=0`, plus the listing when asked for one the caller does not
 *  already hold. */
const reply = (payload: WorkspaceChanges) => ({ query }: { query: URLSearchParams }): WorkspaceChanges => {
  const { diff, ...bare } = payload
  const answer = query.get('diff') === '0' ? bare : { ...bare, diff }
  return query.get('listing') && query.get('known') !== LISTING.version ? { ...answer, listing: LISTING } : answer
}

beforeEach(() => {
  server = mockFetch({
    [CHANGES]: reply(PAYLOAD),
    'GET /api/project/proj/branches': { branches: ['main', 'dev'], defaultBranch: 'main' },
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useUiStore.setState({ paneView: {}, changesBase: {}, layouts: {}, activeTabs: {}, findPending: null })
})

const explorer = <WorkspaceFiles workspaceId="s1" projectId="proj" baseBranch="main" />
const changesPane = <WorkspaceFiles workspaceId="s1" projectId="proj" baseBranch="main" changedOnly />
const renderExplorer = (): void => { renderWithClient(explorer) }
const renderChanges = (): void => { renderWithClient(changesPane) }
/** Every changed file, to open all their diffs. */
const ALL_PATHS = PAYLOAD.files.map((f) => f.path)
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

  it('lists only changed files, flat first or as an open tree, each diff folded until shown', async () => {
    // The explorer's polls leave the diff body out, so until the Changes
    // pane's own fetch lands its diffs say they are loading, not that none
    // exist.
    const client = testQueryClient()
    const view = renderWithClient(explorer, client)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    view.rerender(<QueryClientProvider client={client}>{changesPane}</QueryClientProvider>)
    expect(screen.queryByText('Loading diff…')).toBeNull()
    fireEvent.click(screen.getByLabelText('Show all changes'))
    expect(screen.getAllByText('Loading diff…')).toHaveLength(3)
    expect(screen.queryByText('No textual diff')).toBeNull()
    await waitFor(() => expect(screen.getByText('needle1')).toBeTruthy())
    expect(screen.getByTitle('src/app.ts').textContent).toContain('src/app.ts')
    // The strip totals the shown files, then breaks them down by stage.
    expect(screen.getByText('+4').closest('.items-baseline')?.textContent)
      .toBe('total+4 −5·committed+1 −4·modified+1 −1·untracked+2')
    expect(screen.queryByRole('button', { name: /^src$/ })).toBeNull()
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.getAllByText('No textual diff')).toHaveLength(1)
    // Creating files and folding the whole tree belong to the explorer.
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

    // The filter matches paths as quick-open does, never a diff's lines.
    fireEvent.change(screen.getByLabelText('Filter changed files'), { target: { value: 'nw' } })
    expect(screen.getByText('1 of 3 changed')).toBeTruthy()
    expect(screen.queryByText('needle1')).toBeNull()
    fireEvent.change(screen.getByLabelText('Filter changed files'), { target: { value: 'alpha' } })
    expect(screen.getByText('No changes match “alpha”')).toBeTruthy()
    // The explorer keeps its own filter and view.
    expect(useUiStore.getState().paneView[VIEW]?.find).toBeUndefined()
  })

  // A rename's row shows both paths, so the filter matches either.
  it('filters a rename by its old path too', async () => {
    server.route(CHANGES, reply({
      ...PAYLOAD,
      files: PAYLOAD.files.map((f) => (f.path === 'src/app.ts' ? { ...f, status: 'renamed', oldPath: 'lib/legacy.ts' } : f)),
    }))
    useUiStore.getState().setPaneView(CHANGES_VIEW, { find: 'legacy' })
    renderChanges()
    await waitFor(() => expect(screen.getByText('1 of 3 changed')).toBeTruthy())
    expect(screen.getByTitle('lib/legacy.ts → src/app.ts')).toBeTruthy()
  })

  // A row opens and folds its own diff; only the name opens the file.
  it('opens one file’s diff from its row, in the tree and the flat list', async () => {
    useUiStore.getState().setPaneView(CHANGES_VIEW, { flat: false })
    renderChanges()
    await waitFor(() => expect(row('src/app.ts')).toBeTruthy())

    fireEvent.click(row('src/app.ts'))
    await waitFor(() => expect(screen.getByText('needle1')).toBeTruthy())
    expect(screen.queryByText('alpha')).toBeNull()
    expect(useUiStore.getState().layouts.s1).toBeUndefined()
    expect(screen.getByLabelText('Hide the diff of src/app.ts').getAttribute('aria-expanded')).toBe('true')

    // The diff stays open across the flat list, and the chevron folds it.
    fireEvent.click(screen.getByLabelText('Show as a flat list'))
    expect(screen.getByText('needle1')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Hide the diff of src/app.ts'))
    expect(screen.queryByText('needle1')).toBeNull()

    // Opening each one by hand turns the header button to "Collapse all".
    for (const path of ALL_PATHS) fireEvent.click(row(path))
    expect(screen.getByLabelText('Collapse all changes')).toBeTruthy()
  })

  it('picks the diff base, and says what an unresolved base or a cut diff leaves out', async () => {
    server.route(CHANGES, reply({ ...PAYLOAD, baseResolved: false, truncated: true }))
    renderChanges()
    await waitFor(() => expect(screen.getByText('uncommitted only')).toBeTruthy())
    expect(screen.getByText('diff truncated (large changeset)')).toBeTruthy()
    expect(screen.getByTitle(BASE_TRIGGER).textContent).toContain('main')

    fireEvent.click(screen.getByTitle(BASE_TRIGGER))
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())
    fireEvent.click(within(screen.getByRole('listbox')).getByText('dev'))
    expect(useUiStore.getState().changesBase.s1).toBe('dev')
    await waitFor(() => expect(basesAsked()).toContain('dev'))

    server.route(CHANGES, reply({ ...PAYLOAD, files: [], diff: '', baseResolved: false }))
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
    useUiStore.getState().setPaneView(CHANGES_VIEW, { openDiffs: ALL_PATHS })
    const observed: { el: Element; notify: (near: boolean) => void }[] = []
    vi.stubGlobal('IntersectionObserver', class {
      constructor(private readonly cb: IntersectionObserverCallback) {}
      observe(el: Element): void {
        observed.push({ el, notify: (near) => this.cb([{ target: el, isIntersecting: near } as unknown as IntersectionObserverEntry], this as never) })
      }
      unobserve(): void {}
    })
    renderChanges()
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
  it('polls once for the status bar, the explorer and the Changes pane together', async () => {
    useUiStore.getState().setPaneView(CHANGES_VIEW, { openDiffs: ALL_PATHS })
    const client = testQueryClient()
    renderWithClient(<><GitStatusBar workspaceId="s1" />{explorer}{changesPane}</>, client)
    await waitFor(() => expect(screen.getByText('needle1')).toBeTruthy())
    const active = client.getQueryCache().findAll({ queryKey: ['changes', 's1'], type: 'active' })
    expect(active.map((q) => q.queryKey)).toEqual([['changes', 's1', null]])
    // Mounted together, they ask for everything any of them wants at once.
    expect(server.called(CHANGES).map((c) => c.query.toString())).toEqual(['diff=1&listing=full'])
  })

  // A file pane stays mounted when its workspace is no longer on screen.
  // It neither polls nor makes the query fetch when the others go away.
  it('fetches nothing for a hidden reader once the others unmount', async () => {
    let seen: WorkspaceChanges | undefined
    function HiddenPane(): null {
      seen = useWorkspaceChanges('s1', { poll: false }).data
      return null
    }
    const client = testQueryClient()
    const view = renderWithClient(<><GitStatusBar workspaceId="s1" /><HiddenPane /></>, client)
    await waitFor(() => expect(seen).toBeDefined())
    view.rerender(<QueryClientProvider client={client}><HiddenPane /></QueryClientProvider>)
    await new Promise((r) => setTimeout(r, 50))
    expect(server.called(CHANGES)).toHaveLength(1)
  })

  // Opening the pane focuses its filter, so typing filters with no click.
  // Cmd/Ctrl-F searches the diffs instead: across files in the order shown,
  // unfolding what a match sits in.
  it('focuses its filter when opened, and finds across the diffs on Cmd/Ctrl-F', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const scrolled: Element[] = []
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this) }
    useUiStore.getState().setPaneView(CHANGES_VIEW, { flat: false, collapsed: ['src'], openDiffs: ['src/app.ts'] })
    renderChanges()
    await waitFor(() => expect(screen.getByTitle('src')).toBeTruthy())
    act(() => useUiStore.getState().openChanges('s1'))
    const filter = screen.getByLabelText('Filter changed files')
    await waitFor(() => expect(document.activeElement).toBe(filter))

    const ctrlF = (el: Element): void => {
      fireEvent.keyDown(el, { key: 'f', code: 'KeyF', ctrlKey: !IS_MAC, metaKey: IS_MAC })
    }
    ctrlF(screen.getByTitle('src'))
    const find = screen.getByRole('textbox', { name: 'Find' })
    expect(document.activeElement).toBe(find)
    const status = (): string => screen.getByRole('status').textContent ?? ''
    const current = (): Element | null => document.querySelector('[data-find-current]')

    // "l" is in old and needle1 (src/app.ts), then alpha (src/new.ts). The
    // first match opens the folder it is in, and scrolls to it.
    fireEvent.change(find, { target: { value: 'l' } })
    await waitFor(() => expect(status()).toBe('1 of 3'))
    expect(current()?.parentElement?.textContent).toBe('old')
    expect(scrolled.at(-1)).toBe(current())
    fireEvent.keyDown(find, { key: 'Enter' })
    expect(status()).toBe('2 of 3')
    expect(current()?.parentElement?.textContent).toBe('needle1')
    // The next match is in a folded diff, which unfolds.
    fireEvent.keyDown(find, { key: 'Enter' })
    expect(status()).toBe('3 of 3')
    expect(current()?.parentElement?.textContent).toBe('alpha')
    expect(useUiStore.getState().paneView[CHANGES_VIEW]?.openDiffs).toEqual(['src/app.ts', 'src/new.ts'])
    fireEvent.keyDown(find, { key: 'Enter', shiftKey: true })
    expect(status()).toBe('2 of 3')

    // Only the files the filter shows are searched.
    fireEvent.change(filter, { target: { value: 'app' } })
    await waitFor(() => expect(status()).toMatch(/ of 2$/))

    // Escape closes the bar and clears the marks; Cmd/Ctrl-F brings the
    // query back.
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Find' }), { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Find' })).toBeNull()
    expect(current()).toBeNull()
    ctrlF(screen.getByTitle('src/app.ts'))
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Find' }).value).toBe('l')
  })
})

describe('WorkspaceFiles changes, find at scale', () => {
  // The editor's count stops at MAX_COUNTED; stepping here walks the
  // counted matches, so the Changes pane counts them all.
  it('steps to every match, past the editor count cap', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    // Never near the screen, so only the chunk holding the current match
    // mounts.
    vi.stubGlobal('IntersectionObserver', class {
      observe(): void {}
      unobserve(): void {}
    })
    Element.prototype.scrollIntoView = () => {}
    const n = MAX_COUNTED + 2
    const body = Array.from({ length: n }, () => '+x').join('\n')
    server.route(CHANGES, reply({
      ...PAYLOAD,
      files: [{
        path: 'big.txt', status: 'added', additions: n, deletions: 0, binary: false,
        stages: { untracked: { additions: n, deletions: 0 } },
      }],
      diff: `diff --git a/big.txt b/big.txt\n--- /dev/null\n+++ b/big.txt\n@@ -0,0 +1,${n} @@\n${body}`,
    }))
    renderChanges()
    await waitFor(() => expect(screen.getByTitle('big.txt')).toBeTruthy())
    fireEvent.keyDown(screen.getByTitle('big.txt'), { key: 'f', code: 'KeyF', ctrlKey: !IS_MAC, metaKey: IS_MAC })
    const find = screen.getByRole('textbox', { name: 'Find' })
    fireEvent.change(find, { target: { value: 'x' } })
    const status = (): string => screen.getByRole('status').textContent ?? ''
    await waitFor(() => expect(status()).toBe(`1 of ${n}`))
    fireEvent.keyDown(find, { key: 'Enter', shiftKey: true })
    expect(status()).toBe(`${n} of ${n}`)
    // The last line's chunk mounted to show it.
    expect(document.querySelector('[data-find-current]')?.closest('.flex')?.textContent).toBe(`${n}+x`)
  })
})

describe('GitStatusBar changes', () => {
  it('says where HEAD stands, totals the changed lines and opens the changes view', async () => {
    server.route(CHANGES, reply({ ...PAYLOAD, comparison: { ref: 'origin/main', ahead: 2, behind: 0 } }))
    renderWithClient(<GitStatusBar workspaceId="s1" />)
    const button = await screen.findByTitle('Review changes')
    expect(button.textContent).toBe('+4 −5')
    expect(screen.getByText(/2 commits ahead of/)).toBeTruthy()
    fireEvent.click(button)
    expect(useUiStore.getState().activeTabs.s1).toBe(CHANGES_TARGET)
    expect(useUiStore.getState().findPending).toBe(CHANGES_TARGET)
  })

  // A failed poll keeps the last answer in the cache; neither reader may
  // pass it off as current. A pick whose branch went away offers a way back.
  it('says when a poll fails instead of showing the last answer', async () => {
    const gone = serverError('VALIDATION', 'base ref "gone" gives no diff base in this workspace', 400)
    server.route(CHANGES, (call: { query: URLSearchParams }) => (
      call.query.get('base') === 'gone' ? gone : reply(PAYLOAD)(call)
    ))
    const client = testQueryClient()
    const view = renderWithClient(<><GitStatusBar workspaceId="s1" />{explorer}</>, client)
    await screen.findByTitle('Review changes')
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())

    act(() => useUiStore.getState().setChangesBase('s1', 'gone'))
    await waitFor(() => expect(screen.getByText(/Git status unavailable/)).toBeTruthy())
    expect(screen.queryByTitle('Review changes')).toBeNull()
    expect(screen.getByText(/Not up to date: base ref "gone"/)).toBeTruthy()

    fireEvent.click(screen.getByText('Compare with main'))
    await waitFor(() => expect(screen.queryByText(/Not up to date/)).toBeNull())
    expect(useUiStore.getState().changesBase.s1).toBeUndefined()
    await screen.findByTitle('Review changes')

    // The diffs a failed fetch never brought are not shown as loading.
    server.route(CHANGES, (call: { query: URLSearchParams }) => (
      call.query.get('diff') === '1' ? serverError('INTERNAL', 'exec failed', 500) : reply(PAYLOAD)(call)
    ))
    act(() => useUiStore.getState().setPaneView(CHANGES_VIEW, { openDiffs: ALL_PATHS }))
    view.rerender(<QueryClientProvider client={client}><GitStatusBar workspaceId="s1" />{changesPane}</QueryClientProvider>)
    await waitFor(() => expect(screen.getAllByText('Diff not loaded')).toHaveLength(3))
    expect(screen.queryByText('Loading diff…')).toBeNull()
  })

  // The bar's one poll also keeps the explorer's paths ready before it
  // opens, and the server leaves them out while they hold still.
  it('carries the listing in its own poll, sent again only when it changed', async () => {
    const client = testQueryClient()
    renderWithClient(<GitStatusBar workspaceId="s1" />, client)
    await waitFor(() => expect(client.getQueryData(['files', 's1'])).toEqual(LISTING))
    expect(server.called(CHANGES)[0].query.get('listing')).toBe('paths')

    await client.refetchQueries({ queryKey: ['changes', 's1'] })
    expect(server.called(CHANGES).at(-1)?.query.get('known')).toBe('v1')
    expect(client.getQueryData(['files', 's1'])).toEqual(LISTING)
    expect(new Set(server.calls.map((c) => c.path))).toEqual(new Set(['/api/workspace/s1/changes']))
  })
})
