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
import { mockFetch, renderWithClient, type FetchCall, type FetchMock } from './harness'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const project = (slug: string, remoteUrl: string): ProjectSummary =>
  ({ slug, remoteUrl, addedAt: '', workspaceCount: 0, createDefaults: {}, gitCredential: null })

/** Show settings for `alpha` (and `beta`) on a containerless server, whose
 *  env routes keep `vars` in memory. */
function renderAlpha(vars: ProjectEnvVar[] = []): FetchMock {
  useUiStore.setState({ activeProjectSlug: 'alpha' })
  snapshot.mockReturnValue({
    driver: 'containerless',
    projects: [project('alpha', 'https://github.com/o/alpha.git'), project('beta', 'git@gitlab.com:o/beta.git')],
  })
  const server = mockFetch({
    'GET /api/project/alpha/env': () => ({ vars }),
    'PUT /api/project/alpha/env': ({ body }: FetchCall) => {
      const { name, value, secret, rule } = body as ProjectEnvVar
      const saved = { id: `id-${name}`, name, secret, hasValue: true, ...(secret ? { rule } : { value }) }
      vars = [...vars.filter((v) => v.name !== name), saved]
      return { var: saved }
    },
    'DELETE /api/project/alpha/env/v1': () => {
      vars = vars.filter((v) => v.id !== 'v1')
      return undefined
    },
    'GET /api/project/alpha/config': { config: { a: 1 } },
    'GET /api/project/beta/env': { vars: [] },
    'GET /api/project/beta/config': { config: null },
  })
  renderWithClient(<ProjectSettings />)
  return server
}

describe('ProjectSettings', () => {
  it('shows the picked project\'s remote, with its scheme, above the environment', () => {
    renderAlpha()

    const remote = screen.getByText('https://github.com/o/alpha.git')
    expect(remote.previousElementSibling?.textContent).toBe('HTTPS')
    // Directly under the project picker, ahead of the environment section.
    expect(remote.closest('div')?.querySelector('select')).toBeTruthy()

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'beta' } })
    expect(screen.getByText('git@gitlab.com:o/beta.git').previousElementSibling?.textContent).toBe('SSH')
  })

  it('lists the project\'s variables, adds a secret with its proxy rule, and deletes one', async () => {
    const server = renderAlpha([{ id: 'v1', name: 'FOO', secret: false, value: 'bar', hasValue: true }])
    await screen.findByText('FOO')
    screen.getByText('bar')

    fireEvent.change(screen.getByPlaceholderText('NAME'), { target: { value: 'TOKEN' } })
    fireEvent.change(screen.getByPlaceholderText('value'), { target: { value: 's3cret' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByPlaceholderText(/hosts to inject into/), { target: { value: 'api.example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await screen.findByText('TOKEN')
    expect(server.called('PUT /api/project/alpha/env').map((c) => c.body)).toEqual([
      { name: 'TOKEN', value: 's3cret', secret: true, rule: { hosts: ['api.example.com'] } },
    ])
    // A secret shows masked, with where it is injected.
    screen.getByText('••••••••')
    screen.getByText('api.example.com · header authorization')
    expect(screen.getByPlaceholderText<HTMLInputElement>('NAME').value).toBe('')

    fireEvent.click(screen.getByRole('button', { name: 'Delete FOO' }))
    await waitFor(() => expect(screen.queryByText('FOO')).toBeNull())
    expect(server.called('DELETE /api/project/alpha/env/v1')).toHaveLength(1)
  })
})
