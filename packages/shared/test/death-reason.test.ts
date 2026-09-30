import { describe, it, expect } from 'vitest'
import { describeWorkspaceDeathReason } from '#death-reason'
import type { WorkspaceDeathReason } from '#types'

describe('describeWorkspaceDeathReason', () => {
  it('maps every reason to human copy', () => {
    const cases: Array<[WorkspaceDeathReason, string]> = [
      ['oom', 'out of memory (hit the workspace memory limit)'],
      ['evicted', 'evicted by the node'],
      ['crashed', 'crashed'],
      ['pod-stopped', 'container stopped'],
      ['agent-exited', 'agent exited'],
      ['never-started', 'agent never started'],
      ['orphaned', 'removed outside yaac'],
    ]
    for (const [reason, copy] of cases) {
      expect(describeWorkspaceDeathReason(reason)).toBe(copy)
    }
  })

  it('appends detail after an em-dash', () => {
    expect(describeWorkspaceDeathReason('crashed', 'exit code 1'))
      .toBe('crashed — exit code 1')
  })
})
