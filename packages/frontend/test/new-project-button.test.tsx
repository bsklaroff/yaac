// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { AuthListResult, GitCredentialSummary } from '@yaac/shared/types'

vi.mock('#lib/settingsApi', () => ({
  getAuthList: vi.fn(),
  addHttpsCredential: vi.fn(),
  generateSshKey: vi.fn(),
}))
vi.mock('#lib/projectApi', () => ({
  addProject: vi.fn(),
}))

import { NewProjectButton } from '#components/NewProjectButton'
import { addProject } from '#lib/projectApi'
import { addHttpsCredential, generateSshKey, getAuthList } from '#lib/settingsApi'
import { useUiStore } from '#store'

const TOKEN: GitCredentialSummary = {
  id: 'c-token', name: 'repo-token', kind: 'https', preview: '***abcd', projects: ['alpha'],
}
const list = (...gitCredentials: GitCredentialSummary[]): AuthListResult => ({ gitCredentials, toolAuth: [] })

beforeEach(() => {
  vi.clearAllMocks()
  useUiStore.setState({ activeProjectSlug: null })
  vi.mocked(getAuthList).mockResolvedValue(list(TOKEN))
})

afterEach(cleanup)

/** Render, open the dialog, type the remote, and let the credentials land. */
async function openWith(url: string): Promise<void> {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <NewProjectButton />
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'New project' }))
  fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: url } })
  await waitFor(() => expect(vi.mocked(getAuthList)).toHaveBeenCalled())
}

const addButton = (): HTMLButtonElement => screen.getByRole<HTMLButtonElement>('button', { name: 'Add' })

describe('NewProjectButton', () => {
  it('generates a new SSH key and shows its public half before the clone that needs it', async () => {
    vi.mocked(generateSshKey).mockResolvedValue({ id: 'c-key', publicKey: 'ssh-ed25519 AAAAkey yaac repo-key' })
    vi.mocked(addProject).mockResolvedValue({ slug: 'repo', knownHostsEntry: 'github.com ssh-ed25519 HOSTKEY' })
    await openWith('git@github.com:o/repo.git')

    // An SSH remote has no key to reuse (the token is the wrong kind), so the
    // picker opens on a new one, named for the project the remote becomes.
    await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>('Credential name').value).toBe('repo-key'))
    expect(screen.queryByRole('option', { name: 'repo-token' })).toBeNull()
    expect(addButton().disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Generate key' }))
    expect(await screen.findByText('ssh-ed25519 AAAAkey yaac repo-key')).toBeTruthy()
    expect(generateSshKey).toHaveBeenCalledWith('repo-key')
    expect(addProject).not.toHaveBeenCalled()

    fireEvent.click(addButton())
    await waitFor(() => expect(addProject).toHaveBeenCalledWith('git@github.com:o/repo.git', 'c-key'))
    // The clone trusted the host's key: shown for comparison before closing.
    expect(await screen.findByText('github.com ssh-ed25519 HOSTKEY')).toBeTruthy()
    expect(useUiStore.getState().activeProjectSlug).toBe('repo')
  })

  it('stores a new HTTPS token first, and a failed clone retries with it rather than another', async () => {
    vi.mocked(addHttpsCredential).mockResolvedValue('c-new')
    vi.mocked(addProject)
      .mockRejectedValueOnce(new Error('git authentication failed for github.com'))
      .mockResolvedValueOnce({ slug: 'repo', knownHostsEntry: null })
    await openWith('https://github.com/o/Repo.git/')

    // A stored token of the kind exists, so nothing is chosen for the user.
    await waitFor(() => expect(screen.getByRole('option', { name: 'repo-token' })).toBeTruthy())
    expect(addButton().disabled).toBe(true)
    // Named for the slug the server derives (the last segment, lowercased),
    // past the name already taken.
    fireEvent.change(screen.getByLabelText('Git credential'), { target: { value: 'new' } })
    expect(screen.getByLabelText<HTMLInputElement>('Credential name').value).toBe('repo-token-2')
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'ghp_x' } })

    vi.mocked(getAuthList).mockResolvedValue(list(TOKEN, {
      id: 'c-new', name: 'repo-token-2', kind: 'https', preview: '***_x', projects: [],
    }))
    fireEvent.click(addButton())
    expect(await screen.findByText('git authentication failed for github.com')).toBeTruthy()
    expect(addHttpsCredential).toHaveBeenCalledWith('repo-token-2', 'ghp_x')
    expect(screen.getByLabelText<HTMLSelectElement>('Git credential').value).toBe('c-new')

    fireEvent.click(addButton())
    await waitFor(() => expect(useUiStore.getState().activeProjectSlug).toBe('repo'))
    expect(addHttpsCredential).toHaveBeenCalledTimes(1)
    expect(vi.mocked(addProject).mock.calls).toEqual([
      ['https://github.com/o/Repo.git/', 'c-new'],
      ['https://github.com/o/Repo.git/', 'c-new'],
    ])
    // No host key to show: the dialog just closes.
    await waitFor(() => expect(screen.queryByLabelText('Repository URL')).toBeNull())
  })
})
