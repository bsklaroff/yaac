// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { ServerSettings } from '#components/settings/ServerSettings'
import { serverBridge, type YaacServerBridge } from '#lib/desktopServer'
import type { DesktopServerTargets } from '@yaac/shared/types'

afterEach(() => {
  cleanup()
  delete (window as unknown as { yaacServer?: unknown }).yaacServer
})

function installBridge(targets: DesktopServerTargets): YaacServerBridge & {
  switchTo: ReturnType<typeof vi.fn>
  addRemote: ReturnType<typeof vi.fn>
} {
  const bridge = {
    targets: vi.fn().mockResolvedValue(targets),
    switchTo: vi.fn().mockResolvedValue({ ok: true, changed: true }),
    addRemote: vi.fn().mockResolvedValue({ ok: true, changed: true }),
  }
  ;(window as unknown as { yaacServer?: unknown }).yaacServer = bridge
  return bridge
}

describe('serverBridge', () => {
  it('returns the preload bridge when present, undefined otherwise', () => {
    expect(serverBridge()).toBeUndefined()
    const bridge = installBridge({ current: { kind: 'local' }, saved: [] })
    expect(serverBridge()).toBe(bridge)
  })
})

describe('ServerSettings', () => {
  it('lists local + saved remotes and marks the current target', async () => {
    installBridge({
      current: { kind: 'remote', url: 'https://a.ts.net' },
      saved: ['https://a.ts.net', 'https://b.ts.net'],
    })
    render(<ServerSettings />)
    await waitFor(() => expect(screen.getByText('https://b.ts.net')).toBeTruthy())
    expect(screen.getByText('Local server')).toBeTruthy()
    const currentRow = screen.getByText('https://a.ts.net').closest('div')!
    expect(currentRow.textContent).toContain('Connected')
  })

  it('switching to a saved remote goes through the bridge', async () => {
    const bridge = installBridge({ current: { kind: 'local' }, saved: ['https://a.ts.net'] })
    render(<ServerSettings />)
    await waitFor(() => expect(screen.getByText('https://a.ts.net')).toBeTruthy())
    const row = screen.getByText('https://a.ts.net').closest('div')!
    fireEvent.click(row.querySelector('button')!)
    await waitFor(() => expect(bridge.switchTo).toHaveBeenCalledWith({ kind: 'remote', url: 'https://a.ts.net' }))
    await waitFor(() => expect(screen.getByText('Reconnecting…')).toBeTruthy())
  })

  it('surfaces a failed switch inline and stays put', async () => {
    const bridge = installBridge({ current: { kind: 'local' }, saved: ['https://a.ts.net'] })
    bridge.switchTo.mockResolvedValue({ ok: false, error: 'cannot reach https://a.ts.net' })
    render(<ServerSettings />)
    await waitFor(() => expect(screen.getByText('https://a.ts.net')).toBeTruthy())
    fireEvent.click(screen.getByText('https://a.ts.net').closest('div')!.querySelector('button')!)
    await waitFor(() => expect(screen.getByText('cannot reach https://a.ts.net')).toBeTruthy())
    expect(screen.queryByText('Reconnecting…')).toBeNull()
  })

  it('adds a new remote via the form', async () => {
    const bridge = installBridge({ current: { kind: 'local' }, saved: [] })
    render(<ServerSettings />)
    await waitFor(() => expect(screen.getByText('Local server')).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText('https://host.ts.net'), {
      target: { value: 'https://new.ts.net' },
    })
    fireEvent.change(screen.getByPlaceholderText('token'), { target: { value: 'tok' } })
    fireEvent.submit(screen.getByPlaceholderText('token').closest('form')!)
    await waitFor(() => expect(bridge.addRemote).toHaveBeenCalledWith('https://new.ts.net', 'tok'))
    await waitFor(() => expect(screen.getByText('Reconnecting…')).toBeTruthy())
  })

  it('surfaces a rejected add (bad token) inline', async () => {
    const bridge = installBridge({ current: { kind: 'local' }, saved: [] })
    bridge.addRemote.mockResolvedValue({ ok: false, error: 'token rejected by https://new.ts.net' })
    render(<ServerSettings />)
    await waitFor(() => expect(screen.getByText('Local server')).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText('https://host.ts.net'), {
      target: { value: 'https://new.ts.net' },
    })
    fireEvent.change(screen.getByPlaceholderText('token'), { target: { value: 'bad' } })
    fireEvent.submit(screen.getByPlaceholderText('token').closest('form')!)
    await waitFor(() => expect(screen.getByText('token rejected by https://new.ts.net')).toBeTruthy())
  })
})
