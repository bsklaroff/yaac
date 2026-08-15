import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('#notify', () => ({
  notifyWorktreeListChanged: vi.fn(),
}))

import {
  registerProvisioning,
  updateProvisioningMessage,
  failProvisioning,
  removeProvisioning,
  reportAgentLaunchFailure,
  runProvisioned,
  listProvisioning,
  inFlightWorktreeIds,
  clearAllProvisioningForTests,
} from '#domain/worktrees/provisioning'
import { notifyWorktreeListChanged } from '#notify'
import { ServerError } from '@yaac/shared/errors'

const notify = vi.mocked(notifyWorktreeListChanged)

beforeEach(() => {
  clearAllProvisioningForTests()
  notify.mockClear()
})

function register(id: string, over: Partial<{ projectSlug: string; tool: 'claude' | 'codex' | 'opencode'; kind: 'create' | 'restart'; message: string }> = {}): void {
  registerProvisioning({ worktreeId: id, projectSlug: 'p', tool: 'claude', kind: 'create', ...over })
}

describe('registerProvisioning', () => {
  it('inserts an entry with a default message and notifies', () => {
    register('a')
    const list = listProvisioning()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ worktreeId: 'a', projectSlug: 'p', tool: 'claude', kind: 'create', message: 'Starting…' })
    expect(typeof list[0].createdAt).toBe('string')
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('overwrites an existing id (e.g. a retry)', () => {
    register('a', { message: 'first' })
    register('a', { message: 'second' })
    const list = listProvisioning()
    expect(list).toHaveLength(1)
    expect(list[0].message).toBe('second')
  })
})

describe('updateProvisioningMessage', () => {
  it('updates the message and clears a prior error', () => {
    register('a')
    failProvisioning('a', 'boom')
    updateProvisioningMessage('a', 'Pulling image…')
    const e = listProvisioning()[0]
    expect(e.message).toBe('Pulling image…')
    expect(e.error).toBeUndefined()
  })

  it('is a no-op for an unknown id (no resurrection)', () => {
    notify.mockClear()
    updateProvisioningMessage('missing', 'x')
    expect(listProvisioning()).toEqual([])
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('failProvisioning', () => {
  it('marks an entry failed and keeps it', () => {
    register('a')
    failProvisioning('a', 'no token')
    expect(listProvisioning()[0]).toMatchObject({ worktreeId: 'a', error: 'no token' })
  })

  it('is a no-op for an unknown id', () => {
    failProvisioning('missing', 'x')
    expect(listProvisioning()).toEqual([])
  })

  it('carries the failure code to the snapshot, so a client can offer its recovery', () => {
    register('a')
    failProvisioning('a', 'codex is not installed', 'MISSING_TOOL')
    expect(listProvisioning()[0]).toMatchObject({ error: 'codex is not installed', errorCode: 'MISSING_TOOL' })
  })

  it('leaves the code off a failure that has none', () => {
    register('a')
    failProvisioning('a', 'something went wrong')
    expect(listProvisioning()[0]).not.toHaveProperty('errorCode')
  })
})

describe('reportAgentLaunchFailure', () => {
  const report = (id: string, error = 'agent "codex" exited right after launch') =>
    reportAgentLaunchFailure({ worktreeId: id, projectSlug: 'p', tool: 'codex', kind: 'create', error })

  it('lands a failed row for a launch that died after its create resolved', async () => {
    // The window probe is deliberately not awaited (its settle sleep would
    // sit on every create's wall clock), so its verdict arrives with the
    // create already gone. Re-registering is how it still reaches the user,
    // in the same overlay a create failure uses.
    await report('a')
    expect(listProvisioning()[0]).toMatchObject({
      worktreeId: 'a', tool: 'codex', kind: 'create',
      error: 'agent "codex" exited right after launch',
    })
  })

  it('keeps the failed row out of the in-flight set, so the reaper still owns the worktree', async () => {
    // Nothing is provisioning any more — the worktree is dying, and the
    // liveness watch and stale reaper are what handle that. A row that
    // shielded it would leave the corpse in the sidebar forever.
    await report('a', 'dead')
    expect(inFlightWorktreeIds()).toEqual([])
  })

  it('waits for the create still in flight, so its success cannot erase the verdict', async () => {
    // The probe fires from INSIDE the create, so "the verdict comes after"
    // is arithmetic, not an ordering anyone enforces. Report first and
    // runProvisioned's success path removes the row on its way out — the
    // silent ghost this reporting exists to kill. Here the verdict is filed
    // at the worst possible moment: mid-create.
    register('a')
    let filed: Promise<void> | undefined
    let release!: () => void
    const blocked = new Promise<void>((r) => { release = r })
    const run = runProvisioned('a', async () => {
      filed = report('a')
      await blocked
      return 'ok'
    })
    // Still mid-create: the verdict must not have touched the registry yet.
    await Promise.resolve()
    expect(listProvisioning()[0]?.error).toBeUndefined()

    release()
    await run
    await filed
    // The create dropped its row, and the verdict then put one back.
    expect(listProvisioning()[0]).toMatchObject({ worktreeId: 'a', error: 'agent "codex" exited right after launch' })
  })

  it('leaves a create that failed on its own to say why', async () => {
    // Waiting out the create means the verdict can find a row that already
    // failed. That error is the CAUSE and a missing agent window is its
    // consequence, so the useful message stays and the symptom is dropped.
    register('a')
    let filed: Promise<void> | undefined
    const run = runProvisioned('a', () => {
      filed = report('a', 'agent died')
      return Promise.reject(new Error('create blew up'))
    })
    await expect(run).rejects.toThrow('create blew up')
    await filed
    expect(listProvisioning()).toHaveLength(1)
    expect(listProvisioning()[0]?.error).toBe('create blew up')
  })
})

describe('removeProvisioning', () => {
  it('removes a tracked id and notifies', () => {
    register('a')
    notify.mockClear()
    removeProvisioning('a')
    expect(listProvisioning()).toEqual([])
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('does not notify when nothing was removed', () => {
    notify.mockClear()
    removeProvisioning('missing')
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('runProvisioned', () => {
  it('mirrors progress into the row, drops it on success, and returns the result', async () => {
    register('a')
    let messageDuringRun: string | undefined
    const result = await runProvisioned('a', (onProgress) => {
      onProgress('Creating job...')
      messageDuringRun = listProvisioning()[0]?.message
      return Promise.resolve('done')
    })
    expect(result).toBe('done')
    expect(messageDuringRun).toBe('Creating job...')
    expect(listProvisioning()).toEqual([])
  })

  it('marks the row failed via the error taxonomy and rethrows', async () => {
    register('a')
    await expect(
      runProvisioned('a', () => Promise.reject(new ServerError('NOT_FOUND', 'missing'))),
    ).rejects.toThrow('missing')
    expect(listProvisioning()[0]).toMatchObject({
      worktreeId: 'a', error: 'missing', errorCode: 'NOT_FOUND',
    })
  })

  it('leaves the registry alone when the caller never registered a row', async () => {
    notify.mockClear()
    await runProvisioned('unregistered', (onProgress) => {
      onProgress('step')
      return Promise.resolve(1)
    })
    expect(listProvisioning()).toEqual([])
    // Only the post-success snapshot push — registry no-ops don't notify.
    expect(notify).toHaveBeenCalledTimes(1)
  })
})

describe('listProvisioning', () => {
  it('projects to the wire shape, sorted oldest first (insertion order)', () => {
    register('b')
    register('a')
    const list = listProvisioning()
    // Ordered by a monotonic insertion counter, so 'b' (registered first)
    // comes first regardless of whether the two share a millisecond clock
    // read — the worktreeId tiebreak used to flip this under parallel load.
    expect(list.map((e) => e.worktreeId)).toEqual(['b', 'a'])
    expect(list[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })
})

describe('no cap', () => {
  it('keeps every tracked entry (no eviction)', () => {
    for (let i = 0; i < 60; i++) register(`s${i}`)
    expect(listProvisioning()).toHaveLength(60)
  })
})

describe('inFlightWorktreeIds', () => {
  it('reports every entry the server is still provisioning', () => {
    registerProvisioning({ worktreeId: 'a', projectSlug: 'p', tool: 'claude', kind: 'create' })
    registerProvisioning({ worktreeId: 'b', projectSlug: 'p', tool: 'claude', kind: 'restart' })
    expect(inFlightWorktreeIds().sort()).toEqual(['a', 'b'])
  })

  // THE reason this is a function and not `listProvisioning().map(…)`: the
  // set is what stops a sweep reaping mid-create, and a failed create's row
  // lingers with no TTL until the user dismisses it. Shielding on that row
  // would make one failed create protect its leftovers forever.
  it('drops a failed entry, which is not still running', () => {
    registerProvisioning({ worktreeId: 'a', projectSlug: 'p', tool: 'claude', kind: 'create' })
    registerProvisioning({ worktreeId: 'gone', projectSlug: 'p', tool: 'claude', kind: 'create' })
    failProvisioning('gone', 'image build exploded')
    expect(inFlightWorktreeIds()).toEqual(['a'])
    // The row itself survives for the user to dismiss.
    expect(listProvisioning().map((e) => e.worktreeId).sort()).toEqual(['a', 'gone'])
  })

  it('is empty with nothing provisioning', () => {
    expect(inFlightWorktreeIds()).toEqual([])
  })
})
