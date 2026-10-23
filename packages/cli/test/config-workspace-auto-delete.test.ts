import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import { configWorkspaceAutoDelete } from '#commands/config-workspace-auto-delete'
import { ME, serveProjects, startFakeApi, type FakeApi } from './fake-api'

/*
 * `yaac config workspace-auto-delete` against a fake server. The terminal is
 * the process boundary here: stdin's TTY flag is stubbed, and the prompt
 * records the question it was asked and answers `answer`.
 */
const asked: string[] = []
let answer = false
vi.mock('@yaac/shared/confirm', () => ({
  confirmDefault: (question: string) => {
    asked.push(question)
    return Promise.resolve(answer)
  },
}))

let api: FakeApi
const BEFORE = '2026-10-16T12:00:00.000Z'
let logged: string[]
let errors: string[]

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
  asked.length = 0
  answer = false
  logged = []
  errors = []
  vi.spyOn(console, 'log').mockImplementation((msg: unknown) => { logged.push(String(msg)) })
  vi.spyOn(console, 'error').mockImplementation((msg: unknown) => { errors.push(String(msg)) })
  process.exitCode = undefined
  serveProjects(api, [['id-demo', 'demo']])
  api.on('GET /api/project/id-demo/workspace-auto-delete', (req) => ({
    json: { expired: Number(req.query.get('days')) === 7 ? 3 : 0, before: BEFORE },
  }))
  api.on('PUT /api/project/id-demo/workspace-auto-delete', { json: {
    deleted: 2, kept: [{ workspaceId: 'w1', reason: 'workspace w1 is running or still stopping; stop it first' }],
  } })
})

afterEach(() => {
  vi.restoreAllMocks()
  tty(undefined)
  process.exitCode = undefined
})

function tty(isTTY: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true, writable: true })
}

const puts = (): unknown[] => api.requests.filter((r) => r.route.startsWith('PUT ')).map((r) => r.body)

describe('configWorkspaceAutoDelete', () => {
  it('warns with the most it would delete, sets it only once confirmed, and reports what it kept', async () => {
    tty(true)
    await configWorkspaceAutoDelete('demo', '7')
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('Up to 3 workspace(s) are already past that and will be deleted irretrievably')
    expect(puts()).toEqual([])
    expect(logged).toEqual(['Aborted — nothing was changed or deleted.'])

    answer = true
    await configWorkspaceAutoDelete('demo', '7')
    expect(puts()).toEqual([{ days: 7, before: BEFORE }])
    expect(logged.slice(-3)).toEqual([
      'demo now deletes a workspace once it has been stopped 7 days; deleted 2 now.',
      'Kept 1 for now, deleted once they can be:',
      '  workspace w1 is running or still stopping; stop it first',
    ])
  })

  it('refuses without a terminal to confirm on, changing nothing', async () => {
    tty(false)
    await configWorkspaceAutoDelete('demo', '7')
    expect(process.exitCode).toBe(1)
    expect(errors).toEqual(['Auto-delete is only turned on from a terminal, where you confirm what it deletes.'])
    expect(asked).toEqual([])
    expect(puts()).toEqual([])
  })

  it('shows the setting, turns it off without asking, and rejects anything but whole days', async () => {
    await configWorkspaceAutoDelete('demo', undefined)
    api.on('GET /api/project/list', { json: [{ id: 'id-demo', name: 'demo', owner: ME, stoppedWorkspaceRetentionDays: 30 }] })
    await configWorkspaceAutoDelete('demo', undefined)
    expect(logged).toEqual([
      'demo keeps stopped workspaces until you delete them.',
      'demo deletes a workspace once it has been stopped 30 days.',
    ])

    await configWorkspaceAutoDelete('demo', 'off')
    expect(puts()).toEqual([{ days: null }])
    for (const bad of ['0', '1.5', '-3', 'week']) {
      await expect(configWorkspaceAutoDelete('demo', bad), bad).rejects.toThrow('not a whole number of days')
    }
    expect(asked).toEqual([])
  })
})
