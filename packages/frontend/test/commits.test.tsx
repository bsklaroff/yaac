import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
import { MAX_LOG_COMMITS, type GitLogCommit, type WorkspaceChanges, type WorkspaceGitLog } from '@yaac/shared/types'
import { WorkspaceCommits } from '#components/WorkspaceCommits'
import { GitStatusBar } from '#components/GitStatusBar'
import { COMMITS_TARGET, layoutGraph } from '#lib/commits'
import { useUiStore } from '#lib/store'
import { mockFetch, renderWithClient, serverError, type FetchMock } from './harness'

/**
 * The Commits pane: the graph's lanes, the list beside it, the compare
 * picker it shares with the Changes pane, and the git status strip's way
 * into it.
 */

const COMMITS = 'GET /api/workspace/s1/commits'
const TRIGGER = 'Choose the branch HEAD is compared against'

const commit = (sha: string, parents: string[], over: Partial<GitLogCommit> = {}): GitLogCommit => ({
  sha: sha.padEnd(40, '0'), parents: parents.map((p) => p.padEnd(40, '0')),
  author: 'Tess', time: Math.floor(Date.now() / 1000) - 3600, subject: `commit ${sha}`, refs: [], ...over,
})

/** HEAD's branch, two ahead of the fork point, and main, one past it.
 *  The checkout also has `orphan`, which shares no history with HEAD. */
const LOG: WorkspaceGitLog = {
  ref: 'origin/main',
  head: 'a2'.padEnd(40, '0'),
  commits: [
    commit('a2', ['a1'], { refs: ['HEAD -> agent/x'], subject: 'second of ours' }),
    commit('b1', ['f'], { refs: ['tag: v1', 'origin/main', 'origin/agent/y'], subject: 'landed on main' }),
    commit('a1', ['f'], { refs: ['HEAD-fix'], subject: 'first of ours' }),
    commit('f', [], { refs: ['main'], subject: 'the fork point' }),
  ],
  more: true,
}

let server: FetchMock
beforeEach(() => {
  server = mockFetch({
    [COMMITS]: ({ query }: { query: URLSearchParams }) => (query.get('branches') === '1'
      ? { ...LOG, branches: ['refs/heads/agent/x', 'refs/heads/main', 'refs/heads/orphan', 'origin/main'] }
      : query.get('base') === 'refs/heads/orphan'
        ? serverError('CHANGES_BASE_UNRESOLVED', 'no common commit with orphan', 400)
        : LOG),
  })
})

afterEach(() => {
  cleanup()
  useUiStore.setState({ changesBase: {}, layouts: {}, activeTabs: {} })
})

describe('layoutGraph', () => {
  // A branch keeps its lane and color from tip to fork point; a merge's
  // second parent opens a lane, and lanes waiting for one commit converge
  // on it.
  it('keeps branches straight, forking and merging between lanes', () => {
    const { rows, width } = layoutGraph([
      { sha: 'm', parents: ['a2', 'b1'] },
      { sha: 'b1', parents: ['f'] },
      { sha: 'a2', parents: ['a1'] },
      { sha: 'a1', parents: ['f'] },
      { sha: 'f', parents: [] },
    ])
    expect(width).toBe(2)
    expect(rows.map((r) => [r.lane, r.color])).toEqual([[0, 0], [1, 1], [0, 0], [0, 0], [0, 0]])
    expect(rows[0]).toMatchObject({ top: [], bottom: [{ from: 0, to: 0, color: 0 }, { from: 0, to: 1, color: 1 }] })
    expect(rows[1].bottom).toEqual([{ from: 0, to: 0, color: 0 }, { from: 1, to: 1, color: 1 }])
    // Both branches wait on the fork point until it comes.
    expect(rows[3].bottom).toEqual([{ from: 1, to: 1, color: 1 }, { from: 0, to: 0, color: 0 }])
    expect(rows[4]).toMatchObject({ top: [{ from: 0, to: 0, color: 0 }, { from: 1, to: 0, color: 1 }], bottom: [] })
  })

  // A tip after a lane closed takes the free column rather than widening.
  it('reuses a closed lane, and leaves a missing parent’s lane open', () => {
    const { rows, width } = layoutGraph([
      { sha: 'x', parents: ['y', 'z'] },
      { sha: 'z', parents: [] },
      { sha: 'w', parents: ['gone'] },
      { sha: 'y', parents: ['gone'] },
    ])
    expect(width).toBe(2)
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 1, 0])
    expect(rows[3].bottom).toEqual([{ from: 1, to: 1, color: 2 }, { from: 0, to: 0, color: 0 }])
  })

  // An octopus merge opens a lane per extra parent; a root among them
  // closes only its own.
  it('fans an octopus merge out, and ends a root’s lane alone', () => {
    const { rows, width } = layoutGraph([
      { sha: 'o', parents: ['p1', 'p2', 'p3'] },
      { sha: 'p3', parents: [] },
      { sha: 'p2', parents: ['p1'] },
      { sha: 'p1', parents: [] },
    ])
    expect(width).toBe(3)
    expect(rows[0].bottom).toEqual([
      { from: 0, to: 0, color: 0 }, { from: 0, to: 1, color: 1 }, { from: 0, to: 2, color: 2 },
    ])
    expect(rows[1]).toMatchObject({ lane: 2, bottom: [{ from: 0, to: 0, color: 0 }, { from: 1, to: 1, color: 1 }] })
    expect(rows[3]).toMatchObject({ lane: 0, top: [{ from: 0, to: 0, color: 0 }, { from: 1, to: 0, color: 1 }], bottom: [] })
  })

  // "Load older" lays the longer list out again, so the rows already on
  // screen must not move. Checked over a seeded random history of merges,
  // octopus merges and roots.
  it('lays out a page the same whatever follows it', () => {
    let seed = 7
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed % n
    }
    const oldestFirst: Array<{ sha: string; parents: string[] }> = []
    for (let i = 0; i < 400; i++) {
      const parents = i === 0 || rand(20) === 0 ? [] : [...new Set(
        Array.from({ length: 1 + (rand(5) === 0 ? 1 + rand(2) : 0) }, () => `c${i - 1 - rand(Math.min(i, 30))}`),
      )]
      oldestFirst.push({ sha: `c${i}`, parents })
    }
    const all = oldestFirst.reverse()
    expect(layoutGraph(all).width).toBeGreaterThan(3)
    expect(layoutGraph(all.slice(0, 200)).rows).toEqual(layoutGraph(all).rows.slice(0, 200))
  })
})

describe('WorkspaceCommits', () => {
  it('lists the commits with their notable refs, dimming the ones only the compared branch has', async () => {
    renderWithClient(<WorkspaceCommits workspaceId="s1" baseBranch="main" />)
    await waitFor(() => expect(screen.getByText('second of ours')).toBeTruthy())
    expect(screen.getByTitle(TRIGGER).textContent).toContain('origin/main')
    expect(screen.getByTitle('HEAD -> agent/x').textContent).toBe('HEAD')
    expect(screen.queryByTitle('HEAD-fix')).toBeNull()
    expect(screen.getByTitle('tag: v1').textContent).toBe('v1')
    expect(screen.getByTitle('origin/main')).toBeTruthy()
    expect(screen.queryByTitle('main')).toBeNull()
    expect(screen.queryByTitle('origin/agent/y')).toBeNull()
    const row = (subject: string): HTMLElement => screen.getByTitle(subject).closest<HTMLElement>('div')!
    expect(row('landed on main').className).toContain('text-text-faint')
    expect(row('first of ours').className).not.toContain('text-text-faint')
    expect(row('the fork point').className).not.toContain('text-text-faint')
    expect(within(row('second of ours')).getByText('a200000')).toBeTruthy()

    // Older pages up to the cap the route takes, and no further.
    for (let limit = 400; limit <= MAX_LOG_COMMITS; limit += 200) {
      fireEvent.click(await screen.findByText('Load older commits'))
      await waitFor(() => expect(server.called(COMMITS).at(-1)?.query.get('limit')).toBe(String(limit)))
    }
    await waitFor(() => expect(screen.getByText('Showing the newest 2,000 commits.')).toBeTruthy())
    expect(screen.queryByText('Load older commits')).toBeNull()
    // The list's polls never carry the branches; the picker asks for them.
    expect(server.called(COMMITS).every((c) => c.query.get('branches') === null)).toBe(true)
  })

  // Origin's fork branch leads the list. A local branch is asked for by its
  // full name, so origin's `main` cannot stand in for it; the Changes pane
  // and the strip follow the pick. A branch the log cannot compare against
  // keeps the strip, so another can be picked from the failure.
  it('compares against a picked branch, shared with the Changes pane', async () => {
    renderWithClient(<WorkspaceCommits workspaceId="s1" baseBranch="main" />)
    await waitFor(() => expect(screen.getByText('second of ours')).toBeTruthy())
    fireEvent.click(screen.getByTitle(TRIGGER))
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())
    expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent))
      .toEqual(['origin/maindefault', 'agent/x', 'main', 'orphan'])
    fireEvent.click(within(screen.getByRole('listbox')).getByText('main'))
    expect(useUiStore.getState().changesBase.s1).toBe('refs/heads/main')
    await waitFor(() => expect(server.called(COMMITS).at(-1)?.query.get('base')).toBe('refs/heads/main'))

    fireEvent.click(screen.getByTitle(TRIGGER))
    fireEvent.click(await within(await screen.findByRole('listbox')).findByText('orphan'))
    await waitFor(() => expect(screen.getByText('no common commit with orphan')).toBeTruthy())
    expect(screen.getByTitle(TRIGGER).textContent).toContain('orphan')
    fireEvent.click(screen.getByTitle(TRIGGER))
    fireEvent.click(await within(await screen.findByRole('listbox')).findByText('agent/x'))
    await waitFor(() => expect(screen.getByText('second of ours')).toBeTruthy())
  })

  // A workspace created at a commit is compared against that commit, named
  // by its short sha.
  it('names a commit it is compared against by its short sha', async () => {
    const start = 'f'.padEnd(40, '0')
    server.route(COMMITS, { ...LOG, ref: start })
    renderWithClient(<WorkspaceCommits workspaceId="s1" startCommit={start} />)
    await waitFor(() => expect(screen.getByTitle(TRIGGER).textContent).toBe('f000000'))
  })
})

describe('GitStatusBar', () => {
  it('opens the Commits pane from how far HEAD is from its base', async () => {
    const changes: WorkspaceChanges = {
      base: 'f', work: 'w', baseResolved: true, files: [], truncated: false, readMs: 0,
      branch: 'main', comparison: { ref: 'origin/main', ahead: 2, behind: 1 },
    }
    server.route('GET /api/workspace/s1/changes', changes)
    renderWithClient(<GitStatusBar workspaceId="s1" />)
    await waitFor(() => expect(screen.getByTitle('Review commits').textContent).toContain('2 commits ahead of, 1 commit behind origin/main'))
    fireEvent.click(screen.getByTitle('Review commits'))
    expect(useUiStore.getState().activeTabs.s1).toBe(COMMITS_TARGET)
  })

  it('names a commit base by its short sha', async () => {
    const start = 'f'.padEnd(40, '0')
    server.route('GET /api/workspace/s1/changes', {
      base: start, work: 'w', baseResolved: true, files: [], truncated: false, readMs: 0,
      branch: start, comparison: { ref: start, ahead: 3, behind: 0 },
    } satisfies WorkspaceChanges)
    renderWithClient(<GitStatusBar workspaceId="s1" />)
    await waitFor(() => expect(screen.getByTitle('Review commits').textContent).toBe('3 commits ahead of f000000'))
  })
})
