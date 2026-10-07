// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { ServerSettings } from '#components/settings/ServerSettings'
import { serverBridge, type YaacServerBridge } from '#lib/desktopServer'
import type { DesktopServerTargets, Principal } from '@yaac/shared/types'

/** What GET /whoami answers — the only request the section makes itself. */
function stubWhoami(principal: Principal): void {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ...principal, users: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))))
}

beforeEach(() => stubWhoami({ kind: 'local', userId: 'u1' }))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (window as unknown as { yaacServer?: unknown }).yaacServer
})

function installBridge(targets: DesktopServerTargets): Omit<YaacServerBridge, 'switchTo' | 'addRemote'> & {
  switchTo: ReturnType<typeof vi.fn>
  addRemote: ReturnType<typeof vi.fn>
} {
  const bridge = {
    targets: vi.fn().mockResolvedValue(targets),
    switchTo: vi.fn().mockResolvedValue({ ok: true }),
    addRemote: vi.fn().mockResolvedValue({ ok: true }),
  }
  ;(window as unknown as { yaacServer?: unknown }).yaacServer = bridge
  return bridge
}

describe('serverBridge', () => {
  it('returns the preload bridge when present, undefined otherwise', () => {
    expect(serverBridge()).toBeUndefined()
    const bridge = installBridge({ current: null, saved: [] })
    expect(serverBridge()).toBe(bridge)
  })
})

describe('ServerSettings', () => {
  it('lists the saved origins and marks the selected one — no local row', async () => {
    installBridge({
      current: 'https://a.ts.net',
      saved: ['https://a.ts.net', 'https://b.ts.net'],
    })
    render(<ServerSettings />)
    await waitFor(() => expect(screen.getByText('https://b.ts.net')).toBeTruthy())
    // A server on this machine appears as its own origin like any other,
    // registered by `yaac server start`; there is nothing else to pick.
    expect(screen.queryByText('Local server')).toBeNull()
    const currentRow = screen.getByText('https://a.ts.net').closest('div')!
    expect(currentRow.textContent).toContain('Connected')
  })

  it('says which tailnet user the server takes this device to be', async () => {
    stubWhoami({ kind: 'tailnet', userId: 'u1', login: 'alice@example.com', name: 'Alice' })
    installBridge({ current: 'https://a.ts.net', saved: ['https://a.ts.net'] })
    render(<ServerSettings />)
    await waitFor(() => expect(screen.getByText('Signed in as alice@example.com')).toBeTruthy())
  })

  it('says nothing about sign-in for a local caller', async () => {
    installBridge({ current: 'http://127.0.0.1:8787', saved: ['http://127.0.0.1:8787'] })
    render(<ServerSettings />)
    await waitFor(() => expect(screen.getByText('http://127.0.0.1:8787')).toBeTruthy())
    expect(screen.queryByText(/Signed in as/)).toBeNull()
  })

  it('says so when nothing is configured', async () => {
    installBridge({ current: null, saved: [] })
    render(<ServerSettings />)
    await waitFor(() => expect(screen.getByText('No servers configured yet.')).toBeTruthy())
  })

  it('offers Connect on every row when nothing is selected', async () => {
    installBridge({ current: null, saved: ['https://a.ts.net'] })
    render(<ServerSettings />)
    await waitFor(() => expect(screen.getByText('https://a.ts.net')).toBeTruthy())
    const row = screen.getByText('https://a.ts.net').closest('div')!
    expect(row.textContent).not.toContain('Connected')
    expect(row.querySelector('button')).toBeTruthy()
  })

  it('switching to a saved server goes through the bridge', async () => {
    const bridge = installBridge({ current: null, saved: ['https://a.ts.net'] })
    render(<ServerSettings />)
    await waitFor(() => expect(screen.getByText('https://a.ts.net')).toBeTruthy())
    const row = screen.getByText('https://a.ts.net').closest('div')!
    fireEvent.click(row.querySelector('button')!)
    await waitFor(() => expect(bridge.switchTo).toHaveBeenCalledWith({ url: 'https://a.ts.net' }))
    await waitFor(() => expect(screen.getByText('Reconnecting…')).toBeTruthy())
  })

  it('surfaces a failed switch inline and stays put', async () => {
    const bridge = installBridge({ current: null, saved: ['https://a.ts.net'] })
    bridge.switchTo.mockResolvedValue({ ok: false, error: 'cannot reach https://a.ts.net' })
    render(<ServerSettings />)
    await waitFor(() => expect(screen.getByText('https://a.ts.net')).toBeTruthy())
    fireEvent.click(screen.getByText('https://a.ts.net').closest('div')!.querySelector('button')!)
    await waitFor(() => expect(screen.getByText('cannot reach https://a.ts.net')).toBeTruthy())
    expect(screen.queryByText('Reconnecting…')).toBeNull()
  })

  it('adds a new server by its origin alone', async () => {
    const bridge = installBridge({ current: null, saved: [] })
    render(<ServerSettings />)
    await waitFor(() => expect(screen.getByText('No servers configured yet.')).toBeTruthy())
    const url = screen.getByPlaceholderText('https://host.ts.net')
    fireEvent.change(url, { target: { value: 'https://new.ts.net' } })
    expect(url.closest('form')!.querySelectorAll('input')).toHaveLength(1)
    fireEvent.submit(url.closest('form')!)
    await waitFor(() => expect(bridge.addRemote).toHaveBeenCalledWith('https://new.ts.net'))
    await waitFor(() => expect(screen.getByText('Reconnecting…')).toBeTruthy())
  })

  it('surfaces a rejected add (an unidentified device) inline', async () => {
    const bridge = installBridge({ current: null, saved: [] })
    const refusal = 'https://new.ts.net refused to identify this device: a tagged device'
    bridge.addRemote.mockResolvedValue({ ok: false, error: refusal })
    render(<ServerSettings />)
    await waitFor(() => expect(screen.getByText('No servers configured yet.')).toBeTruthy())
    const url = screen.getByPlaceholderText('https://host.ts.net')
    fireEvent.change(url, { target: { value: 'https://new.ts.net' } })
    fireEvent.submit(url.closest('form')!)
    await waitFor(() => expect(screen.getByText(refusal)).toBeTruthy())
  })
})
