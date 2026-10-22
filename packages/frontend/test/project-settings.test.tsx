import { describe, it, expect, afterEach, vi } from 'vitest'
import { screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import type { ProjectEnvVar, ProjectSummary, Whoami } from '@yaac/shared/types'

// CodeMirror doesn't run under jsdom; the config editor gets a textarea.
vi.mock('#components/ui/CodeEditor', () => ({
  CodeEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="editor" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))

import { ProjectSettings } from '#components/settings/ProjectSettings'
import { useUiStore } from '#lib/store'
import {
  mockFetch, renderWithClient, serverSnapshot, testQueryClient, TEST_USER_ID, type FetchCall, type FetchMock,
} from './harness'

afterEach(() => {
  cleanup()
  useUiStore.setState({ viewedUserId: null, settingsProjectId: null })
})

/** A project keyed by `id-<name>`, so a test can tell the key from the
 *  displayed name. */
const project = (name: string, remoteUrl: string): ProjectSummary =>
  ({ id: `id-${name}`, name, remoteUrl, addedAt: '', owner: TEST_USER_ID, workspaceCount: 0, stoppedCount: 0, deaths: 0, deathsSeenBy: {}, createDefaults: {}, gitCredential: null, hosted: false, guardDefaultBranch: true, cloudIdentity: null })

/** Show settings for `alpha` (and `beta`) on a containerless server, whose
 *  env routes keep `vars` in memory. */
function renderAlpha(vars: ProjectEnvVar[] = []): FetchMock {
  useUiStore.setState({ activeProjectId: 'id-alpha' })
  const snapshot = serverSnapshot({
    driver: 'containerless',
    projects: [project('alpha', 'https://github.com/o/alpha.git'), project('beta', 'git@gitlab.com:o/beta.git')],
  })
  const server = mockFetch({
    'GET /api/project/id-alpha/env': () => ({ vars }),
    'PUT /api/project/id-alpha/env': ({ body }: FetchCall) => {
      const { name, value, secret, rule } = body as ProjectEnvVar
      const saved = { id: `id-${name}`, name, secret, hasValue: true, ...(secret ? { rule } : { value }) }
      vars = [...vars.filter((v) => v.name !== name), saved]
      return { var: saved }
    },
    'DELETE /api/project/id-alpha/env/v1': () => {
      vars = vars.filter((v) => v.id !== 'v1')
      return undefined
    },
    'GET /api/project/id-alpha/config': { config: { a: 1 } },
    'GET /api/project/id-beta/env': { vars: [] },
    'GET /api/project/id-beta/config': { config: null },
  })
  renderWithClient(<ProjectSettings />, testQueryClient(undefined, snapshot))
  return server
}

describe('ProjectSettings', () => {
  it('picks a project by name and shows its remote, with its scheme, above the environment', () => {
    renderAlpha()
    expect([...screen.getByRole<HTMLSelectElement>('combobox').options].map((o) => [o.value, o.textContent]))
      .toEqual([['id-alpha', 'alpha'], ['id-beta', 'beta']])

    const remote = screen.getByText('https://github.com/o/alpha.git')
    expect(remote.previousElementSibling?.textContent).toBe('HTTPS')
    // Directly under the project picker, ahead of the environment section.
    expect(remote.closest('div')?.querySelector('select')).toBeTruthy()

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'id-beta' } })
    expect(screen.getByText('git@gitlab.com:o/beta.git').previousElementSibling?.textContent).toBe('SSH')
  })

  it('shows a hosted project\'s clone command instead of a remote, and turns its default-branch guard off', async () => {
    useUiStore.setState({ activeProjectId: 'id-gamma' })
    const snapshot = serverSnapshot({
      driver: 'containerless',
      projects: [{ ...project('gamma', 'http://yaac.internal/api/workspace/git/id-gamma.git'), hosted: true }],
    })
    const server = mockFetch({
      'GET /api/project/id-gamma/env': { vars: [] },
      'GET /api/project/id-gamma/config': { config: null },
      'PUT /api/project/id-gamma/default-branch-guard': () => undefined,
    })
    renderWithClient(<ProjectSettings />, testQueryClient(undefined, snapshot))

    expect(screen.getByText('HOSTED BY YAAC')).toBeTruthy()
    expect(screen.queryByText('http://yaac.internal/api/workspace/git/id-gamma.git')).toBeNull()
    expect(screen.getByText(`git clone ${window.location.origin}/api/project/id-gamma/git gamma`)).toBeTruthy()

    const guard = screen.getByRole<HTMLInputElement>('checkbox', { name: /Protect the default branch/ })
    expect(guard.checked).toBe(true)
    fireEvent.click(guard)
    await waitFor(() => expect(server.called('PUT /api/project/id-gamma/default-branch-guard').map((c) => c.body))
      .toEqual([{ enabled: false }]))
  })

  it('shares a hosted project with another user and stops sharing it', async () => {
    useUiStore.setState({ activeProjectId: 'id-gamma' })
    const whoami: Whoami = {
      kind: 'tailnet', userId: TEST_USER_ID, login: 'me@x.com', name: 'Me',
      users: [{ id: TEST_USER_ID, login: 'me@x.com', name: 'Me' }, { id: 'u-ada', login: 'ada@x.com', name: 'Ada' }, { id: 'u-bo', login: 'bo@x.com', name: 'Bo' }],
    }
    const gamma = { ...project('gamma', 'http://yaac.internal/api/workspace/git/id-gamma.git'), hosted: true }
    const snapshot = serverSnapshot({
      driver: 'containerless',
      projects: [gamma, { ...gamma, id: 'id-ada-gamma', owner: 'u-ada', sharedFrom: { projectId: 'id-gamma', revoked: false } }],
    })
    const server = mockFetch({
      'GET /api/project/id-gamma/env': { vars: [] },
      'GET /api/project/id-gamma/config': { config: null },
      'POST /api/project/id-gamma/shares': { id: 'id-bo-gamma', name: 'gamma', remoteUrl: '', addedAt: '' },
      'DELETE /api/project/id-gamma/shares/u-ada': () => undefined,
    })
    renderWithClient(<ProjectSettings />, testQueryClient(whoami, snapshot))

    expect(screen.getAllByRole('option').map((o) => o.textContent)).toContain('gamma')
    screen.getByText('ada@x.com')
    const pick = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Share with' })
    expect([...pick.options].map((o) => o.textContent)).toEqual(['Share with…', 'Bo'])
    fireEvent.change(pick, { target: { value: 'u-bo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    await waitFor(() => expect(server.called('POST /api/project/id-gamma/shares').map((c) => c.body)).toEqual([{ userId: 'u-bo' }]))

    fireEvent.click(screen.getByRole('button', { name: 'Stop sharing with Ada' }))
    await waitFor(() => expect(server.called('DELETE /api/project/id-gamma/shares/u-ada')).toHaveLength(1))
  })

  it("shows a share as its sharer's, with the guard left to them and no sharing of its own", () => {
    useUiStore.setState({ activeProjectId: 'id-mine' })
    const whoami: Whoami = {
      kind: 'tailnet', userId: TEST_USER_ID, login: 'me@x.com', name: 'Me',
      users: [{ id: TEST_USER_ID, login: 'me@x.com', name: 'Me' }, { id: 'u-ada', login: 'ada@x.com', name: 'Ada' }],
    }
    const hosted = { ...project('gamma', 'http://yaac.internal/api/workspace/git/x.git'), hosted: true }
    const snapshot = serverSnapshot({
      driver: 'containerless',
      projects: [
        { ...hosted, id: 'id-gamma', owner: 'u-ada' },
        { ...hosted, id: 'id-mine', sharedFrom: { projectId: 'id-gamma', revoked: false } },
      ],
    })
    mockFetch({ 'GET /api/project/id-mine/env': { vars: [] }, 'GET /api/project/id-mine/config': { config: null } })
    renderWithClient(<ProjectSettings />, testQueryClient(whoami, snapshot))

    screen.getByText('Shared by Ada')
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Protect the default branch/ }).disabled).toBe(true)
    expect(screen.queryByText('Sharing')).toBeNull()
  })

  it('shows a share its source\'s owner removed to its owner read-only', () => {
    useUiStore.setState({ activeProjectId: 'id-mine' })
    const hosted = { ...project('gamma', 'http://yaac.internal/api/workspace/git/x.git'), hosted: true }
    const snapshot = serverSnapshot({
      driver: 'containerless',
      projects: [{ ...hosted, id: 'id-mine', sharedFrom: { projectId: 'id-gamma', revoked: true } }],
    })
    mockFetch({ 'GET /api/project/id-mine/env': { vars: [] }, 'GET /api/project/id-mine/config': { config: null } })
    renderWithClient(<ProjectSettings />, testQueryClient(undefined, snapshot))

    screen.getByText('Sharing removed')
    expect(screen.queryByPlaceholderText('NAME')).toBeNull()
  })

  it('lists the project\'s variables, adds a secret with its proxy rule, and deletes one', async () => {
    const server = renderAlpha([{ id: 'v1', name: 'FOO', secret: false, value: 'bar', hasValue: true }])
    await screen.findByText('FOO')
    screen.getByText('bar')

    fireEvent.change(screen.getByPlaceholderText('NAME'), { target: { value: 'TOKEN' } })
    fireEvent.change(screen.getByPlaceholderText('value'), { target: { value: 's3cret' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Secret' }))
    fireEvent.change(screen.getByLabelText('hosts'), { target: { value: 'api.example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await screen.findByText('TOKEN')
    expect(server.called('PUT /api/project/id-alpha/env').map((c) => c.body)).toEqual([
      {
        name: 'TOKEN', value: 's3cret', secret: true,
        rule: { hosts: ['api.example.com'], path: '/*', header: 'authorization', prefix: 'Bearer ' },
      },
    ])
    // A secret shows masked, with where it is injected.
    screen.getByText('••••••••')
    screen.getByTitle('api.example.com · header authorization')
    expect(screen.getByPlaceholderText<HTMLInputElement>('NAME').value).toBe('')

    fireEvent.click(screen.getByRole('button', { name: 'Delete FOO' }))
    await waitFor(() => expect(screen.queryByText('FOO')).toBeNull())
    expect(server.called('DELETE /api/project/id-alpha/env/v1')).toHaveLength(1)
  })

  it('lends a project the server\'s cloud identity, naming it with a warning first', async () => {
    useUiStore.setState({ activeProjectId: 'id-alpha' })
    const snapshot = serverSnapshot({ driver: 'k8s', projects: [project('alpha', 'https://github.com/o/alpha.git')] })
    const server = mockFetch({
      'GET /api/server/cloud-identity': { provider: 'gcp', hostIdentity: 'vm@demo.iam.gserviceaccount.com', canSet: true },
      'PUT /api/project/id-alpha/cloud-identity': { identity: 'vm@demo.iam.gserviceaccount.com' },
    })
    renderWithClient(<ProjectSettings />, testQueryClient(undefined, snapshot))

    const select = await screen.findByLabelText('Cloud identity')
    const section = within(select.closest('div')!.parentElement!)
    expect(screen.queryByText(/inherit all of its permissions/)).toBeNull()
    fireEvent.change(select, { target: { value: 'host' } })
    expect(screen.getByRole('note').textContent)
      .toMatch(/run as vm@demo\.iam\.gserviceaccount\.com and inherit all of its permissions/)
    fireEvent.click(section.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(server.called('PUT /api/project/id-alpha/cloud-identity')).toHaveLength(1))
    expect(server.called('PUT /api/project/id-alpha/cloud-identity')[0].body).toEqual({ identity: 'host' })
  })

  it('shows a project\'s cloud identity read-only to anyone but the install owner, and nothing off a cloud', async () => {
    useUiStore.setState({ activeProjectId: 'id-alpha' })
    const snapshot = serverSnapshot({
      driver: 'k8s',
      projects: [{ ...project('alpha', 'https://github.com/o/alpha.git'), cloudIdentity: 'agents@demo.iam.gserviceaccount.com' }],
    })
    mockFetch({ 'GET /api/server/cloud-identity': { provider: 'gcp', hostIdentity: 'vm@demo.iam.gserviceaccount.com', canSet: false } })
    renderWithClient(<ProjectSettings />, testQueryClient(undefined, snapshot))
    const select = await screen.findByLabelText<HTMLSelectElement>('Cloud identity')
    expect(select.disabled).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>('Service account email').value).toBe('agents@demo.iam.gserviceaccount.com')
    expect(screen.getByText(/Only the owner of this install can change it/)).toBeTruthy()
    cleanup()

    mockFetch({ 'GET /api/server/cloud-identity': { provider: null, hostIdentity: null, canSet: true } })
    renderWithClient(<ProjectSettings />, testQueryClient(undefined, serverSnapshot({ driver: 'k8s', projects: [project('alpha', 'x')] })))
    await screen.findByText('x')
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByLabelText('Cloud identity')).toBeNull()
  })

  it('shows a teammate\'s project read-only', async () => {
    // The caller is TEST_USER_ID; Ada's projects are what the switcher shows.
    useUiStore.setState({ activeProjectId: 'id-hers', viewedUserId: 'u-ada' })
    const snapshot = serverSnapshot({
      driver: 'k8s',
      projects: [
        { ...project('hers', 'https://github.com/a/hers.git'), owner: 'u-ada' },
        project('mine', 'https://github.com/o/mine.git'),
      ],
    })
    const server = mockFetch({
      'GET /api/project/id-hers/env': { vars: [
        { id: 'v1', name: 'PLAIN', secret: false, value: 'visible-elsewhere', hasValue: true },
        { id: 'v2', name: 'TOKEN', secret: true, hasValue: true, rule: { hosts: ['api.example.com'] } },
      ] },
      'GET /api/project/id-hers/config': { config: { a: 1 } },
      'GET /api/project/id-hers/dockerfile': { content: 'FROM scratch\n' },
      'GET /api/project/id-hers/build-files': { files: [{ path: 'init.lua', size: 3, binary: false }] },
      'GET /api/project/id-hers/build-files/file': { path: 'init.lua', size: 3, binary: false, content: 'x=1' },
    })
    renderWithClient(<ProjectSettings />, testQueryClient(undefined, snapshot))

    // Only the viewed user's projects are offered.
    expect([...screen.getByRole<HTMLSelectElement>('combobox').options].map((o) => o.value)).toEqual(['id-hers'])
    await screen.findByText('PLAIN')
    // A plain value reads as for the owner; a secret's never leaves the server.
    expect(screen.getByText('visible-elsewhere')).toBeTruthy()
    expect(screen.getAllByText('••••••••')).toHaveLength(1)
    expect(screen.queryByPlaceholderText('NAME')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()

    // Config, Dockerfile and a build file read, with nothing to save or upload.
    await waitFor(() => expect(screen.getAllByLabelText('editor')).toHaveLength(2))
    fireEvent.click(await screen.findByRole('button', { name: 'init.lua' }))
    await waitFor(() => expect(screen.getAllByLabelText('editor')).toHaveLength(3))
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Upload files' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Rename init.lua' })).toBeNull()
    expect(server.calls.filter((c) => c.method !== 'GET')).toEqual([])
  })
})
