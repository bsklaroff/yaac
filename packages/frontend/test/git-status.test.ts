import { describe, it, expect } from 'vitest'
import type { ChangeStatus, WorkspaceChange } from '@yaac/shared/types'
import { pathStatuses } from '#lib/gitStatus'

const change = (path: string, status: ChangeStatus): WorkspaceChange =>
  ({ path, status, additions: 1, deletions: 0, binary: false, stages: {} })

describe('pathStatuses', () => {
  it('gives each changed file its status and each folder the strongest beneath it', () => {
    const out = pathStatuses(
      [change('a/x.ts', 'added'), change('a/y.ts', 'modified'), change('a/b/z.ts', 'added'), change('c/new.ts', 'added')],
      ['a/b/w.ts', 'a/y.ts'],
    )
    expect(Object.fromEntries(out)).toEqual({
      'a/x.ts': 'added',
      // A conflict outranks how the file differs from the base.
      'a/y.ts': 'conflicted',
      'a/b/z.ts': 'added',
      'a/b/w.ts': 'conflicted',
      'a/b': 'conflicted',
      a: 'conflicted',
      'c/new.ts': 'added',
      c: 'added',
    })
  })
})
