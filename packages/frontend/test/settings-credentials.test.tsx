import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { QueryClient } from '@tanstack/react-query'
import { screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import type { AuthListResult, CustomEndpointSummary, GitCredentialSummary, ProjectSummary, ToolLoginView } from '@yaac/shared/types'
import { OPENCODE_PROVIDERS, PI_PROVIDERS } from '@yaac/shared/tool-providers'

const snapshot = vi.hoisted(() => vi.fn())
vi.mock('#lib/useSnapshot', () => ({ useSnapshot: snapshot }))

import { SettingsButton } from '#components/SettingsButton'
import { useUiStore } from '#lib/store'
import { AUTH_LIST_KEY } from '#lib/useAuthList'
import { mockFetch, renderWithClient, serverError, testQueryClient, TEST_USER_ID, type FetchMock } from './harness'

// jsdom has no ResizeObserver; Base UI's positioner needs one to exist.

const CLAUDE_CONFIGURED: AuthListResult = {
  gitCredentials: [],
  customEndpoints: [],
  toolAuth: [
    { tool: 'claude', kind: 'oauth', keyPreview: '***host', savedAt: '2026-01-01T00:00:00.000Z', models: [], defaultModel: 'claude-opus-5-5' },
  ],
}
/** A custom endpoint no tool uses yet. */
const LLAMA: CustomEndpointSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'llama',
  baseUrl: 'http://box.tail1234.ts.net:8080/v1',
  keyPreview: '',
  models: [{ id: 'qwen3', efforts: { levels: ['low', 'medium', 'high'], default: 'medium' } }, { id: 'gemma' }],
  tools: [],
}
const SIGNED_OUT: AuthListResult = { gitCredentials: [], toolAuth: [], customEndpoints: [] }

/** What GET /api/auth/list answers; a test reassigns it to change the list. */
let authList: AuthListResult
let server: FetchMock
let client: QueryClient

beforeEach(() => {
  useUiStore.setState({
    settingsOpen: false, settingsSection: 'general', settingsFocusTool: null, settingsFocusProject: null,
  })
  snapshot.mockReturnValue(undefined)
  authList = CLAUDE_CONFIGURED
  server = mockFetch({
    'GET /api/auth/list': () => authList,
    'GET /api/config/git-identity': { identity: { name: 'Ada', email: 'ada@example.com' } },
    'GET /api/config/time-zone': { timeZone: 'America/New_York', pinned: false },
    'PUT /api/auth/codex': undefined,
    'PUT /api/auth/opencode': undefined,
    'PUT /api/auth/pi': undefined,
    'POST /api/auth/clear': undefined,
  })
})


function renderSettings(): void {
  client = testQueryClient()
  renderWithClient(<SettingsButton />, client)
}

/** Open the settings modal onto the Credentials section and let the list
 *  load, so rows show credentials rather than signed out. */
async function openCredentials(): Promise<void> {
  renderSettings()
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
  fireEvent.click(screen.getByRole('button', { name: 'Credentials' }))
  await waitFor(() => expect(client.getQueryState(AUTH_LIST_KEY)?.fetchStatus).toBe('idle'))
  await waitFor(() => expect(client.getQueryData(AUTH_LIST_KEY)).toBeDefined())
  await act(() => new Promise((r) => setTimeout(r, 0)))
}

/** Answer a tool's sign-in start with `view`, and its poll with the same. */
function serveLogin(tool: string, view: ToolLoginView): void {
  server.route(`POST /api/auth/${tool}/login/start`, view)
  server.route(`GET /api/auth/login/${view.id}`, view)
}

/** The credential row containing the tool's name. */
function toolRow(tool: string): HTMLElement {
  // A span, since the endpoints' tool switches also start with the name.
  const label = screen.getAllByText(new RegExp(`^${tool}`)).find((el) => el.tagName === 'SPAN')
  const row = label?.closest('div.rounded-md')
  if (!(row instanceof HTMLElement)) throw new Error(`no credential row for ${tool}`)
  return row
}

/** Drive the searchable provider picker: filter by label, then click the row. */
async function pickProvider(label: string): Promise<void> {
  fireEvent.change(screen.getByPlaceholderText('Search providers…'), { target: { value: label } })
  fireEvent.click(await screen.findByText(label))
}

/** Requests to any sign-in or install cancel route. */
const cancels = (): unknown[] => server.calls.filter((c) => c.path.endsWith('/cancel'))

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

    expect(await screen.findByText('Signed in successfully.')).toBeTruthy()
    expect(server.called('PUT /api/auth/codex').map((c) => c.body))
      .toEqual([{ kind: 'api-key', apiKey: 'sk-openai-x' }])
  })

  it('saves an opencode key with the picked provider (no web sign-in offered)', async () => {
    await openCredentials()

    fireEvent.click(within(toolRow('opencode')).getByRole('button', { name: 'Sign in' }))
    expect(screen.queryByText(/Sign in with/)).toBeNull()

    await pickProvider(NEURALWATT_LABEL)
    fireEvent.change(screen.getByPlaceholderText(`${NEURALWATT_LABEL} API key`), { target: { value: 'nw-key' } })
    fireEvent.submit(screen.getByPlaceholderText(`${NEURALWATT_LABEL} API key`).closest('form') as HTMLFormElement)

    await waitFor(() => expect(server.called('PUT /api/auth/opencode').map((c) => c.body))
      .toEqual([{ kind: 'api-key', apiKey: 'nw-key', provider: 'neuralwatt' }]))
  })

  it('signs pi in with a custom endpoint picked by name, and names it once signed in', async () => {
    authList = { ...CLAUDE_CONFIGURED, customEndpoints: [LLAMA] }
    await openCredentials()

    fireEvent.click(within(toolRow('pi')).getByRole('button', { name: 'Sign in' }))
    await pickProvider('Custom (OpenAI-compatible)')
    expect(screen.queryByPlaceholderText(/API key/)).toBeNull()
    authList = {
      ...CLAUDE_CONFIGURED,
      customEndpoints: [{ ...LLAMA, tools: ['pi'] }],
      toolAuth: [{
        tool: 'pi', kind: 'api-key', keyPreview: '', savedAt: 'x', piProvider: 'custom',
        endpoint: { id: LLAMA.id, name: 'llama', baseUrl: LLAMA.baseUrl },
        models: [], defaultModel: 'custom/qwen3',
      }],
    }
    fireEvent.submit(screen.getByLabelText('Custom endpoint').closest('form') as HTMLFormElement)

    await waitFor(() => expect(server.called('PUT /api/auth/pi').map((c) => c.body)).toEqual([{
      kind: 'api-key', apiKey: '', provider: 'custom', endpointId: LLAMA.id,
    }]))
    expect(await within(toolRow('pi')).findByText('pi · custom · llama')).toBeTruthy()
    expect(within(toolRow('pi')).getByText(LLAMA.baseUrl)).toBeTruthy()
  })

  it('points a custom sign-in with no endpoints yet at the endpoints section', async () => {
    await openCredentials()
    fireEvent.click(within(toolRow('omp')).getByRole('button', { name: 'Sign in' }))
    await pickProvider('Custom (OpenAI-compatible)')
    expect(screen.getByText(/Add a custom endpoint under "Custom endpoints" below/)).toBeTruthy()
  })

  it('saves a pi key with the picked provider (no web sign-in offered)', async () => {
    await openCredentials()

    fireEvent.click(within(toolRow('pi')).getByRole('button', { name: 'Sign in' }))
    expect(screen.queryByText(/Sign in with/)).toBeNull()

    // pi's provider picker is a searchable list; filter to and pick Anthropic.
    await pickProvider(PI_ANTHROPIC_LABEL)
    fireEvent.change(screen.getByPlaceholderText(`${PI_ANTHROPIC_LABEL} API key`), { target: { value: 'sk-ant-key' } })
    fireEvent.submit(screen.getByPlaceholderText(`${PI_ANTHROPIC_LABEL} API key`).closest('form') as HTMLFormElement)

    await waitFor(() => expect(server.called('PUT /api/auth/pi').map((c) => c.body))
      .toEqual([{ kind: 'api-key', apiKey: 'sk-ant-key', provider: 'anthropic' }]))
  })

  it('signs a configured tool out', async () => {
    await openCredentials()

    fireEvent.click(within(toolRow('claude')).getByRole('button', { name: 'Sign out' }))

    await waitFor(() => expect(server.called('POST /api/auth/clear').map((c) => c.body))
      .toEqual([{ service: 'claude' }]))
  })

  it('auto-expands the focus tool set by an external Sign in affordance', async () => {
    useUiStore.getState().openSettings('credentials', 'codex')
    renderSettings()

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeTruthy())
  })
})

describe('Settings → Credentials → web sign-in', () => {
  it('starting a codex sign-in shows the finish-in-browser panel, then polls until it succeeds', async () => {
    serveLogin('codex', {
      id: 'l1', tool: 'codex', status: 'running',
      output: 'If your browser did not open, navigate to this URL:\nhttps://auth.openai.com/oauth/authorize?state=x',
    })
    await openCredentials()

    fireEvent.click(within(toolRow('codex')).getByRole('button', { name: 'Sign in' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }))

    expect(await screen.findByText(/Finish signing in from the browser window/)).toBeTruthy()
    expect(server.called('POST /api/auth/codex/login/start')).toHaveLength(1)
    // The CLI's printed URL renders as a clickable link…
    const link = screen.getByRole('link', { name: 'https://auth.openai.com/oauth/authorize?state=x' })
    expect(link.getAttribute('href')).toBe('https://auth.openai.com/oauth/authorize?state=x')
    // …and codex flows take no stdin.
    expect(screen.queryByPlaceholderText('paste code here if prompted')).toBeNull()

    // The next poll (every 1.5s) sees the browser flow finish.
    server.route('GET /api/auth/login/l1', { id: 'l1', tool: 'codex', status: 'success' })
    expect(await screen.findByText('Signed in successfully.', {}, { timeout: 8000 })).toBeTruthy()
    expect(server.called('GET /api/auth/login/l1').length).toBeGreaterThan(1)
  }, 15_000)

  it('the claude panel forwards a pasted code to the CLI stdin, and shows a rejected one inline', async () => {
    authList = SIGNED_OUT
    serveLogin('claude', {
      id: 'l4', tool: 'claude', status: 'running', output: 'If the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?state=x',
    })
    server.route('POST /api/auth/login/l4/input', ({ body }: { body: unknown }) =>
      ((body as { text: string }).text === 'code#state'
        ? { id: 'l4', tool: 'claude', status: 'running' }
        : serverError('VALIDATION', 'Expected the code from the authorize page (letters, digits, "#", "-", "_" only).', 400)))
    await openCredentials()

    fireEvent.click(within(toolRow('claude')).getByRole('button', { name: 'Sign in' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Claude' }))

    const input = await screen.findByPlaceholderText('paste code here if prompted')
    fireEvent.change(input, { target: { value: 'rm -rf /' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)

    await waitFor(() => expect(screen.getByText(/Expected the code from the authorize page/)).toBeTruthy())
    // After the rejection the paste box and Cancel are still shown.
    expect(screen.getByPlaceholderText('paste code here if prompted')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()

    fireEvent.change(input, { target: { value: 'code#state' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    await waitFor(() => expect(server.called('POST /api/auth/login/l4/input').map((c) => c.body))
      .toEqual([{ text: 'rm -rf /' }, { text: 'code#state' }]))
  })

  it('an immediately-successful claude sign-in refreshes the list and confirms in green', async () => {
    authList = SIGNED_OUT
    serveLogin('claude', { id: 'l2', tool: 'claude', status: 'success' })
    await openCredentials()
    const fetches = server.called('GET /api/auth/list').length

    fireEvent.click(within(toolRow('claude')).getByRole('button', { name: 'Sign in' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Claude' }))

    // Success refetches the credentials list.
    await waitFor(() => expect(server.called('GET /api/auth/list').length).toBeGreaterThan(fetches))
    expect(await screen.findByText('Signed in successfully.')).toBeTruthy()
  })

  it('shows a failed start inline and offers a retry, cancelling nothing', async () => {
    server.route('POST /api/auth/codex/login/start', serverError('AUTH_AGENT_OFFLINE', 'codex CLI not found on the server host'))
    await openCredentials()

    fireEvent.click(within(toolRow('codex')).getByRole('button', { name: 'Sign in' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }))

    await waitFor(() => expect(screen.getByText('codex CLI not found on the server host')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeTruthy()
    expect(cancels()).toEqual([])
  })

  it('cancel aborts a live flow server-side and returns to the start button, reporting a failed abort', async () => {
    serveLogin('codex', { id: 'l3', tool: 'codex', status: 'running' })
    server.route('POST /api/auth/login/l3/cancel', undefined)
    await openCredentials()

    fireEvent.click(within(toolRow('codex')).getByRole('button', { name: 'Sign in' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }))
    await screen.findByText(/Finish signing in from the browser window/)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeTruthy()
    await waitFor(() => expect(server.called('POST /api/auth/login/l3/cancel')).toHaveLength(1))

    // A second flow whose abort the server refuses: the panel still resets,
    // and the failure shows beside the start button.
    serveLogin('codex', { id: 'l7', tool: 'codex', status: 'running' })
    server.route('POST /api/auth/login/l7/cancel', serverError('INTERNAL', 'auth server gone'))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }))
    await screen.findByText(/Finish signing in from the browser window/)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText('Cancel failed: auth server gone')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeTruthy()
  })
})

describe('Settings → Credentials → CLI install', () => {
  /** Drive a codex sign-in into the cliMissing state. */
  async function reachInstallOffer(): Promise<HTMLElement> {
    authList = SIGNED_OUT
    serveLogin('codex', {
      id: 'l6', tool: 'codex', status: 'error',
      error: 'Codex is not installed on this machine.', cliMissing: true,
    })
    await openCredentials()

    fireEvent.click(within(toolRow('codex')).getByRole('button', { name: 'Sign in' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }))
    return screen.findByRole('button', { name: 'Install Codex' })
  }

  it('a cliMissing failure offers Install instead of retry and starts the install', async () => {
    const running = { id: 'i1', tool: 'codex', status: 'running', output: 'Downloading installer…' } as const
    server.route('POST /api/auth/codex/install/start', running)
    server.route('GET /api/auth/install/i1', running)
    const installButton = await reachInstallOffer()
    expect(screen.getByText(/isn't installed on this machine/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()

    fireEvent.click(installButton)
    expect(await screen.findByText(/Installing Codex/)).toBeTruthy()
    expect(server.called('POST /api/auth/codex/install/start')).toHaveLength(1)
    expect(screen.getByText('Downloading installer…')).toBeTruthy()
  })

  it('a finished install returns to the sign-in button with a nudge', async () => {
    server.route('POST /api/auth/codex/install/start', { id: 'i2', tool: 'codex', status: 'success' })
    fireEvent.click(await reachInstallOffer())

    expect(await screen.findByText(/Codex installed — try signing in again/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeTruthy()
  })

  it('a failed install surfaces the error and offers a retry', async () => {
    server.route('POST /api/auth/codex/install/start', {
      id: 'i3', tool: 'codex', status: 'error', error: 'install failed: no network',
    })
    fireEvent.click(await reachInstallOffer())

    expect(await screen.findByText('install failed: no network')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })
})

describe('Settings → Credentials → git', () => {
  const TOKEN: GitCredentialSummary = {
    id: 'c-token', name: 'alpha-token', kind: 'https', preview: '***abcd', projects: ['id-alpha'],
  }
  const KEY: GitCredentialSummary = {
    id: 'c-key', name: 'gitlab-key', kind: 'ssh', preview: 'ssh-ed25519 AAAAkey gitlab-key',
    publicKey: 'ssh-ed25519 AAAAkey gitlab-key', projects: [],
  }
  /** A project keyed by `id-<name>`, so the rows show the name, not the key. */
  const project = (name: string, remoteUrl: string, gitCredential: ProjectSummary['gitCredential']): ProjectSummary =>
    ({ id: `id-${name}`, name, remoteUrl, addedAt: '', owner: TEST_USER_ID, workspaceCount: 0, stoppedCount: 0, deaths: 0, deathsSeenBy: {}, createDefaults: {}, gitCredential, hosted: false, guardDefaultBranch: true, scratchDirs: { dirs: [], ignoredTracked: [] }, initSteps: {}, portForwards: [], cacheVolumes: {}, nestedContainers: false, npmCache: true })
  const ALPHA = project('alpha', 'https://github.com/o/alpha.git', { id: 'c-token', name: 'alpha-token' })
  const BETA = project('beta', 'git@gitlab.com:o/beta.git', null)
  const GAMMA = project('gamma', 'https://github.com/o/gamma', null)
  // yaac hosts its remote, so it needs no credential.
  const DELTA = { ...project('delta', 'http://yaac.internal/api/workspace/git/id-delta.git', null), hosted: true }

  const projectRow = (name: string): HTMLElement =>
    document.querySelector(`[data-project="id-${name}"]`) as HTMLElement
  /** An unused credential's row. */
  const unusedRow = (id: string): HTMLElement =>
    document.querySelector(`[data-credential="${id}"]`) as HTMLElement
  const editor = (): HTMLElement => document.querySelector('[data-credential-editor]') as HTMLElement
  const pickerOptions = (row: HTMLElement): string[] =>
    [...within(row).getByLabelText<HTMLSelectElement>('Git credential').options].map((o) => o.textContent ?? '')
  /** Every row of the list, in order, by project name or credential id. */
  const rowOrder = (): string[] => [...document.querySelectorAll('[data-project], [data-credential]')]
    .map((el) => (el as HTMLElement).dataset.project ?? (el as HTMLElement).dataset.credential ?? '')

  /** Open the editor's confirmation, check a stray Enter can't confirm it,
   *  and return the dialog. */
  async function openConfirm(action: string, confirmLabel: string): Promise<HTMLElement> {
    fireEvent.click(within(editor()).getByRole('button', { name: action }))
    const dialog = await screen.findByRole('alertdialog')
    const confirm = within(dialog).getByRole('button', { name: confirmLabel })
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' })))
    // The keypress that would activate the button is swallowed.
    expect(fireEvent.keyDown(confirm, { key: 'Enter' })).toBe(false)
    expect(fireEvent.keyDown(confirm, { key: ' ' })).toBe(false)
    return dialog
  }

  beforeEach(() => {
    authList = { ...CLAUDE_CONFIGURED, gitCredentials: [TOKEN, KEY] }
    snapshot.mockReturnValue({ driver: 'k8s', projects: [ALPHA, BETA, GAMMA, DELTA] })
  })

  it('lists projects without a credential first, then the rest with theirs, then unused credentials', async () => {
    // The server lists oldest first; an unused credential still sorts last.
    authList = { ...CLAUDE_CONFIGURED, gitCredentials: [KEY, TOKEN] }
    await openCredentials()
    await waitFor(() => expect(projectRow('alpha')).toBeTruthy())
    expect(rowOrder()).toEqual(['id-beta', 'id-gamma', 'id-alpha', 'id-delta', 'c-key'])

    expect(within(projectRow('alpha')).getByText('alpha-token')).toBeTruthy()
    expect(within(projectRow('alpha')).getByText('***abcd')).toBeTruthy()
    expect(within(projectRow('delta')).getByText('hosted, no credential needed')).toBeTruthy()
    expect(within(projectRow('delta')).queryByRole('button')).toBeNull()
    expect(within(unusedRow('c-key')).getByText('gitlab-key')).toBeTruthy()
    // An SSH key's public half is shown in its editor.
    expect(within(unusedRow('c-key')).queryByText('Public key:')).toBeNull()
    fireEvent.click(within(unusedRow('c-key')).getByRole('button', { name: 'Edit credential' }))
    expect(within(editor()).getByText('No project uses this credential.')).toBeTruthy()
    expect(within(editor()).getByText('Public key:')).toBeTruthy()
    const shown = within(editor()).getByText('ssh-ed25519 AAAAkey gitlab-key')
    expect(shown.className).toContain('truncate')
    fireEvent.click(within(editor()).getByRole('button', { name: 'View' }))
    expect(shown.className).toContain('break-all')

    // Projects without a credential are each offered only what their remote
    // can use, with a new one named for the project.
    expect(pickerOptions(projectRow('beta'))).toEqual(['Choose a git credential…', 'gitlab-key', 'New SSH key…'])
    expect(pickerOptions(projectRow('gamma')))
      .toEqual(['Choose a git credential…', 'alpha-token', 'New HTTPS token…'])
    fireEvent.change(within(projectRow('gamma')).getByLabelText('Git credential'), { target: { value: 'new' } })
    expect(within(projectRow('gamma')).getByLabelText<HTMLInputElement>('Credential name').value).toBe('gamma-token')

    // Assigning trusts the host key, which is shown on the project's row,
    // and the project moves among those with a credential.
    server.route('PUT /api/project/id-beta/git-credential', { knownHostsEntry: 'gitlab.com ssh-ed25519 HOSTKEY' })
    authList = { ...CLAUDE_CONFIGURED, gitCredentials: [TOKEN, { ...KEY, projects: ['id-beta'] }] }
    snapshot.mockReturnValue({
      driver: 'k8s', projects: [ALPHA, { ...BETA, gitCredential: { id: 'c-key', name: 'gitlab-key' } }, GAMMA, DELTA],
    })
    const beta = projectRow('beta')
    fireEvent.change(within(beta).getByLabelText('Git credential'), { target: { value: 'c-key' } })
    fireEvent.click(within(beta).getByRole('button', { name: 'Assign' }))

    await waitFor(() => expect(rowOrder()).toEqual(['id-gamma', 'id-alpha', 'id-beta', 'id-delta']))
    expect(server.called('PUT /api/project/id-beta/git-credential').map((c) => c.body)).toEqual([{ credentialId: 'c-key' }])
    expect(within(projectRow('beta')).getByText('gitlab-key')).toBeTruthy()
    expect(within(projectRow('beta')).getByText('gitlab.com ssh-ed25519 HOSTKEY')).toBeTruthy()
  })

  it('edits a shared credential from any of its rows under a banner naming every project, deleting only on a confirming click', async () => {
    const shared = { ...TOKEN, projects: ['id-alpha', 'id-gamma'] }
    authList = { ...CLAUDE_CONFIGURED, gitCredentials: [shared, KEY] }
    snapshot.mockReturnValue({
      driver: 'k8s', projects: [ALPHA, BETA, { ...GAMMA, gitCredential: { id: 'c-token', name: 'alpha-token' } }],
    })
    server.route('PATCH /api/auth/git/credentials/c-token', undefined)
    server.route('DELETE /api/auth/git/credentials/c-token', undefined)
    await openCredentials()
    await waitFor(() => expect(projectRow('gamma')).toBeTruthy())

    // Opened from gamma's row, the banner still names alpha.
    fireEvent.click(within(projectRow('gamma')).getByRole('button', { name: 'Edit credential' }))
    expect(projectRow('gamma').contains(editor())).toBe(true)
    expect(within(editor()).getByRole('note').textContent)
      .toBe('Used by alpha and gamma. Changes here apply to all of them.')

    // A rename needs no confirmation: the banner is the warning.
    fireEvent.click(within(editor()).getByRole('button', { name: 'alpha-token' }))
    const input = screen.getByLabelText<HTMLInputElement>('Rename credential')
    fireEvent.change(input, { target: { value: 'github-token' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(server.called('PATCH /api/auth/git/credentials/c-token').map((c) => c.body))
      .toEqual([{ name: 'github-token' }]))
    expect(screen.queryByRole('alertdialog')).toBeNull()

    // Only one editor is open: alpha's replaces gamma's.
    fireEvent.click(within(projectRow('alpha')).getByRole('button', { name: 'Edit credential' }))
    expect(document.querySelectorAll('[data-credential-editor]')).toHaveLength(1)
    expect(projectRow('alpha').contains(editor())).toBe(true)

    // Cancel keeps it.
    let dialog = await openConfirm('Delete', 'Delete')
    expect(within(dialog).getByText(/alpha, gamma will be left with no git credential/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

    // A credential in use can still be deleted, which closes the editor.
    dialog = await openConfirm('Delete', 'Delete')
    expect(server.called('DELETE /api/auth/git/credentials/c-token')).toEqual([])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(server.called('DELETE /api/auth/git/credentials/c-token')).toHaveLength(1))
    await waitFor(() => expect(editor()).toBeNull())

    // Deleted, but the proxy wasn't updated: the row goes and the warning
    // stays.
    server.route('DELETE /api/auth/git/credentials/c-key', serverError(
      'RUNTIME_UNAVAILABLE', 'The credential is deleted, but the egress proxy could not be updated', 503,
    ))
    const fetches = server.called('GET /api/auth/list').length
    authList = { ...CLAUDE_CONFIGURED, gitCredentials: [shared] }
    fireEvent.click(within(unusedRow('c-key')).getByRole('button', { name: 'Edit credential' }))
    dialog = await openConfirm('Delete', 'Delete')
    expect(within(dialog).getByText('No project uses it.')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText(/gitlab-key: The credential is deleted, but the egress proxy/)).toBeTruthy()
    await waitFor(() => expect(server.called('GET /api/auth/list').length).toBeGreaterThan(fetches))
    await waitFor(() => expect(unusedRow('c-key')).toBeNull())
  })

  it('replaces a token in place, and a key behind a confirmation, showing the new public key', async () => {
    server.route('POST /api/auth/git/credentials/c-token/replace', { id: 'c-token2' })
    server.route('POST /api/auth/git/credentials/c-key/replace', {
      id: 'c-key2', publicKey: 'ssh-ed25519 AAAAnew yaac gitlab-key',
    })
    await openCredentials()
    await waitFor(() => expect(projectRow('alpha')).toBeTruthy())

    fireEvent.click(within(projectRow('alpha')).getByRole('button', { name: 'Edit credential' }))
    expect(within(editor()).getByRole('note').textContent).toBe('Used by alpha. Changes here apply to it.')
    fireEvent.click(within(editor()).getByRole('button', { name: 'Replace' }))
    fireEvent.change(screen.getByLabelText('New token'), { target: { value: 'ghp_new' } })
    fireEvent.click(within(editor()).getByRole('button', { name: 'Replace' }))
    await waitFor(() => expect(screen.queryByLabelText('New token')).toBeNull())
    expect(server.called('POST /api/auth/git/credentials/c-token/replace').map((c) => c.body))
      .toEqual([{ token: 'ghp_new' }])

    // Same name and projects, new id and public key; the editor follows it.
    fireEvent.click(within(unusedRow('c-key')).getByRole('button', { name: 'Edit credential' }))
    const dialog = await openConfirm('Replace', 'Generate new key')
    expect(within(dialog).getByText(/current key is discarded/)).toBeTruthy()
    expect(server.called('POST /api/auth/git/credentials/c-key/replace')).toEqual([])
    authList = {
      ...CLAUDE_CONFIGURED,
      gitCredentials: [TOKEN, { ...KEY, id: 'c-key2', publicKey: 'ssh-ed25519 AAAAnew yaac gitlab-key' }],
    }
    fireEvent.click(within(dialog).getByRole('button', { name: 'Generate new key' }))

    await waitFor(() => expect(server.called('POST /api/auth/git/credentials/c-key/replace').map((c) => c.body))
      .toEqual([{}]))
    await waitFor(() => expect(within(editor()).getByText(/Register this public key with your git host/)).toBeTruthy())
    expect(unusedRow('c-key2').contains(editor())).toBe(true)
    expect(within(editor()).getByText('ssh-ed25519 AAAAnew yaac gitlab-key')).toBeTruthy()
    expect(within(editor()).getByRole('button', { name: 'Copy' })).toBeTruthy()
  })

  it('generates a key no project uses yet, showing its public half under a unique default name', async () => {
    authList = { ...CLAUDE_CONFIGURED, gitCredentials: [TOKEN, { ...KEY, name: 'git-key' }] }
    server.route('POST /api/auth/git/ssh-keys', { id: 'c-new', publicKey: 'ssh-ed25519 AAAAnew git-key-2' })
    await openCredentials()
    await waitFor(() => expect(unusedRow('c-key')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Credential kind'), { target: { value: 'ssh' } })
    const name = screen.getByLabelText<HTMLInputElement>('Credential name')
    expect(name.value).toBe('git-key-2')
    fireEvent.click(screen.getByRole('button', { name: 'Generate key' }))

    expect(await screen.findByText('ssh-ed25519 AAAAnew git-key-2')).toBeTruthy()
    expect(server.called('POST /api/auth/git/ssh-keys').map((c) => c.body)).toEqual([{ name: 'git-key-2' }])
    expect(screen.getByText(/Register this public key with your git host/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByText('ssh-ed25519 AAAAnew git-key-2')).toBeNull())
  })

  it('opens onto a focused project, its "Change" picker offering all but its current credential', async () => {
    useUiStore.getState().openSettings('credentials', undefined, 'id-alpha')
    renderSettings()

    await waitFor(() => expect(within(projectRow('alpha')).getByRole('button', { name: 'Assign' })).toBeTruthy())
    expect(projectRow('alpha').className).toMatch(/ring-accent/)
    expect(projectRow('beta').className).not.toMatch(/ring-accent/)
    // alpha-token is its current and only token, so only a new one is
    // offered (once the credential list has loaded).
    await waitFor(() => expect(pickerOptions(projectRow('alpha'))).toEqual(['New HTTPS token…']))
    expect(within(projectRow('alpha')).getByLabelText<HTMLInputElement>('Credential name').value)
      .toBe('alpha-token-2')
  })
})

describe('Settings → Credentials → custom endpoints', () => {
  const endpointCard = (): HTMLElement => document.querySelector(`[data-endpoint="${LLAMA.id}"]`) as HTMLElement
  const models = (): HTMLTextAreaElement => screen.getByLabelText<HTMLTextAreaElement>('Models (JSON)')

  it('adds an endpoint with the models its /models lists, edited as JSON before saving', async () => {
    server.route('POST /api/auth/endpoints/discover', {
      models: [{ id: 'qwen3', efforts: { levels: ['low', 'high'], default: 'low' } }],
      skipped: [{ id: 'nomic-embed', reason: 'not a chat model' }],
    })
    server.route('POST /api/auth/endpoints', { id: LLAMA.id })
    await openCredentials()

    fireEvent.click(screen.getByRole('button', { name: 'Add custom endpoint' }))
    fireEvent.change(screen.getByLabelText('Endpoint name'), { target: { value: 'llama' } })
    const url = screen.getByLabelText('Endpoint URL')
    fireEvent.change(url, { target: { value: 'https://box/v1' } })
    fireEvent.change(screen.getByLabelText('Endpoint API key'), { target: { value: 'sk-1' } })
    // Leaving the URL with no models yet fetches them.
    fireEvent.blur(url)
    await waitFor(() => expect(models().value).toContain('"qwen3"'))
    expect(server.called('POST /api/auth/endpoints/discover').map((c) => c.body)).toEqual([{ baseUrl: 'https://box/v1', apiKey: 'sk-1' }])
    expect(screen.getByText(/Left out: nomic-embed \(not a chat model\)/)).toBeTruthy()

    // A list that fails the schema is explained by path, and can't be saved.
    fireEvent.change(models(), { target: { value: '[{ "id": "qwen3", "efforts": { "levels": ["low"], "default": "high" } }]' } })
    expect(await screen.findByText('[0].efforts.default: the default is not one of the levels')).toBeTruthy()
    const form = models().closest('form') as HTMLElement
    expect(within(form).getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true)
    fireEvent.change(models(), { target: { value: '[{ "id": "qwen3", "name": "Qwen 3" }]' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(server.called('POST /api/auth/endpoints').map((c) => c.body)).toEqual([{
      name: 'llama', baseUrl: 'https://box/v1', apiKey: 'sk-1', models: [{ id: 'qwen3', name: 'Qwen 3' }],
    }]))
  })

  it('attaches an endpoint to a tool, confirming before it replaces another sign-in, and detaches it', async () => {
    authList = { ...CLAUDE_CONFIGURED, customEndpoints: [LLAMA], toolAuth: [
      ...CLAUDE_CONFIGURED.toolAuth,
      { tool: 'omp', kind: 'api-key', keyPreview: '***abcd', savedAt: 'x', ompProvider: 'openrouter', models: [], defaultModel: '' },
    ] }
    server.route('PUT /api/auth/omp', undefined)
    await openCredentials()
    await waitFor(() => expect(endpointCard()).toBeTruthy())
    expect(within(endpointCard()).getByText('qwen3 [low medium* high], gemma')).toBeTruthy()

    // pi has no sign-in, so it attaches at once.
    fireEvent.click(within(endpointCard()).getByRole('switch', { name: 'pi' }))
    await waitFor(() => expect(server.called('PUT /api/auth/pi').map((c) => c.body)).toEqual([{
      kind: 'api-key', apiKey: '', provider: 'custom', endpointId: LLAMA.id,
    }]))

    // omp is on OpenRouter: replacing that asks first.
    fireEvent.click(within(endpointCard()).getByRole('switch', { name: 'omp' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('This replaces its openrouter sign-in.')).toBeTruthy()
    expect(server.called('PUT /api/auth/omp')).toEqual([])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace' }))
    await waitFor(() => expect(server.called('PUT /api/auth/omp')).toHaveLength(1))

    // Switching off an attached tool signs it out, after a confirmation.
    authList = { ...authList, customEndpoints: [{ ...LLAMA, tools: ['pi', 'omp'] }] }
    await act(() => client.invalidateQueries({ queryKey: AUTH_LIST_KEY }))
    await waitFor(() => expect(within(endpointCard()).getByRole('switch', { name: 'pi' }).getAttribute('aria-checked')).toBe('true'))
    fireEvent.click(within(endpointCard()).getByRole('switch', { name: 'pi' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(server.called('POST /api/auth/clear').map((c) => c.body)).toEqual([{ service: 'pi' }]))
  })

  it('edits an endpoint under a banner naming its tools, applying a re-fetch\'s picked changes to the JSON before saving', async () => {
    authList = { ...CLAUDE_CONFIGURED, customEndpoints: [{ ...LLAMA, tools: ['pi', 'omp'], models: [...LLAMA.models, { id: 'mine' }] }] }
    server.route('POST /api/auth/endpoints/discover', {
      models: [
        { id: 'qwen3', efforts: { levels: ['low', 'medium', 'high', 'xhigh'], default: 'medium' } },
        { id: 'gemma' },
        { id: 'llama4' },
      ],
      skipped: [],
    })
    server.route(`PATCH /api/auth/endpoints/${LLAMA.id}`, undefined)
    await openCredentials()
    await waitFor(() => expect(endpointCard()).toBeTruthy())

    fireEvent.click(within(endpointCard()).getByRole('button', { name: 'Edit' }))
    expect(within(endpointCard()).getByRole('note').textContent).toBe(
      'Used by pi and omp. Saving updates their model lists for agents started from now on; running ones keep theirs until restarted.',
    )
    fireEvent.click(within(endpointCard()).getByRole('button', { name: 'Re-fetch from endpoint' }))
    const panel = await screen.findByRole('region', { name: 'Fetched changes' })
    // The stored endpoint is asked with its own URL and key.
    expect(server.called('POST /api/auth/endpoints/discover').map((c) => c.body)).toEqual([{ endpointId: LLAMA.id }])
    expect(within(panel).getByText('qwen3 [low medium* high] → qwen3 [low medium* high xhigh]')).toBeTruthy()
    // New and changed start checked; a model the endpoint no longer lists,
    // perhaps added by hand, does not.
    expect(within(panel).getByLabelText<HTMLInputElement>('New llama4').checked).toBe(true)
    expect(within(panel).getByLabelText<HTMLInputElement>('Changed qwen3').checked).toBe(true)
    expect(within(panel).getByLabelText<HTMLInputElement>('Gone mine').checked).toBe(false)
    fireEvent.click(within(panel).getByLabelText('New llama4'))
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply selected' }))

    // Applied to the JSON only; nothing is saved until Save.
    expect(JSON.parse(models().value)).toEqual([
      { id: 'qwen3', efforts: { levels: ['low', 'medium', 'high', 'xhigh'], default: 'medium' } },
      { id: 'gemma' },
      { id: 'mine' },
    ])
    expect(server.called(`PATCH /api/auth/endpoints/${LLAMA.id}`)).toEqual([])
    const edited: unknown = JSON.parse(models().value)
    fireEvent.click(within(endpointCard()).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(server.called(`PATCH /api/auth/endpoints/${LLAMA.id}`).map((c) => c.body))
      .toEqual([{ models: edited }]))
  })

  it('never fetches over JSON that does not parse, and starts each fetch\'s review from its own picks', async () => {
    authList = { ...CLAUDE_CONFIGURED, customEndpoints: [{ ...LLAMA, keyPreview: '***abcd' }] }
    server.route('POST /api/auth/endpoints/discover', { models: [...LLAMA.models, { id: 'first' }], skipped: [] })
    await openCredentials()
    await waitFor(() => expect(endpointCard()).toBeTruthy())
    fireEvent.click(within(endpointCard()).getByRole('button', { name: 'Edit' }))
    const refetch = (): HTMLButtonElement => within(endpointCard()).getByRole<HTMLButtonElement>('button', { name: 'Re-fetch from endpoint' })

    // A half-typed list is never overwritten: fetching waits for it to parse.
    const typed = models().value
    fireEvent.change(models(), { target: { value: '[ { "id": "typing' } })
    expect(refetch().disabled).toBe(true)
    fireEvent.change(models(), { target: { value: typed } })

    fireEvent.click(refetch())
    let panel = await screen.findByRole('region', { name: 'Fetched changes' })
    fireEvent.click(within(panel).getByLabelText('New first'))
    expect(within(panel).getByLabelText<HTMLInputElement>('New first').checked).toBe(false)
    // A second fetch's new model starts picked, whatever the first's were.
    server.route('POST /api/auth/endpoints/discover', { models: [...LLAMA.models, { id: 'first' }, { id: 'second' }], skipped: [] })
    fireEvent.click(refetch())
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Fetched changes' })).getByLabelText('New second')).toBeTruthy())
    panel = screen.getByRole('region', { name: 'Fetched changes' })
    expect(within(panel).getByLabelText<HTMLInputElement>('New first').checked).toBe(true)

    // JSON that stops parsing while the review is open blocks Apply.
    fireEvent.change(models(), { target: { value: '[' } })
    expect(within(panel).getByText('Fix the models JSON below to apply these.')).toBeTruthy()
    expect(within(panel).getByRole<HTMLButtonElement>('button', { name: 'Apply selected' }).disabled).toBe(true)

    // A new host drops the stored key, which the form says.
    fireEvent.change(within(endpointCard()).getByLabelText('Endpoint URL'), { target: { value: 'https://elsewhere/v1' } })
    expect(within(endpointCard()).getByText(/stored key is removed when the host changes/)).toBeTruthy()
  })

  it('says when a re-fetch finds nothing new', async () => {
    authList = { ...CLAUDE_CONFIGURED, customEndpoints: [LLAMA] }
    server.route('POST /api/auth/endpoints/discover', { models: LLAMA.models, skipped: [] })
    await openCredentials()
    await waitFor(() => expect(endpointCard()).toBeTruthy())
    fireEvent.click(within(endpointCard()).getByRole('button', { name: 'Edit' }))
    expect(within(endpointCard()).getByRole('note').textContent).toBe('No tool uses this endpoint yet.')
    fireEvent.click(within(endpointCard()).getByRole('button', { name: 'Re-fetch from endpoint' }))
    expect(await screen.findByText('The endpoint\'s list matches yours.')).toBeTruthy()
  })

  it('deletes an endpoint only on a click in a confirmation naming the tools it signs out', async () => {
    authList = { ...CLAUDE_CONFIGURED, customEndpoints: [{ ...LLAMA, tools: ['opencode'] }] }
    server.route(`DELETE /api/auth/endpoints/${LLAMA.id}`, undefined)
    await openCredentials()
    await waitFor(() => expect(endpointCard()).toBeTruthy())

    fireEvent.click(within(endpointCard()).getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/opencode will be signed out/)).toBeTruthy()
    expect(fireEvent.keyDown(within(dialog).getByRole('button', { name: 'Delete' }), { key: 'Enter' })).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(server.called(`DELETE /api/auth/endpoints/${LLAMA.id}`)).toHaveLength(1))
  })
})
