import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerSessionControlStream,
  unregisterSessionControlStream,
  sessionControlStreamSend,
  _clearControlStreamRegistryForTests,
  type ControlStreamSend,
} from '#lib/session/control-stream-registry'

const send = (reply: string): ControlStreamSend => () => Promise.resolve(reply)

beforeEach(() => {
  _clearControlStreamRegistryForTests()
})

describe('session control-stream registry', () => {
  it('returns the registered channel and undefined for unknown jobs', async () => {
    const a = send('a')
    registerSessionControlStream('job-a', a)
    expect(sessionControlStreamSend('job-a')).toBe(a)
    await expect(sessionControlStreamSend('job-a')!('x')).resolves.toBe('a')
    expect(sessionControlStreamSend('job-b')).toBeUndefined()
  })

  it('a re-registration replaces the earlier channel for the same job', () => {
    const gen1 = send('1')
    const gen2 = send('2')
    registerSessionControlStream('job', gen1)
    registerSessionControlStream('job', gen2)
    expect(sessionControlStreamSend('job')).toBe(gen2)
  })

  it('unregister only removes the exact channel it is given', () => {
    const gen1 = send('1')
    const gen2 = send('2')
    registerSessionControlStream('job', gen1)
    registerSessionControlStream('job', gen2)
    // Generation 1's late teardown must not evict generation 2.
    unregisterSessionControlStream('job', gen1)
    expect(sessionControlStreamSend('job')).toBe(gen2)
    unregisterSessionControlStream('job', gen2)
    expect(sessionControlStreamSend('job')).toBeUndefined()
  })
})
