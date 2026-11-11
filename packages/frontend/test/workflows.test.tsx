import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { StepGraph } from '@yaac/shared/steps'
import type { WorkflowEntry } from '@yaac/shared/types'
import { Workflows } from '#components/settings/Workflows'
import { mockFetch, projectRepo, renderWithClient, serverError, type FetchCall, type FetchMock } from './harness'

/*
 * A project's workflows in its settings (docs/workflows.md): each one's
 * steps, repos, run secrets and approvals, whether it runs at workspace
 * start, and creating, editing and deleting one; and the init workflows
 * section, which is that list filtered. A site's choice of a workflow is in
 * sites.test.
 */

const DEPLOY: StepGraph = { build: { run: ['pnpm build'] }, deploy: { run: ['pnpm deploy'], needs: ['build'] } }

const entry = (name: string, steps: StepGraph, secrets: string[], more: Partial<WorkflowEntry> = {}): WorkflowEntry => ({
  id: `wf-${name}`, projectId: 'proj', name, steps, secrets, repos: [], init: false, approvedCommits: [], approvedBranches: [], createdAt: '',
  ...more,
})
const REPOS = [projectRepo({ id: 'r-web', dir: 'web' }), projectRepo({ id: 'r-api', dir: 'api' })]

let workflows: WorkflowEntry[]
let server: FetchMock
beforeEach(() => {
  workflows = [{
    ...entry('release', DEPLOY, ['P8_KEY']),
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
      const { name, steps, secrets, repos, init } = body as WorkflowEntry
      workflows = [...workflows, entry(name, steps, secrets, { repos, init })]
      return workflows.at(-1)
    },
    'POST /api/workflow/edit': ({ body }: FetchCall) => {
      const { name, steps, secrets, repos, init } = body as WorkflowEntry
      const w = workflows.find((x) => x.name === name) as WorkflowEntry
      Object.assign(w, { steps, secrets, repos, init })
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
    renderWithClient(<Workflows projectId="proj" repos={REPOS} readOnly={false} />)
    expect(await screen.findByText('release')).toBeTruthy()
    expect(server.called('GET /api/workflow/list')[0].query.get('project')).toBe('proj')
    expect(row('release')).toBe('releaseEdit'
      + 'steps: build, deployrepos: none (runs in the workspace\'s cwd)run secrets: P8_KEYapproved: 0123456789ab, branch main')

    fireEvent.click(screen.getByRole('button', { name: 'Add workflow' }))
    fireEvent.change(screen.getByLabelText('Workflow name'), { target: { value: ' publish ' } })
    const steps = screen.getByLabelText('Workflow steps')
    const create = screen.getByRole('button', { name: 'Create workflow' })
    fireEvent.change(steps, { target: { value: '[]' } })
    fireEvent.click(create)
    expect(await screen.findByText('Steps must be a JSON object')).toBeTruthy()

    fireEvent.change(steps, { target: { value: JSON.stringify(DEPLOY) } })
    fireEvent.click(await screen.findByRole('checkbox', { name: 'NPM_TOKEN' }))
    // Its repos, and whether it runs at workspace start.
    fireEvent.click(screen.getByRole('checkbox', { name: 'web' }))
    expect(screen.getByRole<HTMLInputElement>('switch', { name: 'Run at workspace start' }).checked).toBe(false)
    fireEvent.click(create)
    expect(await screen.findByText('publish')).toBeTruthy()
    expect(server.called('POST /api/workflow/create').at(-1)?.body).toEqual({
      project: 'proj', name: 'publish', steps: DEPLOY, secrets: ['NPM_TOKEN'], repos: ['web'], init: false,
    })
    expect(screen.queryByLabelText('Workflow name')).toBeNull()
    expect(row('publish')).toContain('run secrets: NPM_TOKEN')
    expect(row('publish')).toContain('repos: web')
  })

  it('edits a workflow, always sending its whole graph with its secrets', async () => {
    renderWithClient(<Workflows projectId="proj" repos={REPOS} readOnly={false} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit workflow release' }))
    expect(screen.queryByLabelText('Workflow name')).toBeNull()
    expect(screen.getByLabelText<HTMLTextAreaElement>('Workflow steps').value).toBe(`${JSON.stringify(DEPLOY, null, 2)}\n`)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'P8_KEY' }).checked).toBe(true)

    fireEvent.click(await screen.findByRole('checkbox', { name: 'NPM_TOKEN' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'P8_KEY' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'api' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Run at workspace start' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' }))
    await waitFor(() => expect(row('release')).toContain('run secrets: NPM_TOKEN'))
    expect(server.called('POST /api/workflow/edit')[0].body).toEqual({
      project: 'proj', name: 'release', steps: DEPLOY, secrets: ['NPM_TOKEN'], repos: ['api'], init: true,
    })
    expect(row('release')).toContain('runs at workspace start')
  })

  it('deletes a workflow, and shows why one a site runs is kept', async () => {
    workflows.push(entry('lint', { lint: { run: ['pnpm lint'] } }, []))
    renderWithClient(<Workflows projectId="proj" repos={REPOS} readOnly={false} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete workflow release' }))
    expect(await screen.findByText('site "web" runs workflow "release"')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Delete workflow lint' }))
    await waitFor(() => expect(screen.queryByText('lint')).toBeNull())
    expect(server.called('POST /api/workflow/delete').map((c) => c.body))
      .toEqual([{ project: 'proj', name: 'release' }, { project: 'proj', name: 'lint' }])
    expect(screen.getByText('release')).toBeTruthy()
  })

  it('lists only the init workflows in the init section, adding one marked to run at workspace start', async () => {
    workflows.push(entry('web-init', { install: { run: ['pnpm i'] } }, [], { repos: ['web'], init: true }))
    renderWithClient(<Workflows projectId="proj" repos={REPOS} readOnly={false} init />)
    expect(await screen.findByText('web-init')).toBeTruthy()
    expect(screen.queryByText('release')).toBeNull()
    expect(row('web-init')).toContain('repos: web')
    fireEvent.click(screen.getByRole('button', { name: 'Add init workflow' }))
    expect(screen.getByRole<HTMLInputElement>('switch', { name: 'Run at workspace start' }).checked).toBe(true)
    fireEvent.change(screen.getByLabelText('Workflow name'), { target: { value: 'api-init' } })
    fireEvent.change(screen.getByLabelText('Workflow steps'), { target: { value: '{"install": {"run": "pip install"}}' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'api' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create workflow' }))
    expect(await screen.findByText('api-init')).toBeTruthy()
    expect(server.called('POST /api/workflow/create').at(-1)?.body).toMatchObject({ name: 'api-init', repos: ['api'], init: true })
  })

  it('only lists a teammate\'s workflows', async () => {
    renderWithClient(<Workflows projectId="proj" repos={REPOS} readOnly />)
    expect(await screen.findByText('release')).toBeTruthy()
    for (const name of ['Add workflow', 'Edit workflow release', 'Delete workflow release']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
  })
})
