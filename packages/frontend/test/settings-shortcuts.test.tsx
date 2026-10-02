// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { SettingsButton } from '#components/SettingsButton'
import { useUiStore } from '#lib/store'
import { DEFAULT_BINDINGS, mergeBindings } from '#lib/shortcuts'
import { mockFetch, renderWithClient, serverError, type FetchMock } from './harness'

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
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Open the settings modal and switch to the Shortcuts section, against a
 *  server that accepts every shortcut save. */
function openShortcuts(): FetchMock {
  const server = mockFetch({
    'GET /api/config/git-identity': { identity: null },
    'GET /api/config/time-zone': { timeZone: null, pinned: false },
    'POST /api/shortcuts/set': { ok: true },
    'POST /api/shortcuts/reset': { ok: true },
  })
  renderWithClient(<SettingsButton />)
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
  fireEvent.click(screen.getByRole('button', { name: 'Shortcuts' }))
  return server
}

describe('Settings → Shortcuts', () => {
  it('lists every shortcut with its current chord', () => {
    openShortcuts()
    expect(screen.getByText('New workspace')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Alt+N' })).toBeTruthy()
    expect(screen.getByText('Stop workspace')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Alt+D' })).toBeTruthy()
  })

  it('records a new chord, updating the store and persisting it', async () => {
    const server = openShortcuts()
    fireEvent.click(screen.getByRole('button', { name: 'Alt+N' }))
    expect(screen.getByRole('button', { name: 'Press…' })).toBeTruthy()

    fireEvent.keyDown(window, { code: 'KeyY', altKey: true })

    const chord = { code: 'KeyY', alt: true, ctrl: false, meta: false, shift: false }
    await waitFor(() => expect(server.called('POST /api/shortcuts/set').map((c) => c.body))
      .toEqual([{ id: 'new-workspace', chord }]))
    expect(useUiStore.getState().bindings['new-workspace']).toEqual(chord)
    expect(screen.getByRole('button', { name: 'Alt+Y' })).toBeTruthy()
  })

  it('rejects a chord already bound to another command', () => {
    const server = openShortcuts()
    fireEvent.click(screen.getByRole('button', { name: 'Alt+N' }))
    // Alt+D is the default for delete-workspace (Stop workspace).
    fireEvent.keyDown(window, { code: 'KeyD', altKey: true })

    expect(screen.getByText(/Already bound to/)).toBeTruthy()
    expect(server.called('POST /api/shortcuts/set')).toEqual([])
    expect(useUiStore.getState().bindings['new-workspace']).toEqual(DEFAULT_BINDINGS['new-workspace'])
  })

  it('ignores a chord without a real modifier', () => {
    const server = openShortcuts()
    fireEvent.click(screen.getByRole('button', { name: 'Alt+N' }))
    fireEvent.keyDown(window, { code: 'KeyY' }) // no modifier

    expect(screen.getByText(/Hold Alt, Ctrl, or Cmd/)).toBeTruthy()
    expect(server.called('POST /api/shortcuts/set')).toEqual([])
  })

  it('refuses to reset a command whose default another command now holds', () => {
    useUiStore.setState({ bindings: mergeBindings({ 'new-workspace': DEFAULT_BINDINGS['new-shell'] }) })
    const server = openShortcuts()
    expect(screen.getByRole('button', { name: 'Unset' })).toBeTruthy()
    const resets = screen.getAllByRole('button', { name: 'Reset' })
    // new-workspace's row is first; new-shell's (unset) row is second.
    fireEvent.click(resets[1])
    expect(screen.getByText(/Already bound to “New workspace”/)).toBeTruthy()
    expect(server.called('POST /api/shortcuts/set')).toEqual([])
  })

  it('reset all restores defaults and clears overrides on the server', async () => {
    useUiStore.setState({
      bindings: { ...DEFAULT_BINDINGS, 'new-workspace': { code: 'KeyY', alt: true, ctrl: false, meta: false, shift: false } },
    })
    const server = openShortcuts()
    fireEvent.click(screen.getByRole('button', { name: /Reset all/ }))

    await waitFor(() => expect(server.called('POST /api/shortcuts/reset')).toHaveLength(1))
    expect(useUiStore.getState().bindings['new-workspace']).toEqual(DEFAULT_BINDINGS['new-workspace'])
  })

  it('says when a recorded chord was not saved', async () => {
    const server = openShortcuts()
    server.route('POST /api/shortcuts/set', serverError('INTERNAL', 'disk full'))
    fireEvent.click(screen.getByRole('button', { name: 'Alt+N' }))
    fireEvent.keyDown(window, { code: 'KeyY', altKey: true })

    await screen.findByText('Not saved: disk full')
    // The binding still applies on this page.
    expect(screen.getByRole('button', { name: 'Alt+Y' })).toBeTruthy()
  })
})
