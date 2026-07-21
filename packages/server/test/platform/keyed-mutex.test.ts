import { describe, it, expect, vi } from 'vitest'
import { createKeyedMutex } from '#platform/keyed-mutex'

describe('createKeyedMutex', () => {
  it('serializes tasks sharing a key in submission order', async () => {
    const run = createKeyedMutex()
    const order: string[] = []
    let releaseFirst!: () => void
    const gate = new Promise<void>((r) => { releaseFirst = r })

    const first = run('k', async () => {
      order.push('first-start')
      await gate
      order.push('first-end')
    })
    const second = run('k', () => {
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

  it('runs distinct keys concurrently', async () => {
    const run = createKeyedMutex()
    const order: string[] = []
    let releaseA!: () => void
    const gateA = new Promise<void>((r) => { releaseA = r })

    const a = run('a', async () => { await gateA; order.push('a') })
    const b = run('b', () => { order.push('b'); return Promise.resolve() })

    await b
    expect(order).toEqual(['b']) // b did not wait on a
    releaseA()
    await a
  })

  it('a failed predecessor does not poison the queue', async () => {
    const run = createKeyedMutex()
    const failing = run('k', () => Promise.reject(new Error('boom')))
    const task = vi.fn(() => Promise.resolve())
    const ok = run('k', task)

    await expect(failing).rejects.toThrow('boom')
    await expect(ok).resolves.toBeUndefined()
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('returns each task\'s own value', async () => {
    const run = createKeyedMutex()
    const [a, b] = await Promise.all([
      run('k', () => Promise.resolve(1)),
      run('k', () => Promise.resolve('two')),
    ])
    expect(a).toBe(1)
    expect(b).toBe('two')
  })
})
