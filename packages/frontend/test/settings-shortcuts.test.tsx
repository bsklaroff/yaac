// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

vi.mock('#lib/settingsApi', () => ({
  getGitIdentity: vi.fn().mockResolvedValue({ name: 'Ada', email: 'ada@example.com' }),
  setGitIdentity: vi.fn().mockResolvedValue({ name: 'Ada', email: 'ada@example.com' }),
  getAuthList: vi.fn().mockResolvedValue({ gitCredentials: [], toolAuth: [] }),
  addGitCredential: vi.fn().mockResolvedValue(undefined),
  setToolApiKey: vi.fn().mockResolvedValue(undefined),
  clearToolAuth: vi.fn().mockResolvedValue(undefined),
  startToolLogin: vi.fn(),
  getToolLogin: vi.fn(),
  sendToolLoginInput: vi.fn(),
  cancelToolLogin: vi.fn().mockResolvedValue(undefined),
  getShortcutOverrides: vi.fn().mockResolvedValue({}),
  setShortcutOverride: vi.fn().mockResolvedValue(undefined),
  resetShortcuts: vi.fn().mockResolvedValue(undefined),
}))

import { SettingsButton } from '#components/SettingsButton'
import { setShortcutOverride, resetShortcuts } from '#lib/settingsApi'
import { useUiStore } from '#store'
import { DEFAULT_BINDINGS, mergeBindings } from '#lib/shortcuts'

// jsdom has no ResizeObserver; Base UI's positioner needs one to exist.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

beforeEach(() => {
  useUiStore.setState({
    bindings: DEFAULT_BINDINGS,
    recordingShortcut: false,
    settingsOpen: false,
    settingsSection: 'general',
    settingsFocusTool: null,
  })
  vi.clearAllMocks()
})

afterEach(cleanup)

/** Open the settings modal and switch to the Shortcuts section. */
function openShortcuts(): void {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SettingsButton />
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
  fireEvent.click(screen.getByRole('button', { name: 'Shortcuts' }))
}

describe('Settings → Shortcuts', () => {
  it('lists every shortcut with its current chord', () => {
    openShortcuts()
    expect(screen.getByText('New worktree')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Alt+N' })).toBeTruthy()
    expect(screen.getByText('Stop worktree')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Alt+D' })).toBeTruthy()
  })

  it('records a new chord, updating the store and persisting it', async () => {
    openShortcuts()
    fireEvent.click(screen.getByRole('button', { name: 'Alt+N' }))
    expect(screen.getByRole('button', { name: 'Press…' })).toBeTruthy()

    fireEvent.keyDown(window, { code: 'KeyY', altKey: true })

    const chord = { code: 'KeyY', alt: true, ctrl: false, meta: false, shift: false }
    await waitFor(() => expect(setShortcutOverride).toHaveBeenCalledWith('new-worktree', chord))
    expect(useUiStore.getState().bindings['new-worktree']).toEqual(chord)
    expect(screen.getByRole('button', { name: 'Alt+Y' })).toBeTruthy()
  })

  it('rejects a chord already bound to another command', () => {
    openShortcuts()
    fireEvent.click(screen.getByRole('button', { name: 'Alt+N' }))
    // Alt+D is the delete-worktree default.
    fireEvent.keyDown(window, { code: 'KeyD', altKey: true })

    expect(screen.getByText(/Already bound to/)).toBeTruthy()
    expect(setShortcutOverride).not.toHaveBeenCalled()
    expect(useUiStore.getState().bindings['new-worktree']).toEqual(DEFAULT_BINDINGS['new-worktree'])
  })

  it('ignores a chord without a real modifier', () => {
    openShortcuts()
    fireEvent.click(screen.getByRole('button', { name: 'Alt+N' }))
    fireEvent.keyDown(window, { code: 'KeyY' }) // no modifier

    expect(screen.getByText(/Hold Alt, Ctrl, or Cmd/)).toBeTruthy()
    expect(setShortcutOverride).not.toHaveBeenCalled()
  })

  it('refuses to reset a command whose default another command now holds', () => {
    useUiStore.setState({ bindings: mergeBindings({ 'new-worktree': DEFAULT_BINDINGS['new-shell'] }) })
    openShortcuts()
    expect(screen.getByRole('button', { name: 'Unset' })).toBeTruthy()
    const resets = screen.getAllByRole('button', { name: 'Reset' })
    // new-worktree's row is first; new-shell's (unset) row is second.
    fireEvent.click(resets[1])
    expect(screen.getByText(/Already bound to “New worktree”/)).toBeTruthy()
    expect(setShortcutOverride).not.toHaveBeenCalled()
  })

  it('reset all restores defaults and clears overrides on the server', () => {
    useUiStore.setState({
      bindings: { ...DEFAULT_BINDINGS, 'new-worktree': { code: 'KeyY', alt: true, ctrl: false, meta: false, shift: false } },
    })
    openShortcuts()
    fireEvent.click(screen.getByRole('button', { name: /Reset all/ }))

    expect(resetShortcuts).toHaveBeenCalledTimes(1)
    expect(useUiStore.getState().bindings['new-worktree']).toEqual(DEFAULT_BINDINGS['new-worktree'])
  })
})
