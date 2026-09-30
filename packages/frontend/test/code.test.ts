import { describe, it, expect } from 'vitest'
import { codeLines, unfence } from '#lib/code'

/**
 * Stripping a tool's line-number gutter and markdown fence from file text.
 * Most cases check that text which only looks like a gutter or fence is left
 * untouched, since stripping it would delete real file content.
 */

describe('codeLines', () => {
  it('splits a file into its lines, without a trailing blank one', () => {
    expect(codeLines('one\ntwo\n')).toEqual([{ text: 'one' }, { text: 'two' }])
    // A file ending in a blank line keeps it.
    expect(codeLines('one\n\n')).toEqual([{ text: 'one' }, { text: '' }])
    expect(codeLines('')).toEqual([{ text: '' }])
  })

  it('lifts a numbered gutter off, keeping the numbers', () => {
    expect(codeLines('   7→const x = 1\n   8→\n   9→export {}\n')).toEqual([
      { text: 'const x = 1', no: 7 },
      { text: '', no: 8 },
      { text: 'export {}', no: 9 },
    ])
    // A tab gutter counts only with leading padding.
    expect(codeLines('     1\ta\n     2\tb\n     3\tc\n')).toEqual([
      { text: 'a', no: 1 },
      { text: 'b', no: 2 },
      { text: 'c', no: 3 },
    ])
  })

  it('leaves a tab-separated file whose first column counts alone', () => {
    // A TSV keyed by a sequential id differs from a tab gutter only by the
    // padding, so it must keep its first column.
    const tsv = '1\tapple\n2\tbanana\n3\tcherry\n'
    expect(codeLines(tsv)).toEqual([
      { text: '1\tapple' }, { text: '2\tbanana' }, { text: '3\tcherry' },
    ])
  })

  it('leaves a file that merely contains numbers alone', () => {
    // Numbers with gaps are the file's own data, not a gutter.
    const log = '  10\tstart\n  20\tstep\n  30\tdone\n'
    expect(codeLines(log)).toEqual([{ text: '  10\tstart' }, { text: '  20\tstep' }, { text: '  30\tdone' }])
    // Nor do numbers that don't run upward at all.
    const table = '  1\tapple\n  1\tpear\n  2\tplum\n'
    expect(codeLines(table)).toEqual([{ text: '  1\tapple' }, { text: '  1\tpear' }, { text: '  2\tplum' }])
    // Nor are too few numbered lines.
    expect(codeLines('  1\ta\n  2\tb\n')).toEqual([{ text: '  1\ta' }, { text: '  2\tb' }])
  })

  it('still lifts a padded, densely numbered data file — the accepted residue', () => {
    // A known misread: a right-aligned TSV keyed 1, 2, 3… is taken for a
    // gutter. Asserted so that loosening either rule fails here.
    expect(codeLines('     1\tapple\n     2\tbanana\n     3\tcherry\n')).toEqual([
      { text: 'apple', no: 1 },
      { text: 'banana', no: 2 },
      { text: 'cherry', no: 3 },
    ])
  })

  it('keeps a gutter that a stray line interrupts', () => {
    // A note appended after the numbered lines doesn't stop the stripping.
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
    // A document that is just one code block looks like an adapter's wrapper,
    // so it is unwrapped. The pane skips unwrapping for `.md` paths; this
    // asserts the known cost for the rest.
    expect(unfence('```python\nimport os\n```\n')).toEqual({ text: 'import os', fence: 'python' })
  })

  it('leaves everything else exactly as it was', () => {
    // Text around the fence means it is part of a document, not a wrapper.
    const mixed = 'here:\n```\nx\n```\n'
    expect(unfence(mixed)).toEqual({ text: mixed, fence: '' })
    // Two blocks: unwrapping the outermost backticks would splice them.
    const two = '```\na\n```\n```\nb\n```\n'
    expect(unfence(two).text).toBe(two)
    expect(unfence('no fence here')).toEqual({ text: 'no fence here', fence: '' })
  })
})
