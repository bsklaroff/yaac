// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import type { AuthListResult } from '@/shared/types'

vi.mock('@/frontend/lib/settingsApi', () => ({
  getDefaultTool: vi.fn().mockResolvedValue('claude'),
  getAuthList: vi.fn(),
  setDefaultTool: vi.fn().mockResolvedValue(undefined),
  addGitCredential: vi.fn().mockResolvedValue(undefined),
  setToolApiKey: vi.fn().mockResolvedValue(undefined),
  clearToolAuth: vi.fn().mockResolvedValue(undefined),
  startToolLogin: vi.fn(),
  getToolLogin: vi.fn(),
  sendToolLoginInput: vi.fn(),
  cancelToolLogin: vi.fn().mockResolvedValue(undefined),
  startToolInstall: vi.fn(),
  getToolInstall: vi.fn(),
  cancelToolInstall: vi.fn().mockResolvedValue(undefined),
  getShortcutOverrides: vi.fn().mockResolvedValue({}),
  setShortcutOverride: vi.fn().mockResolvedValue(undefined),
  resetShortcuts: vi.fn().mockResolvedValue(undefined),
}))

import { SettingsButton } from '@/frontend/components/SettingsButton'
import {
  cancelToolLogin, clearToolAuth, getAuthList, sendToolLoginInput, setToolApiKey,
  startToolInstall, startToolLogin,
} from '@/frontend/lib/settingsApi'
import { useUiStore } from '@/frontend/store'

// jsdom has no ResizeObserver; Base UI's positioner needs one to exist.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

const CLAUDE_CONFIGURED: AuthListResult = {
  gitCredentials: [],
  toolAuth: [
    { tool: 'claude', kind: 'oauth', keyPreview: '***host', savedAt: '2026-01-01T00:00:00.000Z' },
  ],
}

beforeEach(() => {
  useUiStore.setState({ settingsOpen: false, settingsSection: 'general', settingsFocusTool: null })
  vi.clearAllMocks()
  vi.mocked(getAuthList).mockResolvedValue(CLAUDE_CONFIGURED)
})

afterEach(cleanup)

function renderSettings(): void {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SettingsButton />
    </QueryClientProvider>,
  )
}

/** Open the settings modal onto the Credentials section and let the list load. */
async function openCredentials(): Promise<void> {
  renderSettings()
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
  fireEvent.click(screen.getByRole('button', { name: 'Credentials' }))
  await waitFor(() => expect(screen.getByText(/claude/)).toBeTruthy())
}

/** The credential row containing the tool's name. */
function toolRow(tool: string): HTMLElement {
  const label = screen.getByText(new RegExp(`^${tool}`))
  const row = label.closest('div.rounded-md')
  if (!(row instanceof HTMLElement)) throw new Error(`no credential row for ${tool}`)
  return row
}

describe('Settings → Credentials', () => {
  it('shows every tool: configured ones with a masked key, the rest with Sign in', async () => {
    await openCredentials()

    const claude = toolRow('claude')
    expect(within(claude).getByText('***host')).toBeTruthy()
    expect(within(claude).getByRole('button', { name: 'Sign out' })).toBeTruthy()

    expect(within(toolRow('codex')).getByRole('button', { name: 'Sign in' })).toBeTruthy()
    expect(within(toolRow('opencode')).getByRole('button', { name: 'Sign in' })).toBeTruthy()
  })

  it('saves a pasted codex API key and confirms in green', async () => {
    await openCredentials()

    fireEvent.click(within(toolRow('codex')).getByRole('button', { name: 'Sign in' }))
    fireEvent.change(screen.getByPlaceholderText('OpenAI API key'), { target: { value: 'sk-openai-x' } })
    fireEvent.submit(screen.getByPlaceholderText('OpenAI API key').closest('form') as HTMLFormElement)

    await waitFor(() => expect(setToolApiKey).toHaveBeenCalledWith('codex', 'sk-openai-x', undefined))
    expect(await screen.findByText('Signed in successfully.')).toBeTruthy()
  })

  it('saves an opencode key with the picked provider (no web sign-in offered)', async () => {
    await openCredentials()

    fireEvent.click(within(toolRow('opencode')).getByRole('button', { name: 'Sign in' }))
    expect(screen.queryByText(/Sign in with/)).toBeNull()

    fireEvent.click(screen.getByText('NeuralWatt'))
    fireEvent.change(screen.getByPlaceholderText('NeuralWatt API key'), { target: { value: 'nw-key' } })
    fireEvent.submit(screen.getByPlaceholderText('NeuralWatt API key').closest('form') as HTMLFormElement)

    await waitFor(() => expect(setToolApiKey).toHaveBeenCalledWith('opencode', 'nw-key', 'neuralwatt'))
  })

  it('signs a configured tool out', async () => {
    await openCredentials()

    fireEvent.click(within(toolRow('claude')).getByRole('button', { name: 'Sign out' }))

    await waitFor(() => expect(clearToolAuth).toHaveBeenCalledWith('claude'))
  })

  it('auto-expands the focus tool set by an external Sign in affordance', async () => {
    useUiStore.getState().openSettings('credentials', 'codex')
    renderSettings()

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeTruthy())
  })
})

describe('Settings → Credentials → web sign-in', () => {
  it('starting a codex sign-in shows the finish-in-browser panel with linked CLI output', async () => {
    vi.mocked(startToolLogin).mockResolvedValue({
      id: 'l1', tool: 'codex', status: 'running',
      output: 'If your browser did not open, navigate to this URL:\nhttps://auth.openai.com/oauth/authorize?state=x',
    })
    await openCredentials()

    fireEvent.click(within(toolRow('codex')).getByRole('button', { name: 'Sign in' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }))

    await waitFor(() => expect(startToolLogin).toHaveBeenCalledWith('codex'))
    expect(await screen.findByText(/Finish signing in from the browser window/)).toBeTruthy()
    // The CLI's printed URL renders as a clickable link…
    const link = screen.getByRole('link', { name: 'https://auth.openai.com/oauth/authorize?state=x' })
    expect(link.getAttribute('href')).toBe('https://auth.openai.com/oauth/authorize?state=x')
    // …and codex flows take no stdin.
    expect(screen.queryByPlaceholderText('paste code here if prompted')).toBeNull()
  })

  it('the claude panel forwards a pasted code to the CLI stdin', async () => {
    vi.mocked(getAuthList).mockResolvedValue({ gitCredentials: [], toolAuth: [] })
    vi.mocked(startToolLogin).mockResolvedValue({
      id: 'l4', tool: 'claude', status: 'running', output: 'If the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?state=x',
    })
    vi.mocked(sendToolLoginInput).mockResolvedValue({ id: 'l4', tool: 'claude', status: 'running' })
    await openCredentials()

    fireEvent.click(within(toolRow('claude')).getByRole('button', { name: 'Sign in' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Claude' }))

    const input = await screen.findByPlaceholderText('paste code here if prompted')
    fireEvent.change(input, { target: { value: 'code#state' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)

    await waitFor(() => expect(sendToolLoginInput).toHaveBeenCalledWith('l4', 'code#state'))
  })

  it('a rejected paste shows inline and keeps the flow running', async () => {
    vi.mocked(getAuthList).mockResolvedValue({ gitCredentials: [], toolAuth: [] })
    vi.mocked(startToolLogin).mockResolvedValue({
      id: 'l5', tool: 'claude', status: 'running', output: 'If the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?state=x',
    })
    vi.mocked(sendToolLoginInput).mockRejectedValue(
      new Error('Expected the code from the authorize page (letters, digits, "#", "-", "_" only).'))
    await openCredentials()

    fireEvent.click(within(toolRow('claude')).getByRole('button', { name: 'Sign in' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Claude' }))

    const input = await screen.findByPlaceholderText('paste code here if prompted')
    fireEvent.change(input, { target: { value: 'rm -rf /' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)

    await waitFor(() => expect(screen.getByText(/Expected the code from the authorize page/)).toBeTruthy())
    // Still in the running panel — the paste box and Cancel survive the rejection.
    expect(screen.getByPlaceholderText('paste code here if prompted')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('an immediately-successful claude sign-in refreshes the list and confirms in green', async () => {
    vi.mocked(getAuthList).mockResolvedValue({ gitCredentials: [], toolAuth: [] })
    vi.mocked(startToolLogin).mockResolvedValue({ id: 'l2', tool: 'claude', status: 'success' })
    await openCredentials()

    fireEvent.click(within(toolRow('claude')).getByRole('button', { name: 'Sign in' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Claude' }))

    // Success re-pulls the credentials list (the row flips to configured).
    await waitFor(() => expect(vi.mocked(getAuthList).mock.calls.length).toBeGreaterThan(1))
    expect(await screen.findByText('Signed in successfully.')).toBeTruthy()
  })

  it('shows a failed start inline and offers a retry, cancelling nothing', async () => {
    vi.mocked(startToolLogin).mockRejectedValue(new Error('codex CLI not found on the server host'))
    await openCredentials()

    fireEvent.click(within(toolRow('codex')).getByRole('button', { name: 'Sign in' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }))

    await waitFor(() => expect(screen.getByText('codex CLI not found on the server host')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeTruthy()
    expect(cancelToolLogin).not.toHaveBeenCalled()
  })

  it('cancel aborts a live flow server-side and returns to the start button', async () => {
    vi.mocked(startToolLogin).mockResolvedValue({ id: 'l3', tool: 'codex', status: 'running' })
    await openCredentials()

    fireEvent.click(within(toolRow('codex')).getByRole('button', { name: 'Sign in' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }))
    await screen.findByText(/Finish signing in from the browser window/)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(cancelToolLogin).toHaveBeenCalledWith('l3')
    expect(screen.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeTruthy()
  })
})

describe('Settings → Credentials → CLI install', () => {
  const CLI_MISSING = {
    id: 'l6', tool: 'codex', status: 'error',
    error: 'Codex is not installed on this machine.', cliMissing: true,
  } as const

  /** Drive a codex sign-in into the cliMissing state. */
  async function reachInstallOffer(): Promise<HTMLElement> {
    vi.mocked(getAuthList).mockResolvedValue({ gitCredentials: [], toolAuth: [] })
    vi.mocked(startToolLogin).mockResolvedValue(CLI_MISSING)
    await openCredentials()

    fireEvent.click(within(toolRow('codex')).getByRole('button', { name: 'Sign in' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }))
    return screen.findByRole('button', { name: 'Install Codex' })
  }

  it('a cliMissing failure offers Install instead of retry and starts the install', async () => {
    vi.mocked(startToolInstall).mockResolvedValue({
      id: 'i1', tool: 'codex', status: 'running', output: 'Downloading installer…',
    })
    const installButton = await reachInstallOffer()
    expect(screen.getByText(/isn't installed on this machine/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()

    fireEvent.click(installButton)
    await waitFor(() => expect(startToolInstall).toHaveBeenCalledWith('codex'))
    expect(await screen.findByText(/Installing Codex/)).toBeTruthy()
    expect(screen.getByText('Downloading installer…')).toBeTruthy()
  })

  it('a finished install returns to the sign-in button with a nudge', async () => {
    vi.mocked(startToolInstall).mockResolvedValue({ id: 'i2', tool: 'codex', status: 'success' })
    fireEvent.click(await reachInstallOffer())

    expect(await screen.findByText(/Codex installed — try signing in again/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeTruthy()
  })

  it('a failed install surfaces the error and offers a retry', async () => {
    vi.mocked(startToolInstall).mockResolvedValue({
      id: 'i3', tool: 'codex', status: 'error', error: 'install failed: no network',
    })
    fireEvent.click(await reachInstallOffer())

    expect(await screen.findByText('install failed: no network')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })
})
