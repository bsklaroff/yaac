import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerWorkspaceControlStream,
  unregisterWorkspaceControlStream,
  workspaceControlStreamSend,
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
    registerWorkspaceControlStream('job-a', a)
    expect(workspaceControlStreamSend('job-a')).toBe(a)
    await expect(workspaceControlStreamSend('job-a')!('x')).resolves.toBe('a')
    expect(workspaceControlStreamSend('job-b')).toBeUndefined()
  })

  it('a re-registration replaces the earlier channel for the same job', () => {
    const gen1 = send('1')
    const gen2 = send('2')
    registerWorkspaceControlStream('job', gen1)
    registerWorkspaceControlStream('job', gen2)
    expect(workspaceControlStreamSend('job')).toBe(gen2)
  })

  it('unregister only removes the exact channel it is given', () => {
    const gen1 = send('1')
    const gen2 = send('2')
    registerWorkspaceControlStream('job', gen1)
    registerWorkspaceControlStream('job', gen2)
    // Generation 1's late teardown must not evict generation 2.
    unregisterWorkspaceControlStream('job', gen1)
    expect(workspaceControlStreamSend('job')).toBe(gen2)
    unregisterWorkspaceControlStream('job', gen2)
    expect(workspaceControlStreamSend('job')).toBeUndefined()
  })
})
