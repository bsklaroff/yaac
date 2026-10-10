// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { ServerSettings } from '#components/settings/ServerSettings'
import { serverBridge, type YaacServerBridge } from '#lib/desktopServer'
import type { DesktopLocalState, DesktopServerTargets, DesktopSetupRun, Principal } from '@yaac/shared/types'

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

function installBridge(targets: DesktopServerTargets): Omit<YaacServerBridge, 'targets' | 'switchTo' | 'addRemote' | 'remove'> & {
  targets: ReturnType<typeof vi.fn>
  switchTo: ReturnType<typeof vi.fn>
  addRemote: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
} {
  const bridge = {
    targets: vi.fn().mockResolvedValue(targets),
    switchTo: vi.fn().mockResolvedValue({ ok: true }),
    addRemote: vi.fn().mockResolvedValue({ ok: true }),
    remove: vi.fn().mockResolvedValue({ ok: true }),
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

  it('removes a saved server only once confirmed, and offers no Remove on the connected one', async () => {
    const bridge = installBridge({ current: 'https://a.ts.net', saved: ['https://a.ts.net', 'https://b.ts.net'] })
    render(<ServerSettings />)
    await waitFor(() => expect(screen.getByText('https://b.ts.net')).toBeTruthy())
    expect(screen.queryByLabelText('Remove https://a.ts.net')).toBeNull()
    fireEvent.click(screen.getByLabelText('Remove https://b.ts.net'))
    await waitFor(() => expect(screen.getByText('Remove server?')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByText('Remove server?')).toBeNull())
    expect(bridge.remove).not.toHaveBeenCalled()
    bridge.targets.mockResolvedValue({ current: 'https://a.ts.net', saved: ['https://a.ts.net'] })
    fireEvent.click(screen.getByLabelText('Remove https://b.ts.net'))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(screen.queryByText('https://b.ts.net')).toBeNull())
    expect(bridge.remove).toHaveBeenCalledWith({ url: 'https://b.ts.net' })
    expect(screen.queryByText('Reconnecting…')).toBeNull()
  })

  it('surfaces a refused remove in the confirm dialog', async () => {
    const bridge = installBridge({ current: null, saved: ['https://a.ts.net'] })
    bridge.remove.mockResolvedValue({ ok: false, error: 'unknown server: https://a.ts.net' })
    render(<ServerSettings />)
    await waitFor(() => expect(screen.getByText('https://a.ts.net')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Remove https://a.ts.net'))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(screen.getByRole('alertdialog').textContent).toContain('unknown server: https://a.ts.net'))
    expect(bridge.remove).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.queryByText('unknown server: https://a.ts.net')).toBeNull()
    fireEvent.click(screen.getByLabelText('Remove https://a.ts.net'))
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy())
    expect(screen.queryByText('unknown server: https://a.ts.net')).toBeNull()
  })
})

describe('ServerSettings → This Mac', () => {
  const COMMANDS = {
    server: ['brew trust bsklaroff/yaac', 'brew install bsklaroff/yaac/yaac-server', 'yaac server start', 'yaac host check'],
    cluster: ['brew trust bsklaroff/yaac', 'yaac cluster install'],
  }
  function localState(over: Partial<DesktopLocalState> = {}): DesktopLocalState {
    return {
      cli: true,
      brew: true,
      installs: { server: 'running', cluster: 'missing' },
      busy: null,
      setup: null,
      choices: {
        server: { scope: 'server', commands: COMMANDS.server, blocked: null },
        cluster: { scope: 'cluster', commands: COMMANDS.cluster, blocked: null },
      },
      ...over,
    }
  }
  function installLocal(state: DesktopLocalState) {
    const bridge = installBridge({ current: null, saved: [] })
    const local = {
      localState: vi.fn().mockResolvedValue(state),
      startLocal: vi.fn().mockResolvedValue({ ok: true }),
      stopLocal: vi.fn().mockResolvedValue({ ok: true }),
      setupLocal: vi.fn().mockResolvedValue({ ok: true }),
      cancelSetup: vi.fn().mockResolvedValue({ ok: true }),
    }
    Object.assign(bridge, local)
    return local
  }

  it('is absent from an app without the local-server bridge', async () => {
    installBridge({ current: null, saved: [] })
    render(<ServerSettings />)
    await waitFor(() => expect(screen.getByText('No servers configured yet.')).toBeTruthy())
    expect(screen.queryByText('This Mac')).toBeNull()
  })

  it('shows each install\'s state and starts or stops it by scope', async () => {
    const local = installLocal(localState({ installs: { server: 'running', cluster: 'stopped' } }))
    render(<ServerSettings />)
    await waitFor(() => expect(screen.getByText('This Mac')).toBeTruthy())
    const row = (name: string) => screen.getByText(name).closest('div')!.parentElement!
    expect(row('Containerless server').textContent).toContain('Running')
    expect(row('Kubernetes cluster (kind)').textContent).toContain('Stopped')
    fireEvent.click(within(row('Containerless server')).getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(local.stopLocal).toHaveBeenCalledWith('server'))
    local.startLocal.mockResolvedValue({ ok: false, error: 'no Deployment yet' })
    fireEvent.click(within(row('Kubernetes cluster (kind)')).getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(screen.getByText('no Deployment yet')).toBeTruthy())
    expect(local.startLocal).toHaveBeenCalledWith('cluster')
  })

  it('sets up a missing install, follows its progress, and cancels it', async () => {
    const local = installLocal(localState())
    render(<ServerSettings />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Set up…' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Set up…' }))
    expect(screen.getByText(/gVisor-sandboxed pod/)).toBeTruthy()
    expect(screen.getByText(/brew trust bsklaroff\/yaac\s+yaac cluster install/)).toBeTruthy()

    const run: DesktopSetupRun = {
      scope: 'cluster',
      phase: 'running',
      steps: [
        { label: 'Trust the yaac tap', command: 'brew trust bsklaroff/yaac', state: 'skipped', note: 'already trusted' },
        { label: 'Install the cluster', command: 'yaac cluster install', state: 'running' },
      ],
      log: ['$ yaac cluster install', 'Creating the podman machine'],
    }
    local.localState.mockResolvedValue(localState({ busy: { scope: 'cluster', action: 'setup' }, setup: run }))
    fireEvent.click(screen.getByRole('button', { name: 'Run them for me' }))
    await waitFor(() => expect(local.setupLocal).toHaveBeenCalledWith('cluster'))
    const progress = await screen.findByLabelText('Setup progress')
    expect(progress.textContent).toContain('Setting up…')
    expect(progress.textContent).toContain('– Trust the yaac tap (already trusted)')
    expect(progress.textContent).toContain('Creating the podman machine')
    expect(screen.getByText('Running').closest('div')!.querySelector('button')!.hasAttribute('disabled')).toBe(true)

    local.localState.mockResolvedValue(localState({ setup: { ...run, phase: 'cancelled', error: 'setup cancelled' } }))
    fireEvent.click(within(progress).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.getByText('setup cancelled')).toBeTruthy())
    expect(local.cancelSetup).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('Setup progress').textContent).toContain('Setup cancelled')
  })

  it('says what a setup lacks: Homebrew, or an Apple silicon Mac', async () => {
    const state = localState({ cli: false, brew: false, installs: { server: 'missing', cluster: 'missing' } })
    state.choices.server.blocked = 'no-brew'
    state.choices.cluster.blocked = 'unsupported'
    installLocal(state)
    render(<ServerSettings />)
    await waitFor(() => expect(screen.getByText(/it needs macOS on Apple silicon/)).toBeTruthy())
    expect(screen.getAllByRole('button', { name: 'Set up…' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Set up…' }))
    expect(screen.getByRole('link', { name: 'brew.sh' }).getAttribute('href')).toBe('https://brew.sh')
    expect(screen.getByRole('button', { name: 'Run them for me' }).hasAttribute('disabled')).toBe(true)
  })
})
