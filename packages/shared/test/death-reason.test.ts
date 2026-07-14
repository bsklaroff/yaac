import { describe, it, expect } from 'vitest'
import { describeSessionDeathReason } from '#death-reason'
import type { SessionDeathReason } from '#types'

describe('describeSessionDeathReason', () => {
  it('maps every reason to human copy', () => {
    const cases: Array<[SessionDeathReason, string]> = [
      ['oom', 'out of memory (hit the session memory limit)'],
      ['evicted', 'evicted by the node'],
      ['crashed', 'crashed'],
      ['pod-stopped', 'container stopped'],
      ['agent-exited', 'agent exited'],
      ['never-started', 'agent never started'],
      ['orphaned', 'removed outside yaac'],
    ]
    for (const [reason, copy] of cases) {
      expect(describeSessionDeathReason(reason)).toBe(copy)
    }
  })

  it('appends detail after an em-dash', () => {
    expect(describeSessionDeathReason('crashed', 'exit code 1'))
      .toBe('crashed — exit code 1')
  })
})
