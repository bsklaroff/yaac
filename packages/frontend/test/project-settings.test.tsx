// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { ProjectEnvVar, ProjectSummary } from '@yaac/shared/types'

// CodeMirror doesn't run under jsdom; the config editor gets a textarea.
vi.mock('#components/ui/CodeEditor', () => ({
  CodeEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="editor" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))
const snapshot = vi.hoisted(() => vi.fn())
vi.mock('#lib/useSnapshot', () => ({ useSnapshot: snapshot }))

import { ProjectSettings } from '#components/settings/ProjectSettings'
import { useUiStore } from '#lib/store'
import { mockFetch, renderWithClient, TEST_USER_ID, type FetchCall, type FetchMock } from './harness'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useUiStore.setState({ viewedUserId: null })
})

/** A project keyed by `id-<name>`, so a test can tell the key from the
 *  displayed name. */
const project = (name: string, remoteUrl: string): ProjectSummary =>
  ({ id: `id-${name}`, name, remoteUrl, addedAt: '', owner: TEST_USER_ID, workspaceCount: 0, stoppedCount: 0, unseenDeaths: 0, createDefaults: {}, gitCredential: null })

/** Show settings for `alpha` (and `beta`) on a containerless server, whose
 *  env routes keep `vars` in memory. */
function renderAlpha(vars: ProjectEnvVar[] = []): FetchMock {
  useUiStore.setState({ activeProjectId: 'id-alpha' })
  snapshot.mockReturnValue({
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
  renderWithClient(<ProjectSettings />)
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

  it('shows a teammate\'s project read-only', async () => {
    // The caller is TEST_USER_ID; Ada's projects are what the switcher shows.
    useUiStore.setState({ activeProjectId: 'id-hers', viewedUserId: 'u-ada' })
    snapshot.mockReturnValue({
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
    renderWithClient(<ProjectSettings />)

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
