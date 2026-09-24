// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import type { AuthListResult, GitCredentialSummary, ProjectSummary } from '@yaac/shared/types'
import { OPENCODE_PROVIDERS, PI_PROVIDERS } from '@yaac/shared/tool-providers'

vi.mock('#lib/settingsApi', () => ({
  getGitIdentity: vi.fn().mockResolvedValue({ name: 'Ada', email: 'ada@example.com' }),
  setGitIdentity: vi.fn().mockResolvedValue({ name: 'Ada', email: 'ada@example.com' }),
  getAuthList: vi.fn(),
  addHttpsCredential: vi.fn(),
  generateSshKey: vi.fn(),
  renameGitCredential: vi.fn().mockResolvedValue(undefined),
  deleteGitCredential: vi.fn().mockResolvedValue(undefined),
  replaceGitCredential: vi.fn(),
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
vi.mock('#lib/projectApi', () => ({ setProjectGitCredential: vi.fn() }))
const snapshot = vi.hoisted(() => vi.fn())
vi.mock('#lib/useSnapshot', () => ({ useSnapshot: snapshot }))

import { SettingsButton } from '#components/SettingsButton'
import { setProjectGitCredential } from '#lib/projectApi'
import {
  cancelToolLogin, clearToolAuth, deleteGitCredential, generateSshKey, getAuthList, renameGitCredential,
  replaceGitCredential, sendToolLoginInput, setToolApiKey, startToolInstall, startToolLogin,
} from '#lib/settingsApi'
import { useUiStore } from '#store'

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
    { tool: 'claude', kind: 'oauth', keyPreview: '***host', savedAt: '2026-01-01T00:00:00.000Z', models: [], defaultModel: 'claude-opus-5-5' },
  ],
}

beforeEach(() => {
  useUiStore.setState({
    settingsOpen: false, settingsSection: 'general', settingsFocusTool: null, settingsFocusProject: null,
  })
  vi.clearAllMocks()
  snapshot.mockReturnValue(undefined)
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
  // The rows render before the list lands; wait for it, so a row reads the
  // credential rather than the signed-out state it starts in.
  await waitFor(() => expect(vi.mocked(getAuthList)).toHaveBeenCalled())
  await vi.mocked(getAuthList).mock.results[0]?.value
  await new Promise((r) => setTimeout(r, 0))
}

/** The credential row containing the tool's name. */
function toolRow(tool: string): HTMLElement {
  const label = screen.getByText(new RegExp(`^${tool}`))
  const row = label.closest('div.rounded-md')
  if (!(row instanceof HTMLElement)) throw new Error(`no credential row for ${tool}`)
  return row
}

/** Drive the searchable provider picker: filter by label, then click the row. */
async function pickProvider(label: string): Promise<void> {
  fireEvent.change(screen.getByPlaceholderText('Search providers…'), { target: { value: label } })
  fireEvent.click(await screen.findByText(label))
}

const NEURALWATT_LABEL = OPENCODE_PROVIDERS.find((p) => p.id === 'neuralwatt')?.label ?? 'neuralwatt'
const PI_ANTHROPIC_LABEL = PI_PROVIDERS.find((p) => p.id === 'anthropic')?.label ?? 'anthropic'

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

    await pickProvider(NEURALWATT_LABEL)
    fireEvent.change(screen.getByPlaceholderText(`${NEURALWATT_LABEL} API key`), { target: { value: 'nw-key' } })
    fireEvent.submit(screen.getByPlaceholderText(`${NEURALWATT_LABEL} API key`).closest('form') as HTMLFormElement)

    await waitFor(() => expect(setToolApiKey).toHaveBeenCalledWith('opencode', 'nw-key', 'neuralwatt'))
  })

  it('saves a pi key with the picked provider (no web sign-in offered)', async () => {
    await openCredentials()

    fireEvent.click(within(toolRow('pi')).getByRole('button', { name: 'Sign in' }))
    expect(screen.queryByText(/Sign in with/)).toBeNull()

    // pi's provider picker is a searchable list; filter to and pick Anthropic.
    await pickProvider(PI_ANTHROPIC_LABEL)
    fireEvent.change(screen.getByPlaceholderText(`${PI_ANTHROPIC_LABEL} API key`), { target: { value: 'sk-ant-key' } })
    fireEvent.submit(screen.getByPlaceholderText(`${PI_ANTHROPIC_LABEL} API key`).closest('form') as HTMLFormElement)

    await waitFor(() => expect(setToolApiKey).toHaveBeenCalledWith('pi', 'sk-ant-key', 'anthropic'))
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

describe('Settings → Credentials → git', () => {
  const TOKEN: GitCredentialSummary = {
    id: 'c-token', name: 'alpha-token', kind: 'https', preview: '***abcd', projects: ['alpha'],
  }
  const KEY: GitCredentialSummary = {
    id: 'c-key', name: 'gitlab-key', kind: 'ssh', preview: 'ssh-ed25519 AAAAkey gitlab-key',
    publicKey: 'ssh-ed25519 AAAAkey gitlab-key', projects: [],
  }
  const project = (slug: string, remoteUrl: string, gitCredential: ProjectSummary['gitCredential']): ProjectSummary =>
    ({ slug, remoteUrl, addedAt: '', worktreeCount: 0, createDefaults: {}, gitCredential })
  const ALPHA = project('alpha', 'https://github.com/o/alpha.git', { id: 'c-token', name: 'alpha-token' })
  const BETA = project('beta', 'git@gitlab.com:o/beta.git', null)
  const GAMMA = project('gamma', 'https://github.com/o/gamma', null)

  /** A project's row — under its credential, or in the unassigned list. */
  const projectRow = (slug: string): HTMLElement =>
    document.querySelector(`[data-project="${slug}"]`) as HTMLElement
  const credentialRow = (name: string): HTMLElement =>
    screen.getByRole('button', { name }).closest('div.rounded-md') as HTMLElement
  const pickerOptions = (row: HTMLElement): string[] =>
    [...within(row).getByLabelText<HTMLSelectElement>('Git credential').options].map((o) => o.textContent ?? '')

  /** Open the row's confirmation, check a stray Enter cannot confirm it, and
   *  answer the dialog's description. */
  async function openConfirm(row: HTMLElement, action: string, confirmLabel: string): Promise<HTMLElement> {
    fireEvent.click(within(row).getByRole('button', { name: action }))
    const dialog = await screen.findByRole('alertdialog')
    const confirm = within(dialog).getByRole('button', { name: confirmLabel })
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' })))
    // The keypress that would activate the button is swallowed.
    expect(fireEvent.keyDown(confirm, { key: 'Enter' })).toBe(false)
    expect(fireEvent.keyDown(confirm, { key: ' ' })).toBe(false)
    return dialog
  }

  beforeEach(() => {
    vi.mocked(getAuthList).mockResolvedValue({ ...CLAUDE_CONFIGURED, gitCredentials: [TOKEN, KEY] })
    snapshot.mockReturnValue({ driver: 'k8s', projects: [ALPHA, BETA, GAMMA] })
  })

  it('lists credentials with their projects, and assigns one to a project that has none', async () => {
    // The server lists oldest first; an unused credential still sorts last.
    vi.mocked(getAuthList).mockResolvedValue({ ...CLAUDE_CONFIGURED, gitCredentials: [KEY, TOKEN] })
    await openCredentials()
    const token = await waitFor(() => credentialRow('alpha-token'))
    const key = credentialRow('gitlab-key')
    expect(token.compareDocumentPosition(key) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    expect(within(token).getByText('***abcd')).toBeTruthy()
    expect(within(token).getByText('alpha')).toBeTruthy()
    expect(within(token).queryByText('No assigned projects')).toBeNull()
    expect(within(key).getByText('No assigned projects')).toBeTruthy()
    // A key shows its public half, labelled, to copy — or to view whole.
    expect(within(key).getByText('Public key:')).toBeTruthy()
    expect(within(key).getByRole('button', { name: 'Copy' })).toBeTruthy()
    const shown = within(key).getByText('ssh-ed25519 AAAAkey gitlab-key')
    expect(shown.className).toContain('truncate')
    fireEvent.click(within(key).getByRole('button', { name: 'View' }))
    expect(shown.className).toContain('break-all')
    fireEvent.click(within(key).getByRole('button', { name: 'Hide' }))
    expect(shown.className).toContain('truncate')

    // The projects without one, at the bottom — each offered only what its
    // remote can use, a new one named for the project.
    expect(screen.getByText('Projects without git authentication')).toBeTruthy()
    expect(pickerOptions(projectRow('beta'))).toEqual(['Choose a git credential…', 'gitlab-key', 'New SSH key…'])
    expect(pickerOptions(projectRow('gamma')))
      .toEqual(['Choose a git credential…', 'alpha-token', 'New HTTPS token…'])
    fireEvent.change(within(projectRow('gamma')).getByLabelText('Git credential'), { target: { value: 'new' } })
    expect(within(projectRow('gamma')).getByLabelText<HTMLInputElement>('Credential name').value).toBe('gamma-token')

    // Assigning trusts the host's key, shown once beta sits under its credential.
    vi.mocked(setProjectGitCredential).mockResolvedValue('gitlab.com ssh-ed25519 HOSTKEY')
    vi.mocked(getAuthList).mockResolvedValue({
      ...CLAUDE_CONFIGURED, gitCredentials: [TOKEN, { ...KEY, projects: ['beta'] }],
    })
    snapshot.mockReturnValue({
      driver: 'k8s', projects: [ALPHA, { ...BETA, gitCredential: { id: 'c-key', name: 'gitlab-key' } }, GAMMA],
    })
    const beta = projectRow('beta')
    fireEvent.change(within(beta).getByLabelText('Git credential'), { target: { value: 'c-key' } })
    fireEvent.click(within(beta).getByRole('button', { name: 'Assign' }))

    await waitFor(() => expect(setProjectGitCredential).toHaveBeenCalledWith('beta', 'c-key'))
    await waitFor(() => expect(within(credentialRow('gitlab-key')).getByText('beta')).toBeTruthy())
    expect(within(projectRow('beta')).getByText('gitlab.com ssh-ed25519 HOSTKEY')).toBeTruthy()
  })

  it('renames inline, and deletes only on a click in a confirmation naming the projects left without', async () => {
    await openCredentials()
    await waitFor(() => credentialRow('gitlab-key'))

    fireEvent.click(screen.getByRole('button', { name: 'gitlab-key' }))
    const input = screen.getByLabelText<HTMLInputElement>('Rename credential')
    fireEvent.change(input, { target: { value: 'gitlab-deploy-key' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(renameGitCredential).toHaveBeenCalledWith('c-key', 'gitlab-deploy-key'))

    // Cancel leaves it be.
    let dialog = await openConfirm(credentialRow('alpha-token'), 'Delete', 'Delete')
    expect(within(dialog).getByText(/alpha will be left with no git credential/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

    // A credential in use deletes all the same, on the confirm's click.
    dialog = await openConfirm(credentialRow('alpha-token'), 'Delete', 'Delete')
    expect(deleteGitCredential).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(deleteGitCredential).toHaveBeenCalledWith('c-token'))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

    // Deleted, but the proxy was not told: the list is refetched (the row
    // is gone) and the warning outlives the row it came from.
    vi.mocked(deleteGitCredential).mockRejectedValueOnce(
      new Error('The credential is deleted, but the egress proxy could not be updated'),
    )
    const fetches = vi.mocked(getAuthList).mock.calls.length
    vi.mocked(getAuthList).mockResolvedValue({ ...CLAUDE_CONFIGURED, gitCredentials: [TOKEN] })
    dialog = await openConfirm(credentialRow('gitlab-key'), 'Delete', 'Delete')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText(/gitlab-key: The credential is deleted, but the egress proxy/)).toBeTruthy()
    await waitFor(() => expect(vi.mocked(getAuthList).mock.calls.length).toBeGreaterThan(fetches))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'gitlab-key' })).toBeNull())
  })

  it('replaces a token in place, and a key behind a confirmation, showing the new public key', async () => {
    vi.mocked(replaceGitCredential).mockResolvedValueOnce({ id: 'c-token2' })
    await openCredentials()
    await waitFor(() => credentialRow('alpha-token'))

    fireEvent.click(within(credentialRow('alpha-token')).getByRole('button', { name: 'Replace' }))
    fireEvent.change(screen.getByLabelText('New token'), { target: { value: 'ghp_new' } })
    fireEvent.click(within(credentialRow('alpha-token')).getByRole('button', { name: 'Replace' }))
    await waitFor(() => expect(replaceGitCredential).toHaveBeenCalledWith('c-token', 'ghp_new'))
    await waitFor(() => expect(screen.queryByLabelText('New token')).toBeNull())

    // Same name and projects, new id and public key.
    vi.mocked(replaceGitCredential).mockResolvedValueOnce({ id: 'c-key2', publicKey: 'ssh-ed25519 AAAAnew yaac gitlab-key' })
    const dialog = await openConfirm(credentialRow('gitlab-key'), 'Replace', 'Generate new key')
    expect(within(dialog).getByText(/current key is discarded/)).toBeTruthy()
    expect(replaceGitCredential).toHaveBeenCalledTimes(1)
    vi.mocked(getAuthList).mockResolvedValue({
      ...CLAUDE_CONFIGURED,
      gitCredentials: [TOKEN, { ...KEY, id: 'c-key2', publicKey: 'ssh-ed25519 AAAAnew yaac gitlab-key' }],
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Generate new key' }))

    await waitFor(() => expect(replaceGitCredential).toHaveBeenLastCalledWith('c-key', undefined))
    const key = await waitFor(() => {
      const row = credentialRow('gitlab-key')
      expect(within(row).getByText(/Register this public key with your git host/)).toBeTruthy()
      return row
    })
    expect(within(key).getByText('ssh-ed25519 AAAAnew yaac gitlab-key')).toBeTruthy()
    expect(within(key).getByRole('button', { name: 'Copy' })).toBeTruthy()
  })

  it('generates a key no project uses yet, showing its public half under a unique default name', async () => {
    vi.mocked(getAuthList).mockResolvedValue({
      ...CLAUDE_CONFIGURED, gitCredentials: [TOKEN, { ...KEY, name: 'git-key' }],
    })
    vi.mocked(generateSshKey).mockResolvedValue({ id: 'c-new', publicKey: 'ssh-ed25519 AAAAnew git-key-2' })
    await openCredentials()
    await waitFor(() => credentialRow('git-key'))

    fireEvent.change(screen.getByLabelText('Credential kind'), { target: { value: 'ssh' } })
    const name = screen.getByLabelText<HTMLInputElement>('Credential name')
    expect(name.value).toBe('git-key-2')
    fireEvent.click(screen.getByRole('button', { name: 'Generate key' }))

    await waitFor(() => expect(generateSshKey).toHaveBeenCalledWith('git-key-2'))
    expect(await screen.findByText('ssh-ed25519 AAAAnew git-key-2')).toBeTruthy()
    expect(screen.getByText(/Register this public key with your git host/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByText('ssh-ed25519 AAAAnew git-key-2')).toBeNull())
  })

  it('opens onto a focused project, its "Change" picker offering all but its current credential', async () => {
    useUiStore.getState().openSettings('credentials', undefined, 'alpha')
    renderSettings()

    // alpha has a credential, so its row under it opens on "Change".
    await waitFor(() => expect(within(projectRow('alpha')).getByRole('button', { name: 'Assign' })).toBeTruthy())
    expect(projectRow('alpha').className).toMatch(/ring-accent/)
    expect(projectRow('beta').className).not.toMatch(/ring-accent/)
    // alpha-token is its own and the only token, so only a new one is offered
    // — named past alpha-token, which stays taken.
    expect(pickerOptions(projectRow('alpha'))).toEqual(['New HTTPS token…'])
    expect(within(projectRow('alpha')).getByLabelText<HTMLInputElement>('Credential name').value)
      .toBe('alpha-token-2')
  })
})
