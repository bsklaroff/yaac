// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { SettingsButton } from '#components/SettingsButton'
import { useUiStore } from '#lib/store'
import { deviceTimeZone } from '#lib/time'
import { mockFetch, renderWithClient, type FetchMock } from './harness'

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
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Serve the General pane with `stored` as the server's time zone setting;
 *  a PUT answers with what it was sent. */
function serve(stored: { timeZone: string; pinned: boolean }): FetchMock {
  return mockFetch({
    'GET /api/config/git-identity': { identity: { name: 'Ada', email: 'ada@example.com' } },
    'GET /api/config/time-zone': stored,
    'PUT /api/config/time-zone': ({ body }: { body: unknown }) => body,
  })
}

async function openTimeZone(): Promise<HTMLSelectElement> {
  renderWithClient(<SettingsButton />)
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
  const select = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Time zone' })
  await waitFor(() => expect(select.disabled).toBe(false))
  return select
}

describe('Settings → General → Time zone', () => {
  it('shows the zone the last device reported as Automatic, and pins a picked one', async () => {
    const server = serve({ timeZone: 'Europe/Paris', pinned: false })
    const select = await openTimeZone()
    expect(select.value).toBe('')
    expect(screen.getByRole('option', { name: 'Automatic (Europe/Paris)' })).toBeTruthy()

    fireEvent.change(select, { target: { value: 'Asia/Tokyo' } })
    await waitFor(() => expect(select.value).toBe('Asia/Tokyo'))
    expect(server.called('PUT /api/config/time-zone')[0].body).toEqual({ timeZone: 'Asia/Tokyo', pinned: true })
  })

  it('unpins to this device\'s zone when Automatic is picked', async () => {
    const server = serve({ timeZone: 'Asia/Tokyo', pinned: true })
    const select = await openTimeZone()
    expect(select.value).toBe('Asia/Tokyo')

    fireEvent.change(select, { target: { value: '' } })
    await waitFor(() => expect(select.value).toBe(''))
    expect(server.called('PUT /api/config/time-zone')[0].body).toEqual({ timeZone: deviceTimeZone(), pinned: false })
  })
})
