// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

vi.mock('#lib/settingsApi', () => ({
  getGitIdentity: vi.fn().mockResolvedValue({ name: 'Ada', email: 'ada@example.com' }),
  setGitIdentity: vi.fn(),
  deviceTimeZone: () => 'America/New_York',
  getTimeZone: vi.fn(),
  setTimeZone: vi.fn(),
  getAuthList: vi.fn().mockResolvedValue({ gitCredentials: [], toolAuth: [] }),
  getShortcutOverrides: vi.fn().mockResolvedValue({}),
}))

import { SettingsButton } from '#components/SettingsButton'
import { getTimeZone, setTimeZone } from '#lib/settingsApi'
import { useUiStore } from '#lib/store'

// jsdom has no ResizeObserver; Base UI's positioner needs one to exist.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

beforeEach(() => {
  useUiStore.setState({ settingsOpen: false, settingsSection: 'general' })
  vi.clearAllMocks()
})

afterEach(cleanup)

async function openTimeZone(): Promise<HTMLSelectElement> {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SettingsButton />
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
  const select = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Time zone' })
  await waitFor(() => expect(select.disabled).toBe(false))
  return select
}

describe('Settings → General → Time zone', () => {
  it('shows the zone the last device reported as Automatic, and pins a picked one', async () => {
    vi.mocked(getTimeZone).mockResolvedValue({ timeZone: 'Europe/Paris', pinned: false })
    vi.mocked(setTimeZone).mockResolvedValue({ timeZone: 'Asia/Tokyo', pinned: true })
    const select = await openTimeZone()
    expect(select.value).toBe('')
    expect(screen.getByRole('option', { name: 'Automatic (Europe/Paris)' })).toBeTruthy()

    fireEvent.change(select, { target: { value: 'Asia/Tokyo' } })
    await waitFor(() => expect(select.value).toBe('Asia/Tokyo'))
    expect(setTimeZone).toHaveBeenCalledWith('Asia/Tokyo', true)
  })

  it('unpins to this device\'s zone when Automatic is picked', async () => {
    vi.mocked(getTimeZone).mockResolvedValue({ timeZone: 'Asia/Tokyo', pinned: true })
    vi.mocked(setTimeZone).mockResolvedValue({ timeZone: 'America/New_York', pinned: false })
    const select = await openTimeZone()
    expect(select.value).toBe('Asia/Tokyo')

    fireEvent.change(select, { target: { value: '' } })
    await waitFor(() => expect(select.value).toBe(''))
    expect(setTimeZone).toHaveBeenCalledWith('America/New_York', false)
  })
})
