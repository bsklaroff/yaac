import { describe, it, expect, afterEach, vi } from 'vitest'
import { screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import type { JSX } from 'react'
import type { ProjectSummary } from '@yaac/shared/types'

import { ProjectRail } from '#components/ProjectRail'
import { useUiStore } from '#lib/store'
import { mockFetch, renderWithClient, serverError, testQueryClient, TEST_USER_ID } from './harness'

const initial = useUiStore.getState()
afterEach(() => {
  cleanup()
  useUiStore.setState(initial, true)
})

const ORDER = 'PUT /api/project/order'

const project = (id: string): ProjectSummary =>
  ({ id, name: id, addedAt: '', owner: TEST_USER_ID, workspaceCount: 0, stoppedCount: 0, deaths: 0, deathsSeenBy: {}, createDefaults: {}, repos: [], scratchDirs: { dirs: [], ignoredTracked: [] }, portForwards: [], cacheVolumes: {}, nestedContainers: false, npmCache: true })

const NAMES = ['alpha', 'beta', 'gamma']
const chips = (): HTMLElement[] => screen.getAllByRole('button').filter((b) => NAMES.includes(b.title))
const shown = (): string[] => chips().map((b) => b.title)

/** jsdom lays nothing out, so each chip gets a 40px box by its current place
 *  in the rail, 8px apart, and the rail a 64px-wide column. */
function stubLayout(): void {
  for (const chip of chips()) {
    chip.getBoundingClientRect = () => {
      const top = chips().indexOf(chip) * 48
      return { top, bottom: top + 40, left: 12, right: 52, x: 12, y: top, width: 40, height: 40, toJSON: () => ({}) }
    }
  }
  const rail = chips()[0].parentElement
  if (rail) rail.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 64, x: 0, y: 0, width: 64, height: 600, toJSON: () => ({}) })
}

/** Press `name`'s chip, then move to and release at `clientY`. */
function drag(name: string, clientY: number): void {
  fireEvent.pointerDown(screen.getByTitle(name), { pointerType: 'mouse', button: 0, clientX: 30, clientY: chips().findIndex((c) => c.title === name) * 48 + 20 })
  fireEvent.pointerMove(window, { clientX: 30, clientY })
  fireEvent.pointerUp(window, { clientX: 30, clientY })
}

describe('ProjectRail', () => {
  it('reorders by drag, holding the dropped order until the snapshot agrees or the latest save fails', async () => {
    const fetch = mockFetch({ [ORDER]: undefined })
    const client = testQueryClient()
    const onSelect = vi.fn()
    const rail = (ids: string[]): JSX.Element => (
      <ProjectRail projects={ids.map(project)} ops={[]} activeProjectId="alpha" attentionByProject={{}} onSelect={onSelect} />
    )
    const { rerender } = renderWithClient(rail(NAMES), client)
    const snapshot = (ids: string[]): void => rerender(<QueryClientProvider client={client}>{rail(ids)}</QueryClientProvider>)
    stubLayout()

    // Above alpha's midpoint: gamma goes first.
    drag('gamma', 5)
    expect(shown()).toEqual(['gamma', 'alpha', 'beta'])
    await waitFor(() => expect(fetch.called(ORDER).map((c) => c.body)).toEqual([{ projectIds: ['gamma', 'alpha', 'beta'] }]))
    // A snapshot still in the old order does not undo the drop.
    snapshot(NAMES)
    expect(shown()).toEqual(['gamma', 'alpha', 'beta'])
    snapshot(['gamma', 'alpha', 'beta'])

    // Dropped in its own slot, nothing is saved, and the click the browser
    // fires on release does not select. A keyboard click does.
    drag('alpha', 50)
    fireEvent.click(screen.getByTitle('alpha'), { detail: 1 })
    expect(fetch.called(ORDER)).toHaveLength(1)
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTitle('alpha'), { detail: 0 })
    expect(onSelect).toHaveBeenCalledWith('alpha')

    // Two quick drops: the second save waits for the first, and the first
    // failing leaves the second drop's order in place.
    let failFirst = (): void => {}
    fetch.route(ORDER, () => fetch.called(ORDER).length === 2
      ? new Promise((resolve) => { failFirst = () => resolve(serverError('INTERNAL')) })
      : undefined)
    drag('alpha', 500)
    drag('gamma', 500)
    expect(shown()).toEqual(['beta', 'alpha', 'gamma'])
    await waitFor(() => expect(fetch.called(ORDER)).toHaveLength(2))
    failFirst()
    await waitFor(() => expect(fetch.called(ORDER)).toHaveLength(3))
    expect(fetch.called(ORDER)[2].body).toEqual({ projectIds: ['beta', 'alpha', 'gamma'] })
    expect(shown()).toEqual(['beta', 'alpha', 'gamma'])
    snapshot(['beta', 'alpha', 'gamma'])

    // The latest save failing puts the snapshot's order back.
    fetch.route(ORDER, serverError('INTERNAL'))
    drag('gamma', 5)
    expect(shown()).toEqual(['gamma', 'beta', 'alpha'])
    await waitFor(() => expect(shown()).toEqual(['beta', 'alpha', 'gamma']))
  })
})
