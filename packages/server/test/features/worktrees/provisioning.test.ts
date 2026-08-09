import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('#notify', () => ({
  notifyWorktreeListChanged: vi.fn(),
}))

import {
  registerProvisioning,
  updateProvisioningMessage,
  failProvisioning,
  removeProvisioning,
  runProvisioned,
  listProvisioning,
  inFlightWorktreeIds,
  clearAllProvisioningForTests,
} from '#features/worktrees/provisioning'
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
    expect(listProvisioning()[0]).toMatchObject({ worktreeId: 'a', error: 'missing' })
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
