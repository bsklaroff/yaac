// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { QueryClient } from '@tanstack/react-query'
import { act, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { AuthListResult, GitCredentialSummary } from '@yaac/shared/types'
import { NewProjectButton } from '#components/NewProjectButton'
import { useUiStore } from '#lib/store'
import { SNAPSHOT_KEY } from '#lib/useEvents'
import { mockFetch, renderWithClient, serverError, testQueryClient, type FetchMock } from './harness'

const TOKEN: GitCredentialSummary = {
  id: 'c-token', name: 'repo-token', kind: 'https', preview: '***abcd', projects: ['alpha'],
}
const list = (...gitCredentials: GitCredentialSummary[]): AuthListResult => ({ gitCredentials, toolAuth: [] })

const AUTH_LIST = 'GET /api/auth/list'
const ADD = 'POST /api/project/add'
const NEW_TOKEN = 'POST /api/auth/git/credentials'
const NEW_KEY = 'POST /api/auth/git/ssh-keys'

let server: FetchMock

beforeEach(() => {
  useUiStore.setState({ activeProjectSlug: null })
  server = mockFetch({ [AUTH_LIST]: list(TOKEN) })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

let client: QueryClient

/**
 * Push a snapshot frame listing these projects, as `useEvents` would, and let
 * React Query's batched notify (a zero timeout) reach the component.
 */
async function snapshotLists(...slugs: string[]): Promise<void> {
  await act(async () => {
    client.setQueryData(SNAPSHOT_KEY, { projects: slugs.map((slug) => ({ slug })) })
    await new Promise((r) => setTimeout(r, 0))
  })
}

/** Render, open the dialog, type the remote, and wait for credentials. */
async function openWith(url: string): Promise<void> {
  client = testQueryClient()
  renderWithClient(<NewProjectButton />, client)
  fireEvent.click(screen.getByRole('button', { name: 'New project' }))
  fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: url } })
  await waitFor(() => expect(server.called(AUTH_LIST).length).toBeGreaterThan(0))
}

const addButton = (): HTMLButtonElement => screen.getByRole<HTMLButtonElement>('button', { name: 'Add' })

describe('NewProjectButton', () => {
  it('generates a new SSH key and shows its public half before the clone that needs it', async () => {
    server.route(NEW_KEY, { id: 'c-key', publicKey: 'ssh-ed25519 AAAAkey yaac repo-key' })
    server.route(ADD, { project: { slug: 'repo' }, knownHostsEntry: 'github.com ssh-ed25519 HOSTKEY' })
    await openWith('git@github.com:o/repo.git')

    // No SSH key exists (the token is the wrong kind), so the picker offers
    // a new one, named for the project.
    await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>('Credential name').value).toBe('repo-key'))
    expect(screen.queryByRole('option', { name: 'repo-token' })).toBeNull()
    expect(addButton().disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Generate key' }))
    expect(await screen.findByText('ssh-ed25519 AAAAkey yaac repo-key')).toBeTruthy()
    expect(server.called(NEW_KEY).map((c) => c.body)).toEqual([{ name: 'repo-key' }])
    expect(server.called(ADD)).toHaveLength(0)

    fireEvent.click(addButton())
    await waitFor(() => expect(server.called(ADD).map((c) => c.body)).toEqual([
      { remoteUrl: 'git@github.com:o/repo.git', gitCredentialId: 'c-key' },
    ]))
    // The trusted host key is shown before the dialog closes.
    expect(await screen.findByText('github.com ssh-ed25519 HOSTKEY')).toBeTruthy()
    // Selected only once the snapshot lists it, or the shell's fallback for
    // an unknown project would switch straight back.
    await snapshotLists('alpha')
    expect(useUiStore.getState().activeProjectSlug).toBeNull()
    await snapshotLists('alpha', 'repo')
    expect(useUiStore.getState().activeProjectSlug).toBe('repo')
  })

  it('stores a new HTTPS token first, and a failed clone retries with it rather than another', async () => {
    server.route(NEW_TOKEN, { id: 'c-new' })
    let adds = 0
    server.route(ADD, () => (adds++ === 0
      ? serverError('VALIDATION', 'git authentication failed for github.com', 400)
      : { project: { slug: 'repo' }, knownHostsEntry: null }))
    await openWith('https://github.com/o/Repo.git/')

    // A matching token exists, so nothing is preselected.
    await waitFor(() => expect(screen.getByRole('option', { name: 'repo-token' })).toBeTruthy())
    expect(addButton().disabled).toBe(true)
    // Named for the project slug (last URL segment, lowercased), avoiding the
    // taken name.
    fireEvent.change(screen.getByLabelText('Git credential'), { target: { value: 'new' } })
    expect(screen.getByLabelText<HTMLInputElement>('Credential name').value).toBe('repo-token-2')
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'ghp_x' } })

    server.route(AUTH_LIST, list(TOKEN, {
      id: 'c-new', name: 'repo-token-2', kind: 'https', preview: '***_x', projects: [],
    }))
    fireEvent.click(addButton())
    expect(await screen.findByText('git authentication failed for github.com')).toBeTruthy()
    expect(server.called(NEW_TOKEN).map((c) => c.body)).toEqual([{ name: 'repo-token-2', token: 'ghp_x' }])
    expect(screen.getByLabelText<HTMLSelectElement>('Git credential').value).toBe('c-new')

    fireEvent.click(addButton())
    await waitFor(() => expect(server.called(ADD)).toHaveLength(2))
    await snapshotLists('repo')
    expect(useUiStore.getState().activeProjectSlug).toBe('repo')
    expect(server.called(NEW_TOKEN)).toHaveLength(1)
    const retried = { remoteUrl: 'https://github.com/o/Repo.git/', gitCredentialId: 'c-new' }
    expect(server.called(ADD).map((c) => c.body)).toEqual([retried, retried])
    // No host key to show: the dialog just closes.
    await waitFor(() => expect(screen.queryByLabelText('Repository URL')).toBeNull())
  })
})
