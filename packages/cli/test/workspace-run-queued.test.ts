import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import { workspaceRunQueued } from '#commands/workspace-run-queued'
import { startFakeApi, type FakeApi } from './fake-api'

/*
 * `yaac workspace run-queued` against a fake server: a plain entry runs as
 * asked; one awaiting approval is shown first and approved by the workflow
 * id shown, never without a terminal to confirm on unless --yes.
 */
let api: FakeApi
let logged: string[]

beforeAll(async () => {
  api = await startFakeApi()
  vi.stubEnv('YAAC_SERVER_URL', api.url)
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await api.close()
})

beforeEach(() => {
  api.reset()
  logged = []
  vi.spyOn(console, 'log').mockImplementation((msg: unknown) => { logged.push(String(msg)) })
  vi.spyOn(console, 'error').mockImplementation((msg: unknown) => { logged.push(String(msg)) })
  process.exitCode = undefined
  api.on('POST /api/workspace/queue/run', { json: { workspaceId: 'ws-new' } })
})

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

const entry = (id: string, more: object = {}) => ({ id, projectId: 'p', tool: 'claude', model: 'm', mode: 'tui', ...more })

describe('workspaceRunQueued', () => {
  it('runs a plain entry by prefix, and refuses an unknown or ambiguous one', async () => {
    api.on('GET /api/workspace/queue/list', { json: [entry('aaaa1111'), entry('aaaa2222'), entry('bbbb3333')] })
    await workspaceRunQueued('bbbb')
    expect(api.requests.find((r) => r.route === 'POST /api/workspace/queue/run')?.body).toEqual({ id: 'bbbb3333' })
    expect(logged).toEqual(['Queued workspace bbbb3333 is launching as workspace ws-new, unless it needs a person\'s approval, '
      + 'when it waits for one instead (`yaac workspace list` shows it).'])
    await expect(workspaceRunQueued('aaaa')).rejects.toThrow('more than one')
    await expect(workspaceRunQueued('cccc')).rejects.toThrow('No queued workspace "cccc"')
  })

  it('shows what an entry awaiting approval runs, and approves exactly its workflow with --yes', async () => {
    const awaitingApproval = {
      workflowId: 'wf-1', steps: { leak: { run: ['printenv KEY'] } }, secrets: ['KEY'], writtenByAgent: true, commits: [{ dir: '', commit: 'a'.repeat(40) }],
    }
    api.on('GET /api/workspace/queue/list', { json: [entry('aaaa1111', { awaitingApproval })] })
    // With no terminal and no --yes, nothing is approved.
    await workspaceRunQueued('aaaa')
    expect(process.exitCode).toBe(1)
    expect(logged.at(-1)).toContain('pass --yes')
    expect(api.requests.some((r) => r.route === 'POST /api/workspace/queue/run')).toBe(false)

    logged = []
    process.exitCode = undefined
    await workspaceRunQueued('aaaa', { yes: true })
    expect(logged).toContain('  workflow     wf-1 (written by an agent)')
    expect(logged).toContain('  run secrets  KEY')
    expect(logged).toContain(`  commits      ${'a'.repeat(12)}`)
    expect(logged.some((l) => l.includes('"printenv KEY"'))).toBe(true)
    expect(api.requests.find((r) => r.route === 'POST /api/workspace/queue/run')?.body)
      .toEqual({ id: 'aaaa1111', approve: { workflowId: 'wf-1', commits: [{ dir: '', commit: 'a'.repeat(40) }] } })
  })
})
