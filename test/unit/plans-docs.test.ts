import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { hashDocContent, listDocsInDir, mergePlanDocs, type ListedDoc } from '@/lib/plans/docs'
import type { ParsedPlanDoc } from '@/shared/plan-docs'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-plans-docs-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('listDocsInDir', () => {
  it('lists markdown pages with parsed frontmatter, mtimes, and content hashes', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.md'), '---\nphase: build\n---\n# A')
    await fs.writeFile(path.join(tmpDir, 'b.md'), 'plain')
    const docs = await listDocsInDir(tmpDir)
    const byName = new Map(docs.map((d) => [d.fileName, d]))
    expect([...byName.keys()].sort()).toEqual(['a.md', 'b.md'])
    expect(byName.get('a.md')?.parsed.phase).toBe('build')
    expect(byName.get('b.md')?.parsed.phase).toBe('plan')
    expect(byName.get('a.md')?.updatedAt).toBeGreaterThan(0)
    expect(byName.get('b.md')?.contentHash).toBe(hashDocContent('plain'))
  })

  it('skips wiki special pages, dotfiles, non-md, and directories', async () => {
    await fs.writeFile(path.join(tmpDir, '_Sidebar.md'), 'nav')
    await fs.writeFile(path.join(tmpDir, '.hidden.md'), 'x')
    await fs.writeFile(path.join(tmpDir, 'notes.txt'), 'x')
    await fs.mkdir(path.join(tmpDir, 'sub.md'))
    expect(await listDocsInDir(tmpDir)).toEqual([])
  })

  it('returns [] for a missing directory', async () => {
    expect(await listDocsInDir(path.join(tmpDir, 'nope'))).toEqual([])
  })
})

describe('mergePlanDocs', () => {
  const parsed = (over: Partial<ParsedPlanDoc> = {}): ParsedPlanDoc => ({
    phase: 'plan', sessions: [], title: 't', body: '', ...over,
  })
  const doc = (
    fileName: string, updatedAt: number, hash: string, over: Partial<ParsedPlanDoc> = {},
  ): ListedDoc => ({ fileName, parsed: parsed(over), updatedAt, contentHash: hash })

  it('a differing live session copy shadows the mirror copy as a draft', () => {
    const out = mergePlanDocs(
      [doc('x.md', 100, 'h-old', { title: 'old' })],
      [{ sessionId: 's1', docs: [doc('x.md', 200, 'h-new', { title: 'new' })] }],
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ path: 'x.md', title: 'new', draftSessionId: 's1' })
  })

  it('an identical session copy is NOT a draft (every clone has every page)', () => {
    const out = mergePlanDocs(
      [doc('x.md', 100, 'same', { title: 'pushed' })],
      [{ sessionId: 's1', docs: [doc('x.md', 999, 'same', { title: 'pushed' })] }],
    )
    expect(out[0].draftSessionId).toBeUndefined()
  })

  it('a strictly newer mirror copy wins over a stale differing session copy', () => {
    const out = mergePlanDocs(
      [doc('x.md', 300, 'h-pushed', { title: 'pushed' })],
      [{ sessionId: 's1', docs: [doc('x.md', 200, 'h-stale', { title: 'stale' })] }],
    )
    expect(out[0]).toMatchObject({ title: 'pushed' })
    expect(out[0].draftSessionId).toBeUndefined()
  })

  it('unions distinct docs, sorts newest-first, and strips the hash', () => {
    const out = mergePlanDocs(
      [doc('a.md', 100, 'ha')],
      [{ sessionId: 's1', docs: [doc('b.md', 200, 'hb')] }],
    )
    expect(out.map((d) => d.path)).toEqual(['b.md', 'a.md'])
    expect(Object.keys(out[0])).not.toContain('contentHash')
  })
})
