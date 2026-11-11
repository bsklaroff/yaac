import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import type { ProjectSummary, RepoSummary, Whoami } from '@yaac/shared/types'
import { ReposSettings } from '#components/settings/Repos'
import { useUiStore } from '#lib/store'
import {
  mockFetch, projectRepo, renderWithClient, repoSummary, serverSnapshot, testQueryClient, TEST_USER_ID, type FetchMock,
} from './harness'

/**
 * Settings → Repos: the caller's repos grouped by whether a project links
 * them, the ones shared with them, and the deleted ones still held; and
 * what a row's Manage area changes.
 */

const WHOAMI: Whoami = {
  kind: 'tailnet', userId: TEST_USER_ID, login: 'me@x.com', name: 'Me',
  users: [
    { id: TEST_USER_ID, login: 'me@x.com', name: 'Me', role: 'admin' },
    { id: 'u-ada', login: 'ada@x.com', name: 'Ada', role: 'member' },
    { id: 'u-bo', login: 'bo@x.com', name: 'Bo', role: 'member' },
  ],
}
const LIST = 'GET /api/repo/list'
const TOKEN = { id: 'c-token', name: 'gh', kind: 'https', preview: '***abcd', repos: [] } as const

/** A project `alpha` of the caller's that links `repo-api` in `api/`. */
const ALPHA = {
  id: 'id-alpha', name: 'alpha', owner: TEST_USER_ID, repos: [projectRepo({ id: 'repo-api', dir: 'api' })],
} as ProjectSummary
const linked = { projects: [{ id: 'id-alpha', name: 'alpha', owner: TEST_USER_ID }] }

let server: FetchMock
let repos: RepoSummary[]
const row = (id: string): HTMLElement => document.querySelector(`[data-repo="${id}"]`) as HTMLElement
/** Every repo's row, in the order shown. */
const order = (): string[] => [...document.querySelectorAll<HTMLElement>('[data-repo]')].map((el) => el.dataset.repo ?? '')
const manage = (id: string): void => { fireEvent.click(within(row(id)).getByRole('button', { name: 'Manage' })) }

function show(whoami: Whoami = WHOAMI): void {
  renderWithClient(<ReposSettings />, testQueryClient(whoami, serverSnapshot({ projects: [ALPHA] })))
}

beforeEach(() => {
  repos = []
  server = mockFetch({
    [LIST]: () => repos,
    'GET /api/auth/list': { gitCredentials: [TOKEN], toolAuth: [], customEndpoints: [] },
  })
})

afterEach(() => {
  cleanup()
  useUiStore.setState({ settingsFocusRepo: null, viewedUserId: null, snapshot: undefined })
})

describe('ReposSettings', () => {
  it('lists unlinked repos first, then linked ones, those shared with the caller, and deleted ones with what holds them', async () => {
    repos = [
      repoSummary({ id: 'repo-api', remoteUrl: 'https://github.com/o/api.git', ...linked }),
      repoSummary({ id: 'repo-gone', remoteUrl: 'https://github.com/o/gone.git', deleted: {
        heldBy: [{ workspaceId: 'abcdef0123456789', projectId: 'id-hers', projectName: 'hers', owner: 'u-ada' }],
      } }),
      repoSummary({ id: 'repo-hers', owner: 'u-ada', hosted: true, sharedWith: [TEST_USER_ID] }),
      repoSummary({ id: 'repo-loose', remoteUrl: 'git@gitlab.com:o/loose.git', gitCredential: null }),
      // Another user's, not shared: not the caller's to see here.
      repoSummary({ id: 'repo-theirs', owner: 'u-ada', remoteUrl: 'https://github.com/a/theirs.git' }),
    ]
    show()
    await waitFor(() => expect(order()).toEqual(['repo-loose', 'repo-api', 'repo-hers', 'repo-gone']))

    expect(within(row('repo-loose')).getByText('SSH')).toBeTruthy()
    expect(within(row('repo-loose')).getByText('No project links it.')).toBeTruthy()
    // With no credential no workspace can use it, so its picker is open.
    expect(within(row('repo-loose')).getByText('no git credential')).toBeTruthy()
    expect(within(row('repo-loose')).getByLabelText('Git credential')).toBeTruthy()
    expect(row('repo-api').textContent).toContain('Linked by alpha. Credential: gh.')
    // A repo shared with the caller is its owner's to change.
    expect(within(row('repo-hers')).getByText('HOSTED BY YAAC')).toBeTruthy()
    expect(within(row('repo-hers')).getByText('owned by Ada')).toBeTruthy()
    expect(within(row('repo-hers')).queryByRole('button', { name: 'Manage' })).toBeNull()
    // A deleted one names the workspaces that keep its objects on disk.
    expect(row('repo-gone').textContent).toContain('Workspace abcdef01 in hers (Ada\'s)')
    expect(within(row('repo-gone')).queryByRole('button', { name: 'Manage' })).toBeNull()
  })

  it('assigns a repo a credential, showing the host key it trusted, and opens a focused repo on its picker', async () => {
    repos = [
      repoSummary({ id: 'repo-api', remoteUrl: 'https://github.com/o/api.git', ...linked }),
      repoSummary({ id: 'repo-loose', remoteUrl: 'https://github.com/o/loose.git', gitCredential: null }),
    ]
    server.route('PUT /api/repo/repo-loose/git-credential', { knownHostsEntry: 'github.com ssh-ed25519 HOSTKEY' })
    useUiStore.getState().openSettings('repos', undefined, 'repo-api')
    show()
    await waitFor(() => expect(row('repo-api')).toBeTruthy())

    // The focused repo stands out, open on its picker, which leaves out the
    // credential it has.
    expect(row('repo-api').className).toMatch(/ring-accent/)
    expect(row('repo-loose').className).not.toMatch(/ring-accent/)
    await waitFor(() => expect(within(row('repo-api')).getByRole('button', { name: 'Assign' })).toBeTruthy())

    const loose = row('repo-loose')
    await waitFor(() => expect([...within(loose).getByLabelText<HTMLSelectElement>('Git credential').options].map((o) => o.textContent))
      .toEqual(['Choose a git credential…', 'gh', 'New HTTPS token…']))
    fireEvent.change(within(loose).getByLabelText('Git credential'), { target: { value: 'c-token' } })
    repos = [repos[0], { ...repos[1], gitCredential: { id: 'c-token', name: 'gh' } }]
    fireEvent.click(within(loose).getByRole('button', { name: 'Assign' }))
    await waitFor(() => expect(server.called('PUT /api/repo/repo-loose/git-credential').map((c) => c.body))
      .toEqual([{ credentialId: 'c-token' }]))
    expect(await within(row('repo-loose')).findByText('github.com ssh-ed25519 HOSTKEY')).toBeTruthy()
    await waitFor(() => expect(within(row('repo-loose')).queryByText('no git credential')).toBeNull())
  })

  it('shows a hosted repo\'s clone command, changes its default branch and guard, and shares it', async () => {
    let defaultBranch = 'main'
    repos = [repoSummary({ id: 'repo-api', hosted: true, sharedWith: ['u-ada'], ...linked })]
    for (const [route, reply] of Object.entries({
      'GET /api/repo/repo-api/branches': () => ({ branches: ['agent/x', 'main'], defaultBranch }),
      'PUT /api/repo/repo-api/default-branch': ({ body }: { body: { branch: string } }) => {
        defaultBranch = body.branch
        return undefined
      },
      'PUT /api/repo/repo-api/default-branch-guard': () => undefined,
      'POST /api/repo/repo-api/share': () => undefined,
      'POST /api/repo/repo-api/unshare': () => undefined,
    })) server.route(route, reply)
    show()
    await waitFor(() => expect(row('repo-api')).toBeTruthy())
    manage('repo-api')

    // Named for the folder the caller's project links it under.
    expect(screen.getByText(`git clone ${window.location.origin}/api/repo/repo-api/git api`)).toBeTruthy()
    const branch = await screen.findByRole<HTMLSelectElement>('combobox', { name: 'Default branch' })
    await waitFor(() => expect(branch.value).toBe('main'))
    fireEvent.change(branch, { target: { value: 'agent/x' } })
    await waitFor(() => expect(branch.value).toBe('agent/x'))
    expect(server.called('PUT /api/repo/repo-api/default-branch').map((c) => c.body)).toEqual([{ branch: 'agent/x' }])

    const guard = screen.getByRole<HTMLInputElement>('checkbox', { name: /Protect the default branch/ })
    expect(guard.checked).toBe(true)
    fireEvent.click(guard)
    await waitFor(() => expect(server.called('PUT /api/repo/repo-api/default-branch-guard').map((c) => c.body))
      .toEqual([{ enabled: false }]))

    screen.getByText('ada@x.com')
    const pick = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Share with' })
    expect([...pick.options].map((o) => o.textContent)).toEqual(['Share with…', 'Bo'])
    fireEvent.change(pick, { target: { value: 'u-bo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    await waitFor(() => expect(server.called('POST /api/repo/repo-api/share').map((c) => c.body)).toEqual([{ userId: 'u-bo' }]))
    fireEvent.click(screen.getByRole('button', { name: 'Stop sharing with Ada' }))
    await waitFor(() => expect(server.called('POST /api/repo/repo-api/unshare').map((c) => c.body)).toEqual([{ userId: 'u-ada' }]))
  })

  it('warns what a move stops and hands over, then moves the repo with the chosen credential', async () => {
    repos = [repoSummary({ id: 'repo-api', hosted: true, ...linked })]
    server.route('GET /api/repo/repo-api/branches', { branches: ['main'], defaultBranch: 'main' })
    server.route('GET /api/repo/repo-api/move-preview', { runningWorkspaces: 2, sharedWith: ['ada@x.com'] })
    server.route('POST /api/repo/repo-api/move', { knownHostsEntry: null })
    show()
    await waitFor(() => expect(row('repo-api')).toBeTruthy())
    manage('repo-api')

    fireEvent.click(screen.getByRole('button', { name: 'Move…' }))
    const warning = await screen.findByRole('note', { name: 'What moving does' })
    await waitFor(() => expect(warning.textContent).toContain('2 running workspaces with a checkout of this repo stop first'))
    expect(warning.textContent).toContain('It is shared with ada@x.com. Sharing ends')
    fireEvent.change(screen.getByRole('textbox', { name: 'Repository URL' }), { target: { value: 'https://github.com/o/api.git' } })
    fireEvent.change(await screen.findByRole('combobox', { name: 'Git credential' }), { target: { value: 'c-token' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stop 2 workspaces and move' }))
    await waitFor(() => expect(server.called('POST /api/repo/repo-api/move').map((c) => c.body))
      .toEqual([{ remoteUrl: 'https://github.com/o/api.git', credentialId: 'c-token' }]))
  })

  it('shows how to compare a moved repo\'s old repository with its remote, and removes it once confirmed', async () => {
    repos = [repoSummary({ id: 'repo-api', remoteUrl: 'https://github.com/o/api.git', keepsHostedRepo: true, ...linked })]
    server.route('DELETE /api/repo/repo-api/kept-hosted-repo', () => undefined)
    show()
    await waitFor(() => expect(row('repo-api')).toBeTruthy())
    manage('repo-api')

    expect(screen.queryByRole('button', { name: 'Move…' })).toBeNull()
    screen.getByText(`git ls-remote ${window.location.origin}/api/repo/repo-api/git`)
    screen.getByText('git ls-remote https://github.com/o/api.git')
    fireEvent.click(screen.getByRole('button', { name: 'Remove yaac\'s copy…' }))
    expect(server.called('DELETE /api/repo/repo-api/kept-hosted-repo')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(server.called('DELETE /api/repo/repo-api/kept-hosted-repo')).toHaveLength(1))
  })

  it('deletes a repo behind a confirmation that counts what it reaches and needs its remote typed', async () => {
    const remoteUrl = 'https://github.com/o/api.git'
    repos = [repoSummary({ id: 'repo-api', remoteUrl, ...linked })]
    const holder = { workspaceId: 'abcdef0123456789', projectId: 'id-alpha', projectName: 'alpha', owner: TEST_USER_ID }
    server.route('GET /api/repo/repo-api/delete-preview', {
      hosted: false,
      projects: [linked.projects[0], { id: 'id-hers', name: 'hers', owner: 'u-ada' }],
      heldBy: [holder],
    })
    server.route('DELETE /api/repo/repo-api', { heldBy: [holder] })
    show()
    await waitFor(() => expect(row('repo-api')).toBeTruthy())
    manage('repo-api')

    fireEvent.click(screen.getByRole('button', { name: 'Delete repo…' }))
    const dialog = await screen.findByRole('alertdialog')
    await waitFor(() => expect(dialog.textContent).toContain('It is unlinked from 2 projects, other users\' included'))
    expect(dialog.textContent).toContain('No workspace is deleted: the 1 workspace holding a checkout of it')
    // Not hosted, so no repository of yaac's goes with it.
    expect(dialog.textContent).not.toContain('only copy of its code')
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Delete' })
    expect(confirm.disabled).toBe(true)
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: remoteUrl } })
    await waitFor(() => expect(confirm.disabled).toBe(false))

    // Once deleted it is listed among the deleted, with what holds it.
    repos = [{ ...repos[0], projects: [], deleted: { heldBy: [holder] } }]
    fireEvent.click(confirm)
    await waitFor(() => expect(server.called('DELETE /api/repo/repo-api')).toHaveLength(1))
    await waitFor(() => expect(row('repo-api').textContent).toContain('Workspace abcdef01 in alpha'))
  })

  it('shows a teammate\'s repos read-only', async () => {
    repos = [repoSummary({ id: 'repo-hers', owner: 'u-ada', remoteUrl: 'https://github.com/a/hers.git', gitCredential: null })]
    useUiStore.setState({ viewedUserId: 'u-ada' })
    show()
    await waitFor(() => expect(row('repo-hers')).toBeTruthy())
    expect(within(row('repo-hers')).queryByRole('button')).toBeNull()
    expect(within(row('repo-hers')).queryByLabelText('Git credential')).toBeNull()
  })
})
