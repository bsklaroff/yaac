import { describe, it, expect } from 'vitest'
import { queuedDescendants, queuedInTreeOrder, queuedTitle } from '#lib/queued'
import type { QueuedWorktreeEntry } from '@yaac/shared/types'

const q = (id: string, parent: { worktree?: string; queued?: string }, prompt = id): QueuedWorktreeEntry => ({
  id,
  projectSlug: 'p',
  ...(parent.worktree !== undefined ? { parentWorktreeId: parent.worktree } : {}),
  ...(parent.queued !== undefined ? { parentQueuedId: parent.queued } : {}),
  prompt,
  tool: 'claude',
  model: 'm',
  mode: 'tui',
  permissionMode: 'bypass',
  branch: 'main',
  createdAt: '2026-01-01 00:00:00',
})

// A forest: w ← a ← b ← c, and w ← d; plus x ← e.
const entries = [
  q('a', { worktree: 'w' }),
  q('e', { worktree: 'x' }),
  q('c', { queued: 'b' }),
  q('b', { queued: 'a' }),
  q('d', { worktree: 'w' }),
]

describe('queued helpers', () => {
  it('orders a chain under its top, as the sidebar draws it', () => {
    expect(queuedInTreeOrder(entries).map((e) => e.id)).toEqual(['a', 'b', 'c', 'e', 'd'])
  })

  it('finds everything below an entry, at any depth', () => {
    expect([...queuedDescendants(entries, 'a')].sort()).toEqual(['b', 'c'])
    expect([...queuedDescendants(entries, 'd')]).toEqual([])
  })

  it('titles an entry by its own title, else its first non-blank line', () => {
    expect(queuedTitle({ prompt: '\n  fix it  \nthen more' })).toBe('fix it')
    expect(queuedTitle({ prompt: 'fix it', title: 'Named' })).toBe('Named')
  })
})
