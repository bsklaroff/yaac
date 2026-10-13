import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('#lib/notify', () => ({
  notifyWorkspaceListChanged: vi.fn(),
}))

import { dismissProvisioning, listProvisioning } from '#domain/workspaces'
import {
  clearAllProvisioningForTests,
  inFlightWorkspaceIds,
  provision,
  registerProvisioning,
} from '#domain/workspaces/provisioning'
import { notifyWorkspaceListChanged } from '#lib/notify'
import { ServerError } from '@yaac/shared/errors'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { DEMO_PROJECT_ID, recordTestProject } from '@yaac/test-utils/project-fixture'
import { BUILT_IN_USER_ID, closeDb } from '#db'

const notify = vi.mocked(notifyWorkspaceListChanged)

beforeEach(() => {
  clearAllProvisioningForTests()
  notify.mockClear()
})

/** A provision of `id`, as a create registers one. */
const entry = (id: string, over: { model?: string; modelName?: string; kind?: 'create' | 'restart' } = {}) =>
  ({ workspaceId: id, projectId: 'p', tool: 'claude' as const, kind: 'create' as const, ...over })

/**
 * The registry the snapshot shows as sidebar rows, driven as creates and
 * restarts drive it: register, run, settle.
 */
describe('listProvisioning', () => {
  it('shows each provision from registration in the wire shape, oldest first, and drops it on success', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const run = provision(entry('b', { model: 'claude-opus-5-5', modelName: 'Opus 5.5' }), async (onProgress) => {
      onProgress('Creating job...')
      await held
      return { workspaceId: 'b' }
    })
    registerProvisioning(entry('a', { kind: 'restart' }))
    expect(notify).toHaveBeenCalledTimes(2)

    const progress: string[] = []
    const result = run((m) => progress.push(m))
    await vi.waitFor(() => { expect(listProvisioning()[0].message).toBe('Creating job...') })

    // Ordered by an insertion counter, so the order holds even when both
    // share a millisecond timestamp. A restart has no model, so the key is
    // absent rather than empty.
    const [b, a] = listProvisioning()
    expect(b).toMatchObject({
      workspaceId: 'b', projectId: 'p', tool: 'claude', kind: 'create', model: 'claude-opus-5-5', modelName: 'Opus 5.5',
    })
    expect(b.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(a).toMatchObject({ workspaceId: 'a', kind: 'restart', message: 'Starting…' })
    expect('model' in a).toBe(false)
    // An id still provisioning is refused, and stays as it was.
    expect(() => registerProvisioning(entry('b'))).toThrow(expect.objectContaining({ code: 'CONFLICT' }) as Error)
    expect(inFlightWorkspaceIds().sort()).toEqual(['a', 'b'])

    release()
    expect(await result).toEqual({ workspaceId: 'b' })
    expect(progress).toEqual(['Creating job...'])
    expect(listProvisioning().map((e) => e.workspaceId)).toEqual(['a'])
  })

  // A create can throw while a step it started keeps running (the checkout
  // still fetching), so progress can arrive after the row failed. It must not
  // clear the error, or the row looks in progress with nothing left to end it.
  // The in-flight set keeps sweeps from reaping mid-create, so a failed row,
  // whose rollback already ran, leaves it.
  it('keeps a failed provision until dismissed, deaf to late progress, and a retry starts clean', async () => {
    let lateProgress!: (message: string) => void
    await expect(provision(entry('a'), (onProgress) => {
      lateProgress = onProgress
      return Promise.reject(new ServerError('NOT_FOUND', 'missing'))
    })()).rejects.toThrow('missing')
    notify.mockClear()
    lateProgress('Creating workspace from main...')
    expect(listProvisioning()).toMatchObject([{ workspaceId: 'a', error: 'missing', message: 'Starting…' }])
    expect(inFlightWorkspaceIds()).toEqual([])
    expect(notify).not.toHaveBeenCalled()

    let during: unknown
    await provision(entry('a'), (onProgress) => {
      onProgress('Pulling image…')
      during = listProvisioning()[0]
      return Promise.resolve({ workspaceId: 'a' })
    })()
    expect(during).toMatchObject({ message: 'Pulling image…' })
    expect(during).not.toHaveProperty('error')
    expect(listProvisioning()).toEqual([])
  })
})

describe('dismissProvisioning', () => {
  let tmpDir: string
  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    await recordTestProject(DEMO_PROJECT_ID)
  })
  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('lets only the project\'s owner drop an entry, and notifies', async () => {
    registerProvisioning({ ...entry('a'), projectId: DEMO_PROJECT_ID })
    notify.mockClear()
    const teammate = { kind: 'tailnet', login: 'bob@example.com', name: 'bob', userId: 'b0b0b0b0-0000-4000-8000-000000000000' } as const
    await expect(dismissProvisioning(teammate, 'a')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(listProvisioning()).toHaveLength(1)

    await dismissProvisioning({ kind: 'local', userId: BUILT_IN_USER_ID }, 'a')
    expect(listProvisioning()).toEqual([])
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('is a silent no-op for an id with no entry', async () => {
    notify.mockClear()
    await dismissProvisioning({ kind: 'local', userId: BUILT_IN_USER_ID }, 'missing')
    expect(notify).not.toHaveBeenCalled()
  })
})
