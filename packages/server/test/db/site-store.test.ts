import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#db/client'
import {
  beginSiteDeploy,
  deleteProjectSiteRows,
  deleteSiteRow,
  findSiteByName,
  getSiteRow,
  insertSite,
  listProjectSites,
  listSiteReleases,
  siteBuiltFrom,
  listSites,
  listVolumeSites,
  siteNames,
  updateSite,
} from '#db/site-store'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { findNamedWorkflow, insertNamedWorkflow, storeWorkflow } from '#db/workflow-store'

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'
const OTHER = '795f3202-b17c-46bc-8d4b-771d8c6c9eaf'
const VOLUME = '0b3a8d3c-1c1e-4d65-9a43-6f0f1e7b2c11'
const APP = { app: { run: ['pnpm start'], service: true as const } }

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

const site = async (projectId: string, name: string, hostname: string, volumeId?: string) => {
  const workflow = await storeWorkflow(projectId, { steps: APP, secrets: [] })
  await insertNamedWorkflow(projectId, `${name}-${hostname}`, workflow.id)
  const named = await findNamedWorkflow(projectId, `${name}-${hostname}`)
  return await insertSite({
    projectId, repos: [{ repo: projectId, branch: 'main' }], follow: false, name, hostname, port: 3000, namedWorkflowId: named!.id,
    ...(volumeId !== undefined ? { volumeId } : {}),
  })
}

describe('insertSite', () => {
  it('refuses a name the project uses, and a hostname any site uses', async () => {
    const row = await site(PROJ, 'shop', 'shop.example.com')
    expect(row).toMatchObject({ name: 'shop', port: 3000, deployReplacing: false, replaceFailures: 0 })
    await expect(site(PROJ, 'shop', 'b.example.com')).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('named "shop"') as unknown })
    await expect(site(OTHER, 'other', 'shop.example.com')).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('shop.example.com') as unknown })
    await site(OTHER, 'shop', 'other.example.com')
  })
})

describe('listProjectSites', () => {
  it('lists one project\'s sites by name', async () => {
    await site(PROJ, 'b', 'b.example.com')
    await site(PROJ, 'a', 'a.example.com')
    await site(OTHER, 'c', 'c.example.com')
    expect((await listProjectSites(PROJ)).map((s) => s.name)).toEqual(['a', 'b'])
  })
})

describe('listSites', () => {
  it('lists every project\'s sites', async () => {
    await site(PROJ, 'a', 'a.example.com')
    await site(OTHER, 'c', 'c.example.com')
    expect((await listSites()).map((s) => s.name).sort()).toEqual(['a', 'c'])
  })
})

describe('findSiteByName', () => {
  it('finds a site in its project only', async () => {
    await site(PROJ, 'a', 'a.example.com')
    expect((await findSiteByName(PROJ, 'a'))?.hostname).toBe('a.example.com')
    expect(await findSiteByName(OTHER, 'a')).toBeUndefined()
  })
})

describe('getSiteRow', () => {
  it('reads a site by id, and nothing for a non-uuid', async () => {
    const row = await site(PROJ, 'a', 'a.example.com')
    expect((await getSiteRow(row.id))?.name).toBe('a')
    expect(await getSiteRow('nope')).toBeUndefined()
  })
})

describe('updateSite', () => {
  it('changes and clears columns, refusing a hostname another site serves', async () => {
    const a = await site(PROJ, 'a', 'a.example.com')
    await site(PROJ, 'b', 'b.example.com')
    await updateSite(a.id, { liveWorkspaceId: 'rel-1', port: 4000 })
    expect(await getSiteRow(a.id)).toMatchObject({ liveWorkspaceId: 'rel-1', port: 4000 })
    await updateSite(a.id, { liveWorkspaceId: null })
    expect((await getSiteRow(a.id))?.liveWorkspaceId).toBeUndefined()
    await expect(updateSite(a.id, { hostname: 'b.example.com' })).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('beginSiteDeploy', () => {
  it('starts a deploy only while none runs', async () => {
    const a = await site(PROJ, 'a', 'a.example.com')
    expect(await beginSiteDeploy(a.id, { deployWorkspaceId: 'rel-1' })).toBe(true)
    expect(await beginSiteDeploy(a.id, { deployWorkspaceId: 'rel-2' })).toBe(false)
    expect((await getSiteRow(a.id))?.deployWorkspaceId).toBe('rel-1')
  })
})

describe('deleteSiteRow', () => {
  it('deletes one site', async () => {
    const a = await site(PROJ, 'a', 'a.example.com')
    await site(PROJ, 'b', 'b.example.com')
    await deleteSiteRow(a.id)
    expect((await listSites()).map((s) => s.name)).toEqual(['b'])
  })
})

describe('deleteProjectSiteRows', () => {
  it('deletes a project\'s sites only', async () => {
    await site(PROJ, 'a', 'a.example.com')
    await site(OTHER, 'c', 'c.example.com')
    await deleteProjectSiteRows(PROJ)
    expect((await listSites()).map((s) => s.name)).toEqual(['c'])
  })
})

describe('siteNames', () => {
  it('names each site by id', async () => {
    const a = await site(PROJ, 'a', 'a.example.com')
    expect(await siteNames([a.id, '00000000-0000-4000-8000-000000000000'])).toEqual(new Map([[a.id, 'a']]))
    expect(await siteNames([])).toEqual(new Map())
  })
})

describe('listVolumeSites', () => {
  it('lists the sites that name a volume', async () => {
    await site(PROJ, 'a', 'a.example.com', VOLUME)
    await site(PROJ, 'b', 'b.example.com')
    expect((await listVolumeSites(VOLUME)).map((s) => s.name)).toEqual(['a'])
  })
})

describe('listSiteReleases', () => {
  it('lists a site\'s releases newest first, up to the limit, each with its checkouts', async () => {
    const a = await site(PROJ, 'a', 'a.example.com')
    for (const id of ['r1', 'r2', 'r3']) {
      await recordWorkspaceCreated({
        projectId: PROJ, workspaceId: id, siteId: a.id,
        repos: id === 'r3' ? [{ repoId: PROJ, path: 'web' }, { repoId: OTHER, path: 'api' }] : [{ repoId: PROJ, path: '' }],
      })
      await new Promise((r) => setTimeout(r, 5))
    }
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'dev' })
    const releases = await listSiteReleases(a.id, 2)
    expect(releases.map((r) => r.workspaceId)).toEqual(['r3', 'r2'])
    expect(releases[0].checkouts.map((c) => [c.repoId, c.path])).toEqual([[OTHER, 'api'], [PROJ, 'web']])
    expect(releases[1].checkouts.map((c) => [c.repoId, c.path])).toEqual([[PROJ, '']])
  })
})

describe('siteBuiltFrom', () => {
  it('is true of a repo in its repos or among the commits its last release ran', async () => {
    const a = await site(PROJ, 'a', 'a.example.com')
    expect(siteBuiltFrom(a, PROJ)).toBe(true)
    expect(siteBuiltFrom(a, OTHER)).toBe(false)
    expect(siteBuiltFrom({ ...a, releaseCommits: { [OTHER]: 'c'.repeat(40) } }, OTHER)).toBe(true)
  })
})
