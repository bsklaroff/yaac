import { describe, it, expect } from 'vitest'
import { diffTextPair, parseDiffPart, splitDiff } from '#lib/diff'

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

describe('splitDiff', () => {
  it('splits into one part per file, by path, marking a cut one', () => {
    const cut = DIFF.replace('\ndiff --git a/new.ts', '\n@@CUT@@\ndiff --git a/new.ts')
    const parts = splitDiff(cut)
    expect([...parts.keys()]).toEqual(['src/app.ts', 'new.ts', 'logo.png'])
    expect(parts.get('src/app.ts')).toEqual({ text: `${DIFF.split('\ndiff --git a/new.ts')[0]}\n`, cut: true })
    expect(parts.get('new.ts')?.cut).toBe(false)
  })

  it('keeps a typechange\'s two parts together', () => {
    const parts = splitDiff([
      'diff --git a/link b/link', 'deleted file mode 120000', '--- a/link', '+++ /dev/null', '@@ -1 +0,0 @@', '-target',
      'diff --git a/link b/link', 'new file mode 100644', '--- /dev/null', '+++ b/link', '@@ -0,0 +1 @@', '+text', '',
    ].join('\n'))
    expect([...parts.keys()]).toEqual(['link'])
    expect(parseDiffPart('link', parts.get('link')!).lines.map((l) => l.kind)).toEqual(['hunk', 'del', 'hunk', 'add'])
  })

  it('returns nothing for an empty diff', () => {
    expect(splitDiff('').size).toBe(0)
    expect(splitDiff('   \n').size).toBe(0)
  })
})

describe('parseDiffPart', () => {
  const parse = (path: string): ReturnType<typeof parseDiffPart> => parseDiffPart(path, splitDiff(DIFF).get(path)!)

  it('tracks line kinds and numbers for a modification', () => {
    expect(parse('src/app.ts').lines).toEqual([
      { kind: 'hunk', text: '@@ -1,2 +1,3 @@', oldNo: null, newNo: null },
      { kind: 'context', text: 'line1', oldNo: 1, newNo: 1 },
      { kind: 'del', text: 'line2', oldNo: 2, newNo: null },
      { kind: 'add', text: 'line2 changed', oldNo: null, newNo: 2 },
      { kind: 'add', text: 'line3', oldNo: null, newNo: 3 },
    ])
  })

  it('reads a new file\'s added lines, past its ---/+++ header', () => {
    expect(parse('new.ts').lines.filter((l) => l.kind === 'add')).toHaveLength(2)
    expect(parse('new.ts').lines).toHaveLength(3)
  })

  it('flags binary files', () => {
    expect(parse('logo.png')).toEqual({ path: 'logo.png', binary: true, lines: [], cut: false })
  })
})

/**
 * Diffs from an ACP edit tool call's before/after fragments. Unchanged lines
 * must render as context, not as a delete plus an add.
 */
describe('diffTextPair', () => {
  const kinds = (oldText: string | undefined, newText: string): string =>
    diffTextPair(oldText, newText).map((l) => l.kind[0]).join('')

  // A large edit with changes scattered through it still reads change by
  // change rather than as one removed block and one added block.
  it('interleaves hundreds of scattered changes in a thousand-line fragment', () => {
    const before = Array.from({ length: 1000 }, (_, i) => `line ${String(i)}`)
    const after = before.map((l, i) => (i % 2 === 0 ? `${l} changed` : l))
    expect(kinds(`${before.join('\n')}\n`, `${after.join('\n')}\n`)).toBe('dac'.repeat(500))
  })

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
  })

  it('ignores the trailing newline that ends a fragment', () => {
    // "a\n" is one line, not a line and an empty one.
    expect(diffTextPair(undefined, 'a\n').map((l) => l.text)).toEqual(['a'])
    expect(kinds('a\n', 'a')).toBe('c')
  })

  it('treats an empty side as no lines, not one blank one', () => {
    // `oldText: ''` is an empty file being filled, not a deleted blank line.
    expect(diffTextPair('', 'a\n')).toEqual([{ kind: 'add', text: 'a', oldNo: null, newNo: 1 }])
    expect(kinds('', 'a\nb\n')).toBe('aa')
    expect(diffTextPair('', '')).toEqual([])
  })

  it('matches repeated lines by content, not by position', () => {
    expect(kinds('x\nsame\ny\nsame', 'x\nsame\nY\nsame')).toBe('ccdac')
    expect(kinds('a\nb\nc', 'a\nB\nc\nd')).toBe('cdaca')
  })

  it('keeps every line of a rewrite too large to match closely', () => {
    const big = (tag: string): string => Array.from({ length: 1200 }, (_, i) => `${tag}${String(i)}`).join('\n')
    const lines = diffTextPair(big('a'), big('b'))
    expect(lines.filter((l) => l.kind === 'del').map((l) => l.text)).toEqual(big('a').split('\n'))
    expect(lines.filter((l) => l.kind === 'add').map((l) => l.text)).toEqual(big('b').split('\n'))
  })
})
