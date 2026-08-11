import { describe, it, expect } from 'vitest'
import { codeLines, unfence } from '#lib/code'

/**
 * What a tool's report of a file has to be stripped of before it is the file.
 *
 * Both helpers exist to guess, and the guess that matters is the one they
 * refuse to make: a file whose own text looks like a gutter or a fence must
 * come through untouched, because the alternative is deleting characters the
 * file actually contains.
 */

describe('codeLines', () => {
  it('splits a file into its lines, without a trailing blank one', () => {
    expect(codeLines('one\ntwo\n')).toEqual([{ text: 'one' }, { text: 'two' }])
    // A file that really does end blank keeps that line: two newlines, two
    // lines and an empty one.
    expect(codeLines('one\n\n')).toEqual([{ text: 'one' }, { text: '' }])
    expect(codeLines('')).toEqual([{ text: '' }])
  })

  it('lifts a numbered gutter off, keeping the numbers', () => {
    expect(codeLines('   7→const x = 1\n   8→\n   9→export {}\n')).toEqual([
      { text: 'const x = 1', no: 7 },
      { text: '', no: 8 },
      { text: 'export {}', no: 9 },
    ])
    // Tabs are the other spelling of the same gutter, but only with the
    // alignment padding a right-aligning reader emits.
    expect(codeLines('     1\ta\n     2\tb\n     3\tc\n')).toEqual([
      { text: 'a', no: 1 },
      { text: 'b', no: 2 },
      { text: 'c', no: 3 },
    ])
  })

  it('leaves a tab-separated file whose first column counts alone', () => {
    // The collision this whole heuristic has to survive: a TSV keyed by a
    // sequential id is byte-identical to a tab-spelled gutter but for the
    // padding, and lifting it would delete the file's first column in front of
    // someone reading the file.
    const tsv = '1\tapple\n2\tbanana\n3\tcherry\n'
    expect(codeLines(tsv)).toEqual([
      { text: '1\tapple' }, { text: '2\tbanana' }, { text: '3\tcherry' },
    ])
  })

  it('leaves a file that merely contains numbers alone', () => {
    // Numbers with gaps are a column of the file's own data — ids, timestamps,
    // a changelog — rather than the lines a reader printed one after the next.
    const log = '  10\tstart\n  20\tstep\n  30\tdone\n'
    expect(codeLines(log)).toEqual([{ text: '  10\tstart' }, { text: '  20\tstep' }, { text: '  30\tdone' }])
    // Nor do numbers that don't run upward at all.
    const table = '  1\tapple\n  1\tpear\n  2\tplum\n'
    expect(codeLines(table)).toEqual([{ text: '  1\tapple' }, { text: '  1\tpear' }, { text: '  2\tplum' }])
    // And too few numbered lines to be a gutter at all.
    expect(codeLines('  1\ta\n  2\tb\n')).toEqual([{ text: '  1\ta' }, { text: '  2\tb' }])
  })

  it('still lifts a padded, densely numbered data file — the accepted residue', () => {
    // What is left of the collision once padding and consecutiveness are
    // required: a tab-separated file that is *both* right-aligned and keyed
    // 1,2,3… with no gaps reads as a gutter, and its first column is shown as
    // line numbers. This is asserted so that loosening either rule fails here
    // rather than silently widening the class of files it misreads.
    expect(codeLines('     1\tapple\n     2\tbanana\n     3\tcherry\n')).toEqual([
      { text: 'apple', no: 1 },
      { text: 'banana', no: 2 },
      { text: 'cherry', no: 3 },
    ])
  })

  it('keeps a gutter that a stray line interrupts', () => {
    // A note appended to a read is not a reason to render the file's text with
    // its line numbers welded to it.
    const lines = codeLines('  1→a\n  2→b\n  3→c\n  4→d\n(file truncated)\n')
    expect(lines).toEqual([
      { text: 'a', no: 1 },
      { text: 'b', no: 2 },
      { text: 'c', no: 3 },
      { text: 'd', no: 4 },
      { text: '(file truncated)' },
    ])
  })
})

describe('unfence', () => {
  it('unwraps a body that is one fenced block, and names its language', () => {
    expect(unfence('```ts\nconst x = 1\n```\n')).toEqual({ text: 'const x = 1', fence: 'ts' })
    expect(unfence('```\nplain\n```')).toEqual({ text: 'plain', fence: '' })
  })

  it('unwraps a file that genuinely is one fenced block — the accepted residue', () => {
    // A document whose whole body is one code sample is indistinguishable from
    // an adapter's wrapper, so its backticks are taken off and the reader sees
    // only the interior. The pane narrows this where it can (a `.md` path skips
    // the unwrap entirely); what is asserted here is the case it cannot tell
    // apart, so that it stays a known cost rather than a surprise.
    expect(unfence('```python\nimport os\n```\n')).toEqual({ text: 'import os', fence: 'python' })
  })

  it('leaves everything else exactly as it was', () => {
    // Prose around the fence means the fence is part of a document, not a
    // wrapper somebody put around the whole output.
    const mixed = 'here:\n```\nx\n```\n'
    expect(unfence(mixed)).toEqual({ text: mixed, fence: '' })
    // Two blocks: unwrapping the outermost backticks would splice them.
    const two = '```\na\n```\n```\nb\n```\n'
    expect(unfence(two).text).toBe(two)
    expect(unfence('no fence here')).toEqual({ text: 'no fence here', fence: '' })
  })
})
