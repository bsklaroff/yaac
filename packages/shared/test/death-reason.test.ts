import { describe, it, expect } from 'vitest'
import { describeWorktreeDeathReason } from '#death-reason'
import type { WorktreeDeathReason } from '#types'

describe('describeWorktreeDeathReason', () => {
  it('maps every reason to human copy', () => {
    const cases: Array<[WorktreeDeathReason, string]> = [
      ['oom', 'out of memory (hit the worktree memory limit)'],
      ['evicted', 'evicted by the node'],
      ['crashed', 'crashed'],
      ['pod-stopped', 'container stopped'],
      ['agent-exited', 'agent exited'],
      ['never-started', 'agent never started'],
      ['orphaned', 'removed outside yaac'],
    ]
    for (const [reason, copy] of cases) {
      expect(describeWorktreeDeathReason(reason)).toBe(copy)
    }
  })

  it('appends detail after an em-dash', () => {
    expect(describeWorktreeDeathReason('crashed', 'exit code 1'))
      .toBe('crashed — exit code 1')
  })
})
