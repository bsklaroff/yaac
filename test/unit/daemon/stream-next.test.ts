import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import { getProjectsDir, projectDir } from '@/lib/project/paths'
import { pickNextStreamSession } from '@/daemon/stream-picker'
import type { WaitingSession } from '@/lib/session/waiting'
import type { ProjectMeta } from '@/types'

import type * as waitingModule from '@/lib/session/waiting'
import type * as statusModule from '@/lib/session/status'

vi.mock('@/lib/session/waiting', async () => {
  const actual = await vi.importActual<typeof waitingModule>('@/lib/session/waiting')
  return { ...actual, getWaitingSessions: vi.fn() }
})

vi.mock('@/commands/session-create', () => ({ createSession: vi.fn() }))
vi.mock('@/lib/session/status', async () => {
  const actual = await vi.importActual<typeof statusModule>('@/lib/session/status')
  return { ...actual, getSessionFirstMessage: vi.fn() }
})

import { getWaitingSessions } from '@/lib/session/waiting'
import { createSession } from '@/commands/session-create'
import { getSessionFirstMessage } from '@/lib/session/status'

const mockGetWaiting = vi.mocked(getWaitingSessions)
const mockCreate = vi.mocked(createSession)
const mockFirstMsg = vi.mocked(getSessionFirstMessage)

function makeSession(overrides: Partial<WaitingSession> = {}): WaitingSession {
  return {
    containerName: 'yaac-demo-a',
    sessionId: 'a',
    projectSlug: 'demo',
    created: 1_700_000_000,
    tool: 'claude',
    ...overrides,
  }
}

async function writeProject(slug: string): Promise<void> {
  const dir = path.join(getProjectsDir(), slug)
  await fs.mkdir(dir, { recursive: true })
  const meta: ProjectMeta = {
    slug,
    remoteUrl: `https://example.com/${slug}`,
    addedAt: '2026-01-01T00:00:00.000Z',
  }
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(meta))
}

describe('pickNextStreamSession', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    vi.resetAllMocks()
    mockFirstMsg.mockResolvedValue(undefined)
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('returns the first unvisited waiting session', async () => {
    const a = makeSession({ sessionId: 'a' })
    const b = makeSession({ sessionId: 'b' })
    mockGetWaiting.mockResolvedValue([a, b])

    const result = await pickNextStreamSession({
      project: 'demo',
      visited: [],
      lastOutcome: 'none',
    })

    expect(result).toMatchObject({
      done: false,
      sessionId: 'a',
      containerName: 'yaac-demo-a',
      lastVisited: 'a',
      visited: ['a'],
    })
  })

  it('rotates the visited set when every session has been visited, excluding lastVisited', async () => {
    const a = makeSession({ sessionId: 'a' })
    const b = makeSession({ sessionId: 'b' })
    mockGetWaiting.mockResolvedValue([a, b])
    mockFirstMsg.mockResolvedValue('a prompt')

    const result = await pickNextStreamSession({
      project: 'demo',
      visited: ['a', 'b'],
      lastVisited: 'b',
      lastOutcome: 'detached',
    })

    expect(result).toMatchObject({
      done: false,
      sessionId: 'a',
      visited: ['b', 'a'],
      lastVisited: 'a',
    })
  })

  it('exits with closed_blank when the only visited session has no prompt', async () => {
    const a = makeSession({ sessionId: 'a' })
    mockGetWaiting.mockResolvedValue([a])
    mockFirstMsg.mockResolvedValue(undefined)

    const result = await pickNextStreamSession({
      project: 'demo',
      visited: ['a'],
      lastVisited: 'a',
      lastOutcome: 'detached',
    })

    expect(result).toEqual({ done: true, reason: 'closed_blank' })
  })

  it('exits with closed_blank when lastOutcome is closed_blank and nothing waits', async () => {
    mockGetWaiting.mockResolvedValue([])

    const result = await pickNextStreamSession({
      project: 'demo',
      visited: ['x'],
      lastOutcome: 'closed_blank',
    })

    expect(result).toEqual({ done: true, reason: 'closed_blank' })
  })

  it('creates a new session when the project is known and nothing waits', async () => {
    mockGetWaiting.mockResolvedValue([])
    mockCreate.mockResolvedValue({
      sessionId: 'new',
      containerName: 'yaac-demo-new',
      forwardedPorts: [],
      tool: 'claude',
      claimedPrewarm: false,
    })

    const result = await pickNextStreamSession({
      project: 'demo',
      visited: [],
      lastOutcome: 'none',
    })

    expect(result).toMatchObject({
      done: false,
      sessionId: 'new',
      containerName: 'yaac-demo-new',
      projectSlug: 'demo',
      visited: ['new'],
      lastVisited: 'new',
    })
    expect(mockCreate).toHaveBeenCalledWith('demo', expect.objectContaining({ tool: 'claude' }))
  })

  it('returns needs_project with configured candidates when no project and no active containers', async () => {
    await writeProject('alpha')
    await writeProject('beta')
    mockGetWaiting.mockResolvedValue([])

    const result = await pickNextStreamSession({
      visited: [],
      lastOutcome: 'none',
    })

    expect(result).toEqual({
      done: true,
      reason: 'needs_project',
      candidates: ['alpha', 'beta'],
    })
  })

  it('returns no_active when no project is given and there are no configured projects', async () => {
    mockGetWaiting.mockResolvedValue([])
    await fs.rm(projectDir('unused'), { recursive: true, force: true })
    // wipe the projects dir
    await fs.rm(getProjectsDir(), { recursive: true, force: true })

    const result = await pickNextStreamSession({
      visited: [],
      lastOutcome: 'none',
    })

    expect(result).toEqual({ done: true, reason: 'no_active' })
  })
})
