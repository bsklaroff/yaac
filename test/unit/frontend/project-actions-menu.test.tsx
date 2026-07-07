// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

vi.mock('@/frontend/lib/projectApi', () => ({
  removeProject: vi.fn(),
}))

import { ProjectActionsMenu } from '@/frontend/components/ProjectActionsMenu'
import { removeProject } from '@/frontend/lib/projectApi'
import { useUiStore } from '@/frontend/store'

// jsdom has no ResizeObserver; Base UI's positioner needs one to exist.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

const REMOTE = 'https://github.com/acme/widgets.git'

beforeEach(() => {
  useUiStore.setState({ activeProjectSlug: 'widgets' })
  vi.clearAllMocks()
  vi.mocked(removeProject).mockResolvedValue(undefined)
})

afterEach(cleanup)

/** Render the menu and click through to the remove-confirm dialog. */
async function openConfirm(): Promise<void> {
  render(<ProjectActionsMenu slug="widgets" remoteUrl={REMOTE} />)
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
    expect(removeProject).not.toHaveBeenCalled()

    fireEvent.change(screen.getByRole('textbox'), { target: { value: REMOTE } })
    expect(remove.disabled).toBe(false)
    fireEvent.click(remove)

    expect(removeProject).toHaveBeenCalledWith('widgets')
    await waitFor(() => expect(useUiStore.getState().activeProjectSlug).toBeNull())
  })

  it('does not remove on a wrong URL', async () => {
    await openConfirm()

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://github.com/acme/other.git' } })
    const remove = screen.getByRole<HTMLButtonElement>('button', { name: 'Remove' })
    expect(remove.disabled).toBe(true)
    fireEvent.click(remove)

    expect(removeProject).not.toHaveBeenCalled()
    expect(useUiStore.getState().activeProjectSlug).toBe('widgets')
  })
})
