import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execSyncRetry } from '@/lib/exec'

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}))

import { execSync } from 'node:child_process'

const mockExecSync = vi.mocked(execSync)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('execSyncRetry', () => {
  it('returns result on first success', () => {
    mockExecSync.mockReturnValue(Buffer.from('ok'))
    const result = execSyncRetry('echo hi', { retryPatterns: ['fail'] })
    expect(result).toEqual(Buffer.from('ok'))
    expect(mockExecSync).toHaveBeenCalledTimes(1)
  })

  it('retries on matching stderr pattern', () => {
    const err = Object.assign(new Error('fail'), {
      stderr: Buffer.from('container state improper'),
    })
    mockExecSync
      .mockImplementationOnce(() => { throw err })
      .mockImplementationOnce(() => Buffer.from('')) // sleep
      .mockReturnValue(Buffer.from('ok'))

    const result = execSyncRetry('podman exec ctr true', {
      retryPatterns: ['container state improper'],
    })
    expect(result).toEqual(Buffer.from('ok'))
    // call 1: failed exec, call 2: sleep (0.2s), call 3: successful retry
    expect(mockExecSync).toHaveBeenCalledTimes(3)
    expect(mockExecSync).toHaveBeenNthCalledWith(2, 'sleep 0.2')
  })

  it('throws on non-matching stderr', () => {
    const err = Object.assign(new Error('fail'), {
      stderr: Buffer.from('no such container'),
    })
    mockExecSync.mockImplementation(() => { throw err })

    expect(() =>
      execSyncRetry('podman exec ctr true', {
        retryPatterns: ['container state improper'],
      }),
    ).toThrow('fail')
    expect(mockExecSync).toHaveBeenCalledTimes(1)
  })

  it('throws after exhausting retries', () => {
    const err = Object.assign(new Error('fail'), {
      stderr: Buffer.from('container state improper'),
    })
    mockExecSync.mockImplementation((cmd) => {
      if (typeof cmd === 'string' && cmd.startsWith('sleep')) return Buffer.from('')
      throw err
    })

    expect(() =>
      execSyncRetry('podman exec ctr true', {
        retries: 3,
        retryPatterns: ['container state improper'],
      }),
    ).toThrow('fail')
    // 3 attempts + 2 sleeps between them
    expect(mockExecSync).toHaveBeenCalledTimes(5)
  })

  it('uses exponential backoff with cap at 3200ms', () => {
    const err = Object.assign(new Error('fail'), {
      stderr: Buffer.from('container state improper'),
    })
    const sleepCalls: string[] = []
    mockExecSync.mockImplementation((cmd) => {
      if (typeof cmd === 'string' && cmd.startsWith('sleep')) {
        sleepCalls.push(cmd)
        return Buffer.from('')
      }
      throw err
    })

    expect(() =>
      execSyncRetry('podman exec ctr true', {
        retries: 6,
        retryPatterns: ['container state improper'],
      }),
    ).toThrow('fail')
    // 6 attempts + 5 sleeps = 11 calls
    expect(mockExecSync).toHaveBeenCalledTimes(11)
    expect(sleepCalls).toEqual([
      'sleep 0.2',   // 200ms
      'sleep 0.4',   // 400ms
      'sleep 0.8',   // 800ms
      'sleep 1.6',   // 1600ms
      'sleep 3.2',   // 3200ms (cap)
    ])
  })

  it('works with no retry options (no retries)', () => {
    mockExecSync.mockReturnValue(Buffer.from('ok'))
    const result = execSyncRetry('echo hi')
    expect(result).toEqual(Buffer.from('ok'))
  })
})
