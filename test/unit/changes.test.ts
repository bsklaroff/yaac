import { describe, it, expect } from 'vitest'
import {
  statusFromCode,
  resolveRenamePath,
  parseNumstat,
  parseNameStatus,
  parseChangesOutput,
} from '@/lib/session/changes'

describe('statusFromCode', () => {
  it('maps git status letters', () => {
    expect(statusFromCode('A')).toBe('added')
    expect(statusFromCode('M')).toBe('modified')
    expect(statusFromCode('D')).toBe('deleted')
    expect(statusFromCode('R100')).toBe('renamed')
    expect(statusFromCode('C075')).toBe('copied')
    expect(statusFromCode('T')).toBe('typechange')
    expect(statusFromCode('X')).toBe('modified') // unknown → modified
  })
})

describe('resolveRenamePath', () => {
  it('collapses rename notations to the destination', () => {
    expect(resolveRenamePath('old.ts => new.ts')).toBe('new.ts')
    expect(resolveRenamePath('src/{old => new}/file.ts')).toBe('src/new/file.ts')
    expect(resolveRenamePath('plain/path.ts')).toBe('plain/path.ts')
  })
})

describe('parseNumstat', () => {
  it('reads add/delete counts and flags binary', () => {
    const m = parseNumstat('12\t3\tsrc/a.ts\n0\t9\tsrc/b.ts\n-\t-\timg/logo.png\n')
    expect(m.get('src/a.ts')).toEqual({ additions: 12, deletions: 3, binary: false })
    expect(m.get('src/b.ts')).toEqual({ additions: 0, deletions: 9, binary: false })
    expect(m.get('img/logo.png')).toEqual({ additions: 0, deletions: 0, binary: true })
  })
  it('keys renames by destination path', () => {
    const m = parseNumstat('4\t1\tsrc/{old => new}/x.ts\n')
    expect(m.get('src/new/x.ts')).toEqual({ additions: 4, deletions: 1, binary: false })
  })
})

describe('parseNameStatus', () => {
  it('parses statuses and takes the new path for renames', () => {
    const out = parseNameStatus('A\tsrc/new.ts\nM\tsrc/app.ts\nD\tsrc/gone.ts\nR100\told.ts\trenamed.ts\n')
    expect(out).toEqual([
      { path: 'src/new.ts', status: 'added' },
      { path: 'src/app.ts', status: 'modified' },
      { path: 'src/gone.ts', status: 'deleted' },
      { path: 'renamed.ts', status: 'renamed' },
    ])
  })
})

describe('parseChangesOutput', () => {
  const raw = [
    'BASE abc123def',
    '@@NUMSTAT@@',
    '10\t2\tsrc/app.ts',
    '5\t0\tsrc/new.ts',
    '@@NAMESTATUS@@',
    'M\tsrc/app.ts',
    'A\tsrc/new.ts',
    '@@DIFF@@',
    'diff --git a/src/app.ts b/src/app.ts',
    '@@ -1 +1,2 @@',
    ' existing',
    '+added line',
  ].join('\n')

  it('merges name-status + numstat into files and captures base + diff', () => {
    const out = parseChangesOutput(raw)
    expect(out.base).toBe('abc123def')
    expect(out.files).toEqual([
      { path: 'src/app.ts', status: 'modified', additions: 10, deletions: 2, binary: false },
      { path: 'src/new.ts', status: 'added', additions: 5, deletions: 0, binary: false },
    ])
    expect(out.diff).toContain('diff --git a/src/app.ts')
    expect(out.diff).toContain('+added line')
    expect(out.truncated).toBe(false)
  })

  it('flags truncation when the diff exceeds the cap', () => {
    const out = parseChangesOutput(raw, 20)
    expect(out.truncated).toBe(true)
    expect(out.diff.length).toBe(20)
    // The file list is still complete.
    expect(out.files).toHaveLength(2)
  })

  it('is empty-safe when nothing changed', () => {
    const out = parseChangesOutput('BASE deadbeef\n@@NUMSTAT@@\n@@NAMESTATUS@@\n@@DIFF@@\n')
    expect(out.base).toBe('deadbeef')
    expect(out.files).toEqual([])
    expect(out.diff).toBe('')
  })
})
