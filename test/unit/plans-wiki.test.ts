import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import simpleGit from 'simple-git'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import { repoDir, plansMirrorDir, sessionPlansDir } from '@/lib/project/paths'
import {
  deriveWikiUrl,
  isValidDocPath,
  docFileNameForTopic,
  withMirrorLock,
  getWikiStatus,
  clearWikiStatusCache,
  ensurePlansMirror,
  clonePlansForSession,
  commitAndPushMirror,
} from '@/lib/plans/wiki'

describe('deriveWikiUrl', () => {
  it('derives .wiki.git from HTTPS and scp-style remotes', () => {
    expect(deriveWikiUrl('https://github.com/o/r.git')).toBe('https://github.com/o/r.wiki.git')
    expect(deriveWikiUrl('https://github.com/o/r')).toBe('https://github.com/o/r.wiki.git')
    expect(deriveWikiUrl('git@github.com:o/r.git')).toBe('git@github.com:o/r.wiki.git')
  })

  it('rejects wiki URLs, empty input, and bare hosts', () => {
    expect(deriveWikiUrl('https://github.com/o/r.wiki.git')).toBeNull()
    expect(deriveWikiUrl('   ')).toBeNull()
    expect(deriveWikiUrl('https://github.com/')).toBeNull()
  })
})

describe('isValidDocPath', () => {
  it('accepts flat wiki page filenames, including odd-but-real ones', () => {
    expect(isValidDocPath('offline-sync.md')).toBe(true)
    expect(isValidDocPath('My Plan (v2).md')).toBe(true)
    expect(isValidDocPath('hi!-c:.md')).toBe(true)
    expect(isValidDocPath('a..b.md')).toBe(true)
  })

  it('rejects traversal/separators, dot- and underscore-prefixes, and non-md', () => {
    expect(isValidDocPath('../escape.md')).toBe(false)
    expect(isValidDocPath('a/b.md')).toBe(false)
    expect(isValidDocPath('a\\b.md')).toBe(false)
    expect(isValidDocPath('.hidden.md')).toBe(false)
    expect(isValidDocPath('_Sidebar.md')).toBe(false)
    expect(isValidDocPath('x.txt')).toBe(false)
    expect(isValidDocPath('.md')).toBe(false)
  })
})

describe('docFileNameForTopic', () => {
  it('slugifies topics into wiki page filenames', () => {
    expect(docFileNameForTopic('Offline Sync!')).toBe('offline-sync.md')
    expect(docFileNameForTopic('  ')).toBe('plan.md')
    expect(docFileNameForTopic('x'.repeat(100))).toBe(`${'x'.repeat(60)}.md`)
  })
})

describe('withMirrorLock', () => {
  it('serializes operations per slug and survives rejections', async () => {
    const order: string[] = []
    const slow = withMirrorLock('p', async () => {
      await new Promise((r) => setTimeout(r, 20))
      order.push('first')
    })
    const failing = withMirrorLock('p', (): Promise<void> => {
      order.push('second')
      return Promise.reject(new Error('boom'))
    })
    const after = withMirrorLock('p', () => {
      order.push('third')
      return Promise.resolve()
    })
    await slow
    await expect(failing).rejects.toThrow('boom')
    await after
    expect(order).toEqual(['first', 'second', 'third'])
  })
})

describe('wiki git plumbing (local fixtures)', () => {
  let tmpDir: string
  const slug = 'proj'

  /** Create <remotes>/fake.git (origin, unused) and a real local
   *  "wiki" repo at <remotes>/fake.wiki.git with one page, plus the
   *  project's repo dir whose origin points at fake.git. */
  async function setupFixtures(): Promise<{ wikiBare: string }> {
    const remotes = path.join(tmpDir, 'remotes')
    const wikiBare = path.join(remotes, 'fake.wiki.git')
    await fs.mkdir(wikiBare, { recursive: true })
    await simpleGit().raw(['init', '--bare', '--initial-branch=master', wikiBare])

    const seed = path.join(tmpDir, 'wiki-seed')
    await simpleGit().clone(wikiBare, seed)
    await fs.writeFile(path.join(seed, 'Home.md'), '---\nphase: plan\n---\n# Home\n')
    const seedGit = simpleGit(seed)
    await seedGit.add('.')
    await seedGit.raw(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init'])
    await seedGit.push('origin', 'master')

    const repo = repoDir(slug)
    await fs.mkdir(repo, { recursive: true })
    await simpleGit().raw(['init', repo])
    await simpleGit(repo).remote(['add', 'origin', path.join(remotes, 'fake.git')])
    return { wikiBare }
  }

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    clearWikiStatusCache()
  })

  afterEach(async () => {
    clearWikiStatusCache()
    await cleanupTempDir(tmpDir)
  })

  it('getWikiStatus: available when the wiki repo exists, unavailable when not', async () => {
    await setupFixtures()
    const status = await getWikiStatus(slug)
    expect(status.available).toBe(true)
    expect(status.wikiUrl).toContain('fake.wiki.git')

    // Remove the wiki repo → unavailable, with the create-a-page hint.
    clearWikiStatusCache()
    await fs.rm(path.join(tmpDir, 'remotes', 'fake.wiki.git'), { recursive: true })
    const gone = await getWikiStatus(slug)
    expect(gone.available).toBe(false)
    expect(gone.reason).toContain('Create the first wiki page')
  })

  it('ensurePlansMirror clones, then resets to the remote on later calls', async () => {
    const { wikiBare } = await setupFixtures()
    const mirror = await ensurePlansMirror(slug)
    expect(mirror).toBe(plansMirrorDir(slug))
    expect(await fs.readFile(path.join(mirror, 'Home.md'), 'utf8')).toContain('# Home')

    // Push a new page from elsewhere; a fresh ensure (maxAge 0) picks it up
    // and discards local drift.
    const other = path.join(tmpDir, 'other')
    await simpleGit().clone(wikiBare, other)
    await fs.writeFile(path.join(other, 'New.md'), '# New\n')
    await simpleGit(other).add('.')
    await simpleGit(other).raw(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'add'])
    await simpleGit(other).push('origin', 'master')
    await fs.writeFile(path.join(mirror, 'Home.md'), 'local drift')

    await ensurePlansMirror(slug)
    expect(await fs.readFile(path.join(mirror, 'Home.md'), 'utf8')).toContain('# Home')
    expect(await fs.readFile(path.join(mirror, 'New.md'), 'utf8')).toContain('# New')

    // A large maxAge skips the fetch entirely (no error even if offline).
    await fs.rm(wikiBare, { recursive: true })
    await expect(ensurePlansMirror(slug, 60_000)).resolves.toBe(mirror)
  })

  it('clonePlansForSession clones from the mirror and points origin at the wiki', async () => {
    await setupFixtures()
    const dest = await clonePlansForSession(slug, 'sid-1')
    expect(dest).toBe(sessionPlansDir(slug, 'sid-1'))
    expect(await fs.readFile(path.join(dest, 'Home.md'), 'utf8')).toContain('# Home')
    const origin = (await simpleGit(dest).remote(['get-url', 'origin']))?.trim()
    expect(origin).toContain('fake.wiki.git')
    // Idempotent: a second call reuses the existing clone.
    await expect(clonePlansForSession(slug, 'sid-1')).resolves.toBe(dest)
  })

  it('commitAndPushMirror lands a mirror edit on the wiki remote', async () => {
    const { wikiBare } = await setupFixtures()
    const mirror = await ensurePlansMirror(slug)
    await fs.writeFile(path.join(mirror, 'Home.md'), '---\nphase: build\n---\n# Home\n')
    await commitAndPushMirror(slug, 'Home.md', 'Promote Home.md to build', { name: 't', email: 't@t' })

    const check = path.join(tmpDir, 'check')
    await simpleGit().clone(wikiBare, check)
    expect(await fs.readFile(path.join(check, 'Home.md'), 'utf8')).toContain('phase: build')
    const log = await simpleGit(check).log()
    expect(log.latest?.message).toBe('Promote Home.md to build')
  })
})
