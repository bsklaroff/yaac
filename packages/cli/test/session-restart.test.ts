import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import * as pods from '@yaac/server/platform/k8s/pods'
import * as cleanup from '@yaac/server/features/sessions/cleanup'
import * as sessionCreate from '@yaac/server/features/sessions/create'
import { resolveRestartTarget, restartSession } from '@yaac/server/features/sessions/restart'
import { recordSessionCreated } from '@yaac/server/features/sessions/store'
import { closeDb } from '@yaac/server/platform/db/client'
import { sessionRestart } from '#commands/session-restart'

import type { SessionPod } from '@yaac/server/platform/k8s/pods'

/**
 * Unit coverage for the session-restart pipeline: target resolution
 * (live pod first, recorded session row for reaped sessions) and the
 * handoff to `cleanupSession` + `createSession(resume: true)`. Pod
 * listing / createSession are mocked so we don't need a cluster.
 */
function pod(overrides: Partial<SessionPod> = {}): SessionPod {
  return {
    jobName: 'yaac-demo-abcd1234',
    podName: 'yaac-demo-abcd1234-p0d42',
    sessionId: 'abcd1234',
    projectSlug: 'demo',
    tool: 'claude',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: 1_700_000_000_000,
    labels: {},
    ...overrides,
  }
}

describe('resolveRestartTarget', () => {
  let tmpDir: string
  let listSpy: ReturnType<typeof vi.fn<() => Promise<SessionPod[]>>>

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    listSpy = vi.fn()
    vi.spyOn(pods, 'listSessionPods').mockImplementation(
      listSpy as unknown as typeof pods.listSessionPods,
    )
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('resolves from a live pod by exact session id', async () => {
    listSpy.mockResolvedValueOnce([pod()])
    const info = await resolveRestartTarget('abcd1234')
    expect(info).toEqual({
      projectSlug: 'demo',
      sessionId: 'abcd1234',
      tool: 'claude',
      jobName: 'yaac-demo-abcd1234',
    })
  })

  it('resolves tool=codex from the pod label', async () => {
    listSpy.mockResolvedValueOnce([pod({ tool: 'codex' })])
    const info = await resolveRestartTarget('abcd1234')
    expect(info.tool).toBe('codex')
  })

  it('resolves tool=opencode from the pod label', async () => {
    listSpy.mockResolvedValueOnce([pod({ tool: 'opencode' })])
    const info = await resolveRestartTarget('abcd1234')
    expect(info.tool).toBe('opencode')
  })

  it('resolves from a live pod by session id prefix', async () => {
    listSpy.mockResolvedValueOnce([pod()])
    const info = await resolveRestartTarget('abcd')
    expect(info.sessionId).toBe('abcd1234')
    expect(info.jobName).toBe('yaac-demo-abcd1234')
  })

  it('falls back to the recorded session row for a reaped session', async () => {
    listSpy.mockResolvedValueOnce([])
    await recordSessionCreated({ projectSlug: 'demo', sessionId: 'deadbeefdeadbeef', tool: 'claude' })
    const info = await resolveRestartTarget('deadbeefdeadbeef')
    expect(info).toEqual({
      projectSlug: 'demo',
      sessionId: 'deadbeefdeadbeef',
      tool: 'claude',
      jobName: null,
    })
  })

  it('takes the tool from the row, for a tool that leaves no transcript', async () => {
    listSpy.mockResolvedValueOnce([])
    await recordSessionCreated({ projectSlug: 'demo', sessionId: 'ocsess', tool: 'opencode' })
    const info = await resolveRestartTarget('ocsess')
    expect(info.tool).toBe('opencode')
    expect(info.jobName).toBeNull()
  })

  it('resolves a recorded session by id prefix, across projects', async () => {
    listSpy.mockResolvedValueOnce([])
    await recordSessionCreated({ projectSlug: 'demo', sessionId: 'abcd1234ffff', tool: 'claude' })
    const info = await resolveRestartTarget('abcd')
    expect(info.sessionId).toBe('abcd1234ffff')
    expect(info.projectSlug).toBe('demo')
  })

  it('throws NOT_FOUND when no pod and no recorded session match', async () => {
    listSpy.mockResolvedValueOnce([])
    await expect(resolveRestartTarget('missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('falls through to the recorded row when the cluster is unavailable', async () => {
    listSpy.mockRejectedValueOnce(new Error('connection refused'))
    await recordSessionCreated({ projectSlug: 'demo', sessionId: 'xyz', tool: 'claude' })
    const info = await resolveRestartTarget('xyz')
    expect(info).toEqual({
      projectSlug: 'demo',
      sessionId: 'xyz',
      tool: 'claude',
      jobName: null,
    })
  })
})

describe('restartSession', () => {
  let tmpDir: string
  let listSpy: ReturnType<typeof vi.fn<() => Promise<SessionPod[]>>>
  let cleanupSpy: ReturnType<typeof vi.fn>
  let createSpy: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    listSpy = vi.fn()
    cleanupSpy = vi.fn().mockResolvedValue(undefined)
    createSpy = vi.fn().mockResolvedValue({
      sessionId: 'abcd1234',
      jobName: 'yaac-demo-abcd1234',
      forwardedPorts: [],
      tool: 'claude',
    })
    vi.spyOn(pods, 'listSessionPods').mockImplementation(
      listSpy as unknown as typeof pods.listSessionPods,
    )
    vi.spyOn(cleanup, 'cleanupSession').mockImplementation(
      cleanupSpy as unknown as typeof cleanup.cleanupSession,
    )
    vi.spyOn(sessionCreate, 'createSession').mockImplementation(
      createSpy as unknown as typeof sessionCreate.createSession,
    )
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('kills the live job first, then creates a resumed session', async () => {
    listSpy.mockResolvedValueOnce([pod()])

    const progress: string[] = []
    await restartSession('abcd1234', { onProgress: (m) => progress.push(m) })

    expect(cleanupSpy).toHaveBeenCalledWith({
      jobName: 'yaac-demo-abcd1234',
      projectSlug: 'demo',
      sessionId: 'abcd1234',
    })
    expect(createSpy).toHaveBeenCalledWith('demo', expect.objectContaining({
      resume: true,
      sessionId: 'abcd1234',
      tool: 'claude',
    }))
    expect(progress.some((m) => m.includes('Stopping session job yaac-demo-abcd1234'))).toBe(true)
  })

  it('skips cleanup when no pod exists and falls back to the recorded row', async () => {
    listSpy.mockResolvedValueOnce([])
    await recordSessionCreated({ projectSlug: 'demo', sessionId: 'deadbeef', tool: 'claude' })

    await restartSession('deadbeef')

    expect(cleanupSpy).not.toHaveBeenCalled()
    expect(createSpy).toHaveBeenCalledWith('demo', expect.objectContaining({
      resume: true,
      sessionId: 'deadbeef',
      tool: 'claude',
    }))
  })

  it('forwards gitUser into createSession', async () => {
    listSpy.mockResolvedValueOnce([pod()])

    await restartSession('abcd1234', {
      gitUser: { name: 'A', email: 'a@b' },
    })

    expect(createSpy).toHaveBeenCalledWith('demo', expect.objectContaining({
      gitUser: { name: 'A', email: 'a@b' },
    }))
  })
})

describe('sessionRestart (CLI shim)', () => {
  it('is exported as a function', () => {
    expect(typeof sessionRestart).toBe('function')
  })
})
