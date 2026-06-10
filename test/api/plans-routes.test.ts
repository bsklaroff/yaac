import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import simpleGit from 'simple-git'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import { buildApp } from '@/daemon/server'
import { repoDir, plansMirrorDir } from '@/lib/project/paths'
import { clearWikiStatusCache } from '@/lib/plans/wiki'
import type { PlansResult } from '@/shared/types'

const AUTH = { headers: { authorization: 'Bearer shh' } }

describe('plans routes', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    clearWikiStatusCache()
  })

  afterEach(async () => {
    clearWikiStatusCache()
    await cleanupTempDir(tmpDir)
  })

  it('GET /project/:slug/plans requires auth', async () => {
    const app = buildApp({ secret: 'shh', buildId: 'b' })
    const res = await app.request('/project/p/plans')
    expect(res.status).toBe(401)
  })

  it('reports unavailable (with a reason) when the project has no wiki', async () => {
    // A project repo whose origin has no sibling .wiki.git repo.
    const repo = repoDir('proj')
    await fs.mkdir(repo, { recursive: true })
    await simpleGit().raw(['init', repo])
    await simpleGit(repo).remote(['add', 'origin', path.join(tmpDir, 'remotes', 'fake.git')])

    const app = buildApp({ secret: 'shh', buildId: 'b' })
    const res = await app.request('/project/proj/plans', AUTH)
    expect(res.status).toBe(200)
    const body = await res.json() as PlansResult
    expect(body.available).toBe(false)
    expect(body.reason).toContain('Create the first wiki page')
    expect(body.docs).toEqual([])
  })

  it('rejects traversal in the doc path', async () => {
    const app = buildApp({ secret: 'shh', buildId: 'b' })
    const res = await app.request(
      '/project/proj/plans/doc?path=..%2Fsecrets.md', AUTH,
    )
    expect(res.status).toBe(400)
  })

  it('POST /continue streams a validation error for a bad path', async () => {
    const app = buildApp({ secret: 'shh', buildId: 'b' })
    const res = await app.request('/project/proj/plans/continue', {
      ...AUTH,
      method: 'POST',
      headers: { ...AUTH.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'a/b.md' }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('"type":"error"')
    expect(text).toContain('invalid doc path')
  })

  it('lists wiki docs once a wiki repo exists (mirror-only, no sessions)', async () => {
    // Local "wiki": a bare repo next to the (nonexistent) origin repo.
    const wikiBare = path.join(tmpDir, 'remotes', 'fake.wiki.git')
    await fs.mkdir(wikiBare, { recursive: true })
    await simpleGit().raw(['init', '--bare', '--initial-branch=master', wikiBare])
    const seed = path.join(tmpDir, 'seed')
    await simpleGit().clone(wikiBare, seed)
    await fs.writeFile(path.join(seed, 'offline-sync.md'), '---\nphase: plan\n---\n# Offline sync\n')
    await simpleGit(seed).add('.')
    await simpleGit(seed).raw(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init'])
    await simpleGit(seed).push('origin', 'master')

    const repo = repoDir('proj')
    await fs.mkdir(repo, { recursive: true })
    await simpleGit().raw(['init', repo])
    await simpleGit(repo).remote(['add', 'origin', path.join(tmpDir, 'remotes', 'fake.git')])

    const app = buildApp({ secret: 'shh', buildId: 'b' })
    const res = await app.request('/project/proj/plans', AUTH)
    expect(res.status).toBe(200)
    const body = await res.json() as PlansResult
    expect(body.available).toBe(true)
    expect(body.docs.map((d) => d.path)).toEqual(['offline-sync.md'])
    expect(body.docs[0]).toMatchObject({ phase: 'plan', title: 'Offline sync' })

    const doc = await app.request(
      '/project/proj/plans/doc?path=offline-sync.md', AUTH,
    )
    expect(doc.status).toBe(200)
    expect(await doc.json()).toMatchObject({ draftSessionId: null })
    expect(await fs.readFile(path.join(plansMirrorDir('proj'), 'offline-sync.md'), 'utf8'))
      .toContain('# Offline sync')

    const missing = await app.request(
      '/project/proj/plans/doc?path=nope.md', AUTH,
    )
    expect(missing.status).toBe(404)

    // A new-plan topic that slugifies to an existing page is rejected —
    // a second grill session would clobber the doc (resume covers this).
    const dup = await app.request('/project/proj/plans/new', {
      ...AUTH,
      method: 'POST',
      headers: { ...AUTH.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'Offline Sync!' }),
    })
    expect(dup.status).toBe(200)
    const dupText = await dup.text()
    expect(dupText).toContain('"type":"error"')
    expect(dupText).toContain('already exists')
  })
})
