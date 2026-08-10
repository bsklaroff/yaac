import { describe, it, expect, vi } from 'vitest'
import { withUpstreamConfigLock } from '#domain/worktrees/create'

describe('withUpstreamConfigLock', () => {
  it('serializes tasks on one project', async () => {
    const order: string[] = []
    let releaseFirst!: () => void
    const gate = new Promise<void>((r) => { releaseFirst = r })

    const first = withUpstreamConfigLock('p', async () => {
      order.push('first-start')
      await gate
      order.push('first-end')
    })
    const second = withUpstreamConfigLock('p', () => {
      order.push('second')
      return Promise.resolve()
    })

    // Give the second task a chance to (incorrectly) run early.
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual(['first-start'])

    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first-start', 'first-end', 'second'])
  })

  it('runs different projects concurrently', async () => {
    const order: string[] = []
    let releaseA!: () => void
    const gateA = new Promise<void>((r) => { releaseA = r })

    const a = withUpstreamConfigLock('a', async () => { await gateA; order.push('a') })
    const b = withUpstreamConfigLock('b', () => { order.push('b'); return Promise.resolve() })

    await b
    expect(order).toEqual(['b']) // b did not wait on a
    releaseA()
    await a
  })

  it('a failed predecessor does not poison the queue', async () => {
    const failing = withUpstreamConfigLock('p', () => Promise.reject(new Error('boom')))
    const task = vi.fn(() => Promise.resolve())
    const ok = withUpstreamConfigLock('p', task)

    await expect(failing).rejects.toThrow('boom')
    await expect(ok).resolves.toBeUndefined()
    expect(task).toHaveBeenCalledTimes(1)
  })
})
