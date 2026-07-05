// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

vi.mock('@/frontend/lib/settingsApi', () => ({
  getDefaultTool: vi.fn().mockResolvedValue('claude'),
  getAuthList: vi.fn().mockResolvedValue({ gitCredentials: [], toolAuth: [] }),
  setDefaultTool: vi.fn().mockResolvedValue(undefined),
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

import { SettingsButton } from '@/frontend/components/SettingsButton'
import { setShortcutOverride, resetShortcuts } from '@/frontend/lib/settingsApi'
import { useUiStore } from '@/frontend/store'
import { DEFAULT_BINDINGS } from '@/frontend/lib/shortcuts'

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
    expect(screen.getByText('New session')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Alt+N' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Alt+B' })).toBeTruthy()
  })

  it('records a new chord, updating the store and persisting it', async () => {
    openShortcuts()
    fireEvent.click(screen.getByRole('button', { name: 'Alt+N' }))
    expect(screen.getByRole('button', { name: 'Press…' })).toBeTruthy()

    fireEvent.keyDown(window, { code: 'KeyG', altKey: true })

    const chord = { code: 'KeyG', alt: true, ctrl: false, meta: false, shift: false }
    await waitFor(() => expect(setShortcutOverride).toHaveBeenCalledWith('new-session', chord))
    expect(useUiStore.getState().bindings['new-session']).toEqual(chord)
    expect(screen.getByRole('button', { name: 'Alt+G' })).toBeTruthy()
  })

  it('rejects a chord already bound to another command', () => {
    openShortcuts()
    fireEvent.click(screen.getByRole('button', { name: 'Alt+N' }))
    // Alt+D is the delete-session default.
    fireEvent.keyDown(window, { code: 'KeyD', altKey: true })

    expect(screen.getByText(/Already bound to/)).toBeTruthy()
    expect(setShortcutOverride).not.toHaveBeenCalled()
    expect(useUiStore.getState().bindings['new-session']).toEqual(DEFAULT_BINDINGS['new-session'])
  })

  it('ignores a chord without a real modifier', () => {
    openShortcuts()
    fireEvent.click(screen.getByRole('button', { name: 'Alt+N' }))
    fireEvent.keyDown(window, { code: 'KeyG' }) // no modifier

    expect(screen.getByText(/Hold Alt, Ctrl, or Cmd/)).toBeTruthy()
    expect(setShortcutOverride).not.toHaveBeenCalled()
  })

  it('reset all restores defaults and clears overrides on the server', () => {
    useUiStore.setState({
      bindings: { ...DEFAULT_BINDINGS, 'new-session': { code: 'KeyG', alt: true, ctrl: false, meta: false, shift: false } },
    })
    openShortcuts()
    fireEvent.click(screen.getByRole('button', { name: /Reset all/ }))

    expect(resetShortcuts).toHaveBeenCalledTimes(1)
    expect(useUiStore.getState().bindings['new-session']).toEqual(DEFAULT_BINDINGS['new-session'])
  })
})
