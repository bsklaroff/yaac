import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { StepGraph } from '@yaac/shared/steps'
import type { WorkflowEntry } from '@yaac/shared/types'
import { Workflows } from '#components/settings/Workflows'
import { mockFetch, renderWithClient, serverError, type FetchCall, type FetchMock } from './harness'

/*
 * A project's workflows in its settings (docs/workflows.md): each one's
 * current revision and approvals, and creating, editing and deleting one.
 * A site's choice of a workflow is in sites.test.
 */

const DEPLOY: StepGraph = { build: { run: ['pnpm build'] }, deploy: { run: ['pnpm deploy'], needs: ['build'] } }

const entry = (name: string, number: number, steps: StepGraph, secrets: string[]): WorkflowEntry => ({
  id: `wf-${name}`, projectId: 'proj', name, current: { number, steps, secrets, createdAt: '' },
  approvedCommits: [], approvedBranches: [], createdAt: '',
})

let workflows: WorkflowEntry[]
let server: FetchMock
beforeEach(() => {
  workflows = [{
    ...entry('release', 3, DEPLOY, ['P8_KEY']),
    approvedCommits: ['0123456789abcdef0123456789abcdef01234567'], approvedBranches: ['main'],
  }]
  // A server that keeps its workflows in `workflows`, and refuses to delete
  // one a site runs.
  server = mockFetch({
    'GET /api/workflow/list': () => workflows,
    'GET /api/project/proj/run-secrets': { secrets: [
      { id: 'rs1', name: 'P8_KEY', hasValue: true }, { id: 'rs2', name: 'NPM_TOKEN', hasValue: true },
    ] },
    'POST /api/workflow/create': ({ body }: FetchCall) => {
      const { name, steps, secrets } = body as { name: string; steps: StepGraph; secrets: string[] }
      workflows = [...workflows, entry(name, 1, steps, secrets)]
      return workflows.at(-1)
    },
    'POST /api/workflow/edit': ({ body }: FetchCall) => {
      const { name, steps, secrets } = body as { name: string; steps: StepGraph; secrets: string[] }
      const w = workflows.find((x) => x.name === name) as WorkflowEntry
      w.current = { number: w.current.number + 1, steps, secrets, createdAt: '' }
      return w
    },
    'POST /api/workflow/delete': ({ body }: FetchCall) => {
      const { name } = body as { name: string }
      if (name === 'release') return serverError('CONFLICT', 'site "web" runs workflow "release"', 409)
      workflows = workflows.filter((w) => w.name !== name)
      return undefined
    },
  })
})
afterEach(cleanup)

const row = (name: string): string | null | undefined => screen.getByText(name).closest('.rounded-md')?.textContent

describe('Workflows settings', () => {
  it('lists each workflow with its approvals, and creates one given a run secret', async () => {
    renderWithClient(<Workflows projectId="proj" readOnly={false} />)
    expect(await screen.findByText('release')).toBeTruthy()
    expect(server.called('GET /api/workflow/list')[0].query.get('project')).toBe('proj')
    expect(row('release')).toBe('releaserevision 3Edit'
      + 'steps: build, deployrun secrets: P8_KEYapproved: 0123456789ab, branch main')

    fireEvent.click(screen.getByRole('button', { name: 'Add workflow' }))
    fireEvent.change(screen.getByLabelText('Workflow name'), { target: { value: ' publish ' } })
    const steps = screen.getByLabelText('Workflow steps')
    const create = screen.getByRole('button', { name: 'Create workflow' })
    fireEvent.change(steps, { target: { value: '[]' } })
    fireEvent.click(create)
    expect(await screen.findByText('Steps must be a JSON object')).toBeTruthy()

    fireEvent.change(steps, { target: { value: JSON.stringify(DEPLOY) } })
    fireEvent.click(await screen.findByRole('checkbox', { name: 'NPM_TOKEN' }))
    fireEvent.click(create)
    expect(await screen.findByText('publish')).toBeTruthy()
    expect(server.called('POST /api/workflow/create').at(-1)?.body).toEqual({
      project: 'proj', name: 'publish', steps: DEPLOY, secrets: ['NPM_TOKEN'],
    })
    expect(screen.queryByLabelText('Workflow name')).toBeNull()
    expect(row('publish')).toContain('run secrets: NPM_TOKEN')
  })

  it('edits a workflow, always sending its whole graph with its secrets', async () => {
    renderWithClient(<Workflows projectId="proj" readOnly={false} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit workflow release' }))
    expect(screen.queryByLabelText('Workflow name')).toBeNull()
    expect(screen.getByLabelText<HTMLTextAreaElement>('Workflow steps').value).toBe(`${JSON.stringify(DEPLOY, null, 2)}\n`)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'P8_KEY' }).checked).toBe(true)

    fireEvent.click(await screen.findByRole('checkbox', { name: 'NPM_TOKEN' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'P8_KEY' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' }))
    await waitFor(() => expect(row('release')).toContain('revision 4'))
    expect(server.called('POST /api/workflow/edit')[0].body).toEqual({
      project: 'proj', name: 'release', steps: DEPLOY, secrets: ['NPM_TOKEN'],
    })
  })

  it('deletes a workflow, and shows why one a site runs is kept', async () => {
    workflows.push(entry('lint', 1, { lint: { run: ['pnpm lint'] } }, []))
    renderWithClient(<Workflows projectId="proj" readOnly={false} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete workflow release' }))
    expect(await screen.findByText('site "web" runs workflow "release"')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Delete workflow lint' }))
    await waitFor(() => expect(screen.queryByText('lint')).toBeNull())
    expect(server.called('POST /api/workflow/delete').map((c) => c.body))
      .toEqual([{ project: 'proj', name: 'release' }, { project: 'proj', name: 'lint' }])
    expect(screen.getByText('release')).toBeTruthy()
  })

  it('only lists a teammate\'s workflows', async () => {
    renderWithClient(<Workflows projectId="proj" readOnly />)
    expect(await screen.findByText('release')).toBeTruthy()
    for (const name of ['Add workflow', 'Edit workflow release', 'Delete workflow release']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
  })
})
