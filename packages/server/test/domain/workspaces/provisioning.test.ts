import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('#notify', () => ({
  notifyWorkspaceListChanged: vi.fn(),
}))

import {
  ensureProvisioning,
  registerProvisioning,
  removeProvisioning,
  runProvisioned,
  listProvisioning,
  inFlightWorkspaceIds,
  clearAllProvisioningForTests,
} from '#domain/workspaces/provisioning'
import { notifyWorkspaceListChanged } from '#notify'
import { ServerError } from '@yaac/shared/errors'

const notify = vi.mocked(notifyWorkspaceListChanged)

beforeEach(() => {
  clearAllProvisioningForTests()
  notify.mockClear()
})

function register(id: string, over: Partial<{ projectSlug: string; tool: 'claude' | 'codex' | 'opencode'; kind: 'create' | 'restart'; message: string; model: string; modelName: string }> = {}): void {
  registerProvisioning({ workspaceId: id, projectSlug: 'p', tool: 'claude', kind: 'create', ...over })
}

/** Fail a registered entry the way a create does: its run rejects. */
async function fail(id: string, error: string): Promise<void> {
  await expect(runProvisioned(id, () => Promise.reject(new Error(error)))).rejects.toThrow(error)
}

describe('registerProvisioning', () => {
  // No cap: nothing is ever evicted.
  it('inserts entries with a default message and notifies', () => {
    register('a')
    const list = listProvisioning()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ workspaceId: 'a', projectSlug: 'p', tool: 'claude', kind: 'create', message: 'Starting…' })
    expect(typeof list[0].createdAt).toBe('string')
    expect(notify).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 60; i++) register(`s${i}`)
    expect(listProvisioning()).toHaveLength(61)
  })

  it('overwrites a failed entry on the same id (a retry), but refuses a live one', async () => {
    register('a', { message: 'first' })
    expect(() => register('a', { message: 'second' })).toThrow(
      expect.objectContaining({ code: 'CONFLICT' }) as Error,
    )
    expect(listProvisioning()[0].message).toBe('first')

    await fail('a', 'boom')
    register('a', { message: 'second' })
    const list = listProvisioning()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ message: 'second' })
    expect(list[0].error).toBeUndefined()
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

  it('marks the row failed and rethrows, and a retry’s progress clears the error', async () => {
    register('a')
    await expect(
      runProvisioned('a', () => Promise.reject(new ServerError('NOT_FOUND', 'missing'))),
    ).rejects.toThrow('missing')
    expect(listProvisioning()[0]).toMatchObject({
      workspaceId: 'a', error: 'missing',
    })

    let during: unknown
    await runProvisioned('a', (onProgress) => {
      onProgress('Pulling image…')
      during = listProvisioning()[0]
      return Promise.resolve()
    })
    expect(during).toMatchObject({ message: 'Pulling image…' })
    expect(during).not.toHaveProperty('error')
  })

  // The create route reserves the id before it streams. A run refused before
  // taking over the reservation (a bad group or model) drops the entry, since
  // its error already reached the caller. A run that started leaves the usual
  // failed row.
  it('drops a reservation the run never took over, and fails one it did', async () => {
    registerProvisioning({ workspaceId: 'a', projectSlug: 'p', tool: 'claude', kind: 'create', reserved: true })
    await expect(runProvisioned('a', () => Promise.reject(new Error('no such group')))).rejects.toThrow()
    expect(listProvisioning()).toEqual([])

    registerProvisioning({ workspaceId: 'b', projectSlug: 'p', tool: 'claude', kind: 'create', reserved: true })
    await expect(runProvisioned('b', () => {
      ensureProvisioning({ workspaceId: 'b', projectSlug: 'p', tool: 'codex', kind: 'create', model: 'gpt-6' })
      return Promise.reject(new Error('image pull failed'))
    })).rejects.toThrow()
    expect(listProvisioning()).toEqual([
      expect.objectContaining({ workspaceId: 'b', tool: 'codex', model: 'gpt-6', error: 'image pull failed' }),
    ])
  })

  // A late callback must not resurrect a removed entry.
  it('leaves the registry alone when the caller never registered a row', async () => {
    notify.mockClear()
    await runProvisioned('unregistered', (onProgress) => {
      onProgress('step')
      return Promise.resolve(1)
    })
    expect(listProvisioning()).toEqual([])
    // Only the post-success snapshot push; registry no-ops don't notify.
    expect(notify).toHaveBeenCalledTimes(1)
    await fail('unregistered', 'boom')
    expect(listProvisioning()).toEqual([])
  })
})

describe('listProvisioning', () => {
  it('projects to the wire shape, sorted oldest first (insertion order)', () => {
    register('b')
    register('a')
    const list = listProvisioning()
    // Ordered by an insertion counter, so the order holds even when both
    // share a millisecond timestamp.
    expect(list.map((e) => e.workspaceId)).toEqual(['b', 'a'])
    expect(list[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  // A create shows its model from the start; a restart has none, so the key
  // is absent rather than empty.
  it('carries the model a create launches with, and its name', () => {
    register('c', { model: 'claude-opus-5-5', modelName: 'Opus 5.5' })
    register('r')
    const [c, r] = listProvisioning()
    expect(c).toMatchObject({ model: 'claude-opus-5-5', modelName: 'Opus 5.5' })
    expect('model' in r).toBe(false)
  })
})

describe('inFlightWorkspaceIds', () => {
  it('reports every entry the server is still provisioning', () => {
    registerProvisioning({ workspaceId: 'a', projectSlug: 'p', tool: 'claude', kind: 'create' })
    registerProvisioning({ workspaceId: 'b', projectSlug: 'p', tool: 'claude', kind: 'restart' })
    expect(inFlightWorkspaceIds().sort()).toEqual(['a', 'b'])
  })

  // The in-flight set keeps sweeps from reaping mid-create. A failed row
  // lingers until dismissed, so counting it would shield the leftovers
  // forever.
  it('drops a failed entry, which is not still running', async () => {
    registerProvisioning({ workspaceId: 'a', projectSlug: 'p', tool: 'claude', kind: 'create' })
    registerProvisioning({ workspaceId: 'gone', projectSlug: 'p', tool: 'claude', kind: 'create' })
    await fail('gone', 'image build exploded')
    expect(inFlightWorkspaceIds()).toEqual(['a'])
    // The row survives for the user to dismiss.
    expect(listProvisioning().map((e) => e.workspaceId).sort()).toEqual(['a', 'gone'])
  })

  it('is empty with nothing provisioning', () => {
    expect(inFlightWorkspaceIds()).toEqual([])
  })
})
