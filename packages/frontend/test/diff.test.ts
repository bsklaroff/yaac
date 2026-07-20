import { describe, it, expect } from 'vitest'
import { parseUnifiedDiff, indexDiffsByPath, changeMatchesQuery } from '#lib/diff'

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

describe('changeMatchesQuery', () => {
  const map = indexDiffsByPath(DIFF)
  const app = { path: 'src/app.ts' }

  it('matches every file on an empty query', () => {
    expect(changeMatchesQuery(app, map.get(app.path), '')).toBe(true)
    expect(changeMatchesQuery({ path: 'logo.png' }, map.get('logo.png'), '')).toBe(true)
  })

  it('matches on a path substring, case-insensitively', () => {
    expect(changeMatchesQuery(app, map.get(app.path), 'APP.TS')).toBe(true)
    expect(changeMatchesQuery(app, map.get(app.path), 'nope/')).toBe(false)
  })

  it('matches the old path of a rename', () => {
    const renamed = { path: 'src/new-name.ts', oldPath: 'src/old-name.ts' }
    expect(changeMatchesQuery(renamed, undefined, 'old-name')).toBe(true)
  })

  it('matches diff content (any line kind) but not hunk headers', () => {
    expect(changeMatchesQuery(app, map.get(app.path), 'line2 CHANGED')).toBe(true) // add
    expect(changeMatchesQuery(app, map.get(app.path), 'line1')).toBe(true) // context
    expect(changeMatchesQuery(app, map.get(app.path), '@@ -1,2')).toBe(false) // hunk header
  })

  it('is false for a content query with no diff to search', () => {
    expect(changeMatchesQuery({ path: 'logo.png' }, undefined, 'line1')).toBe(false)
  })
})
