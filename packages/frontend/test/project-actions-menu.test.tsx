// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { ProjectActionsMenu } from '#components/ProjectActionsMenu'
import { useUiStore } from '#lib/store'
import { mockFetch, renderWithClient, type FetchMock } from './harness'

// jsdom has no ResizeObserver; Base UI's positioner needs one to exist.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

const REMOTE = 'https://github.com/acme/widgets.git'

const REMOVE = 'DELETE /api/project/widgets'
let server: FetchMock

beforeEach(() => {
  useUiStore.setState({ activeProjectSlug: 'widgets' })
  server = mockFetch({ [REMOVE]: undefined })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Render the menu and click through to the remove-confirm dialog. */
async function openConfirm(): Promise<void> {
  renderWithClient(<ProjectActionsMenu slug="widgets" remoteUrl={REMOTE} />)
  fireEvent.click(screen.getByRole('button', { name: 'widgets' }))
  fireEvent.click(await screen.findByText('Remove project'))
  await screen.findByText('Remove project?')
}

describe('ProjectActionsMenu', () => {
  it('requires typing the git URL before removal', async () => {
    await openConfirm()

    const remove = screen.getByRole<HTMLButtonElement>('button', { name: 'Remove' })
    expect(remove.disabled).toBe(true)
    fireEvent.click(remove)
    expect(server.called(REMOVE)).toHaveLength(0)

    fireEvent.change(screen.getByRole('textbox'), { target: { value: REMOTE } })
    expect(remove.disabled).toBe(false)
    fireEvent.click(remove)

    await waitFor(() => expect(server.called(REMOVE)).toHaveLength(1))
    await waitFor(() => expect(useUiStore.getState().activeProjectSlug).toBeNull())
  })

  it('does not remove on a wrong URL', async () => {
    await openConfirm()

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://github.com/acme/other.git' } })
    const remove = screen.getByRole<HTMLButtonElement>('button', { name: 'Remove' })
    expect(remove.disabled).toBe(true)
    fireEvent.click(remove)

    expect(server.called(REMOVE)).toHaveLength(0)
    expect(useUiStore.getState().activeProjectSlug).toBe('widgets')
  })
})
