import { describe, it, expect } from 'vitest'
import { parseWindowList, parseShellSessions, nextShellName } from '@/daemon/terminals'

describe('parseWindowList', () => {
  it('skips the agent (lowest-index) window and maps the rest', () => {
    const out = parseWindowList('0|@0|claude\n1|@3|dev-server\n2|@5|watcher\n')
    expect(out).toEqual([
      { target: 'window:@3', name: 'dev-server', kind: 'window' },
      { target: 'window:@5', name: 'watcher', kind: 'window' },
    ])
  })

  it('returns empty for a single-window session and garbage input', () => {
    expect(parseWindowList('0|@0|claude\n')).toEqual([])
    expect(parseWindowList('')).toEqual([])
    expect(parseWindowList('no pipes here\n???')).toEqual([])
  })

  it('keeps window names containing pipes intact', () => {
    expect(parseWindowList('0|@0|claude\n1|@1|a|b|c')).toEqual([
      { target: 'window:@1', name: 'a|b|c', kind: 'window' },
    ])
  })
})

describe('parseShellSessions', () => {
  it('keeps only scratch shells, numerically sorted', () => {
    const out = parseShellSessions('yaac\nshell-10\nshell\nshell-2\nview-123\n')
    expect(out.map((e) => e.name)).toEqual(['shell', 'shell-2', 'shell-10'])
    expect(out[0]).toEqual({ target: 'shell:shell', name: 'shell', kind: 'shell' })
  })

  it('returns empty when no shells exist', () => {
    expect(parseShellSessions('yaac\n')).toEqual([])
    expect(parseShellSessions('')).toEqual([])
  })
})

describe('nextShellName', () => {
  it('fills the first gap: shell, then shell-2, shell-3, …', () => {
    expect(nextShellName([])).toBe('shell')
    expect(nextShellName(parseShellSessions('shell'))).toBe('shell-2')
    expect(nextShellName(parseShellSessions('shell\nshell-2'))).toBe('shell-3')
    expect(nextShellName(parseShellSessions('shell\nshell-3'))).toBe('shell-2')
    // windows don't count
    expect(nextShellName(parseWindowList('0|@0|claude\n1|@1|shell'))).toBe('shell')
  })
})
