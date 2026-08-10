import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerWorktreeControlStream,
  unregisterWorktreeControlStream,
  worktreeControlStreamSend,
  _clearControlStreamRegistryForTests,
  type ControlStreamSend,
} from '#runtime/status/control-stream-registry'

const send = (reply: string): ControlStreamSend => () => Promise.resolve(reply)

beforeEach(() => {
  _clearControlStreamRegistryForTests()
})

describe('session control-stream registry', () => {
  it('returns the registered channel and undefined for unknown jobs', async () => {
    const a = send('a')
    registerWorktreeControlStream('job-a', a)
    expect(worktreeControlStreamSend('job-a')).toBe(a)
    await expect(worktreeControlStreamSend('job-a')!('x')).resolves.toBe('a')
    expect(worktreeControlStreamSend('job-b')).toBeUndefined()
  })

  it('a re-registration replaces the earlier channel for the same job', () => {
    const gen1 = send('1')
    const gen2 = send('2')
    registerWorktreeControlStream('job', gen1)
    registerWorktreeControlStream('job', gen2)
    expect(worktreeControlStreamSend('job')).toBe(gen2)
  })

  it('unregister only removes the exact channel it is given', () => {
    const gen1 = send('1')
    const gen2 = send('2')
    registerWorktreeControlStream('job', gen1)
    registerWorktreeControlStream('job', gen2)
    // Generation 1's late teardown must not evict generation 2.
    unregisterWorktreeControlStream('job', gen1)
    expect(worktreeControlStreamSend('job')).toBe(gen2)
    unregisterWorktreeControlStream('job', gen2)
    expect(worktreeControlStreamSend('job')).toBeUndefined()
  })
})
