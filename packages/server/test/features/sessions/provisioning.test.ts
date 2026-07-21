import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('#features/sessions/notify', () => ({
  notifySessionListChanged: vi.fn(),
}))

import {
  registerProvisioning,
  updateProvisioningMessage,
  failProvisioning,
  removeProvisioning,
  runProvisioned,
  listProvisioning,
  clearAllProvisioningForTests,
} from '#features/sessions/provisioning'
import { notifySessionListChanged } from '#features/sessions/notify'
import { ServerError } from '@yaac/shared/errors'

const notify = vi.mocked(notifySessionListChanged)

beforeEach(() => {
  clearAllProvisioningForTests()
  notify.mockClear()
})

function register(id: string, over: Partial<{ projectSlug: string; tool: 'claude' | 'codex' | 'opencode'; kind: 'create' | 'restart'; message: string }> = {}): void {
  registerProvisioning({ sessionId: id, projectSlug: 'p', tool: 'claude', kind: 'create', ...over })
}

describe('registerProvisioning', () => {
  it('inserts an entry with a default message and notifies', () => {
    register('a')
    const list = listProvisioning()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ sessionId: 'a', projectSlug: 'p', tool: 'claude', kind: 'create', message: 'Starting…' })
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
    expect(listProvisioning()[0]).toMatchObject({ sessionId: 'a', error: 'no token' })
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
    expect(listProvisioning()[0]).toMatchObject({ sessionId: 'a', error: 'missing' })
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
  it('projects to the wire shape, sorted oldest first', () => {
    register('b')
    register('a')
    const list = listProvisioning()
    // Both registered ~now; tie broken by sessionId for determinism.
    expect(list.map((e) => e.sessionId)).toEqual(['a', 'b'])
    expect(list[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })
})

describe('no cap', () => {
  it('keeps every tracked entry (no eviction)', () => {
    for (let i = 0; i < 60; i++) register(`s${i}`)
    expect(listProvisioning()).toHaveLength(60)
  })
})
