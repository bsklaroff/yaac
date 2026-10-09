import { describe, it, expect } from 'vitest'
import {
  parseUnifiedDiff, indexDiffsByPath, diffTextPair, diffStats,
} from '#lib/diff'

const DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index c0d0fb4..0226208 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,2 +1,3 @@',
  ' line1',
  '-line2',
  '+line2 changed',
  '+line3',
  'diff --git a/new.ts b/new.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new.ts',
  '@@ -0,0 +1,2 @@',
  '+brand new',
  '+file',
  'diff --git a/logo.png b/logo.png',
  'index 111..222 100644',
  'Binary files a/logo.png and b/logo.png differ',
].join('\n')

describe('parseUnifiedDiff', () => {
  const files = parseUnifiedDiff(DIFF)

  it('splits into one entry per file, with paths resolved', () => {
    expect(files.map((f) => f.path)).toEqual(['src/app.ts', 'new.ts', 'logo.png'])
  })

  it('tracks line kinds and numbers for a modification', () => {
    const app = files[0]
    expect(app.lines).toEqual([
      { kind: 'hunk', text: '@@ -1,2 +1,3 @@', oldNo: null, newNo: null },
      { kind: 'context', text: 'line1', oldNo: 1, newNo: 1 },
      { kind: 'del', text: 'line2', oldNo: 2, newNo: null },
      { kind: 'add', text: 'line2 changed', oldNo: null, newNo: 2 },
      { kind: 'add', text: 'line3', oldNo: null, newNo: 3 },
    ])
  })

  it('resolves a new file to its b/ path', () => {
    expect(files[1].path).toBe('new.ts')
    expect(files[1].lines.filter((l) => l.kind === 'add')).toHaveLength(2)
  })

  it('flags binary files', () => {
    expect(files[2].binary).toBe(true)
    expect(files[2].lines).toEqual([])
  })

  it('returns [] for an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([])
    expect(parseUnifiedDiff('   \n')).toEqual([])
  })
})

describe('indexDiffsByPath', () => {
  it('keys parsed diffs by path', () => {
    const map = indexDiffsByPath(DIFF)
    expect(map.get('src/app.ts')?.lines.length).toBe(5)
    expect(map.get('new.ts')?.binary).toBe(false)
    expect(map.has('logo.png')).toBe(true)
  })
})

/**
 * Diffs from an ACP edit tool call's before/after fragments. Unchanged lines
 * must render as context, not as a delete plus an add.
 */
describe('diffTextPair', () => {
  const kinds = (oldText: string | undefined, newText: string): string =>
    diffTextPair(oldText, newText).map((l) => l.kind[0]).join('')

  it('keeps common lines as context around a change', () => {
    const lines = diffTextPair('one\ntwo\nthree\n', 'one\nTWO\nthree\n')
    expect(lines.map((l) => [l.kind, l.text])).toEqual([
      ['context', 'one'],
      ['del', 'two'],
      ['add', 'TWO'],
      ['context', 'three'],
    ])
  })

  it('reports a whole file as added when there is no before text', () => {
    // What a `Write` of a new file sends: oldText absent, not empty.
    const lines = diffTextPair(undefined, 'a\nb\n')
    expect(lines.map((l) => [l.kind, l.text, l.newNo])).toEqual([
      ['add', 'a', 1],
      ['add', 'b', 2],
    ])
  })

  it('numbers lines within the fragment, per side', () => {
    const lines = diffTextPair('a\nb\nc', 'a\nc')
    expect(lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ['context', 1, 1],
      ['del', 2, null],
      ['context', 3, 2],
    ])
  })

  it('handles insertions and deletions at either end', () => {
    expect(kinds('b\nc', 'a\nb\nc')).toBe('acc')
    expect(kinds('a\nb\nc', 'a\nb')).toBe('ccd')
    expect(kinds('a\nb', 'a\nb\nc')).toBe('cca')
  })

  it('is empty for an unchanged pair only in the sense of having no +/−', () => {
    expect(kinds('same\nlines', 'same\nlines')).toBe('cc')
    expect(diffStats(diffTextPair('same', 'same'))).toEqual({ additions: 0, deletions: 0 })
  })

  it('ignores the trailing newline that ends a fragment', () => {
    // "a\n" is one line, not a line and an empty one.
    expect(diffTextPair(undefined, 'a\n').map((l) => l.text)).toEqual(['a'])
    expect(kinds('a\n', 'a')).toBe('c')
  })

  it('treats an empty side as no lines, not one blank one', () => {
    // `oldText: ''` is an empty file being filled, not a deleted blank line.
    expect(diffTextPair('', 'a\n')).toEqual([{ kind: 'add', text: 'a', oldNo: null, newNo: 1 }])
    expect(diffStats(diffTextPair('', 'a\nb\n'))).toEqual({ additions: 2, deletions: 0 })
    expect(diffTextPair('', '')).toEqual([])
  })

  it('matches repeated lines by content, not by position', () => {
    // Interning keeps identical lines equal, even far apart.
    expect(kinds('x\nsame\ny\nsame', 'x\nsame\nY\nsame')).toBe('ccdac')
  })

  it('falls back to a whole-side rewrite when the pair is too large to match', () => {
    // Above the size cap, all old lines then all new lines.
    const big = (n: number, tag: string): string =>
      Array.from({ length: n }, (_, i) => `${tag}${i}`).join('\n')
    const lines = diffTextPair(big(1200, 'a'), big(1200, 'b'))
    expect(lines).toHaveLength(2400)
    expect(lines[0]).toMatchObject({ kind: 'del', text: 'a0', oldNo: 1 })
    expect(lines[1200]).toMatchObject({ kind: 'add', text: 'b0', newNo: 1 })
  })
})

describe('diffStats', () => {
  it('counts added and removed lines, ignoring context', () => {
    expect(diffStats(diffTextPair('a\nb\nc', 'a\nB\nc\nd'))).toEqual({ additions: 2, deletions: 1 })
  })
})
