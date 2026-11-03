/**
 * Public sites' settings and what the API answers about them
 * (docs/public-sites.md). The driver is the fake, recording the routes it
 * is handed; deploys are deploys.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createSite,
  deleteSite,
  editSite,
  getSiteEdge,
  listProjectSiteEntries,
  showSite,
} from '#domain/sites'
import { createVolume } from '#domain/workspaces'
import { BUILT_IN_USER_ID, findSiteByName, setProjectShareRevoked, updateSite } from '#db'
import { closeDb } from '#db/client'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { cleanupTempDir, createTempDataDir } from '@yaac/test-utils/setup'
import { installFakeWorkspaceDriver, resetWorkspaceDriver } from '#test/support/fake-driver'
import { DEMO_PROJECT_ID, seedProject } from '@yaac/test-utils/project-fixture'
import type { SiteRoute } from '#drivers/contract'

const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const stranger = { kind: 'local', userId: 'someone-else' } as const
const APP = { app: { run: 'pnpm start', service: true } }

let tmpDir: string
let routed: SiteRoute[][]

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  vi.stubEnv('YAAC_SITE_DOMAINS', 'example.com,Shop.Test')
  await seedProject()
  routed = []
  installFakeWorkspaceDriver({
    syncSites: (sites) => { routed.push(sites); return Promise.resolve() },
    siteTunnelStatus: () => Promise.resolve('connected'),
  })
})

afterEach(async () => {
  vi.unstubAllEnvs()
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

const create = (over: Partial<Parameters<typeof createSite>[2]> = {}): Promise<void> =>
  createSite(local, DEMO_PROJECT_ID, { name: 'shop', hostname: 'shop.example.com', port: 3000, steps: APP, ...over })

describe('createSite', () => {
  it('routes a new site with no release, refusing bad settings, a taken name or hostname and a non-owner', async () => {
    await create()
    const row = await findSiteByName(DEMO_PROJECT_ID, 'shop')
    expect(routed.at(-1)).toEqual([{ siteId: row!.id, hostname: 'shop.example.com', port: 3000 }])
    // The apex of a domain is a hostname too, lowercased.
    await create({ name: 'apex', hostname: 'SHOP.test' })
    expect((await findSiteByName(DEMO_PROJECT_ID, 'apex'))?.hostname).toBe('shop.test')

    await expect(create({ name: 'Bad Name', hostname: 'a.example.com' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(create({ name: 'a', hostname: 'a.elsewhere.com' })).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('example.com') as unknown })
    await expect(create({ name: 'a', hostname: 'https://a.example.com' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(create({ name: 'a', hostname: 'a.example.com', port: 0 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(create({ name: 'a', hostname: 'a.example.com', steps: { build: { run: 'make' } } }))
      .rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('service') as unknown })
    // Only a site with a volume may wait on it.
    await expect(create({ name: 'a', hostname: 'a.example.com', steps: { app: { run: 'x', service: true, needs: ['volume'] } } }))
      .rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(create({ name: 'a', hostname: 'a.example.com', volume: 'missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(create({ hostname: 'other.example.com' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(create({ name: 'other' })).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('shop.example.com') as unknown })
    await expect(createSite(stranger, DEMO_PROJECT_ID, { name: 'x', hostname: 'x.example.com', port: 1, steps: APP }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })

    // One volume holds one site's data.
    await createVolume(local, DEMO_PROJECT_ID, 'data')
    await create({ name: 'v1', hostname: 'v1.example.com', volume: 'data' })
    await expect(create({ name: 'v2', hostname: 'v2.example.com', volume: 'data' })).rejects.toMatchObject({ code: 'CONFLICT' })

    // A site under a domain the install no longer serves stops routing.
    vi.stubEnv('YAAC_SITE_DOMAINS', 'example.com')
    await create({ name: 'blog', hostname: 'blog.example.com' })
    expect(routed.at(-1)?.map((r) => r.hostname).sort()).toEqual(['blog.example.com', 'shop.example.com', 'v1.example.com'])

    vi.stubEnv('YAAC_SITE_DOMAINS', '')
    await expect(create({ name: 'b', hostname: 'b.example.com' })).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('--site-domain') as unknown })
  })
})

describe('editSite', () => {
  it('moves the hostname at once and keeps the rest for the next deploy, refusing during a deploy', async () => {
    await createVolume(local, DEMO_PROJECT_ID, 'data')
    await create({ volume: 'data', steps: { app: { run: 'x', service: true, needs: ['volume'] } } })
    const row = (await findSiteByName(DEMO_PROJECT_ID, 'shop'))!
    await updateSite(row.id, { liveWorkspaceId: 'rel-1', livePort: 3000 })

    await editSite(local, DEMO_PROJECT_ID, 'shop', { hostname: 'www.example.com', port: 4000 })
    expect(routed.at(-1)).toEqual([{ siteId: row.id, hostname: 'www.example.com', port: 3000, liveWorkspaceId: 'rel-1' }])
    expect((await findSiteByName(DEMO_PROJECT_ID, 'shop'))?.port).toBe(4000)

    // Its graph needs the volume, so the volume cannot go without a graph
    // that does not.
    await expect(editSite(local, DEMO_PROJECT_ID, 'shop', { volume: null })).rejects.toMatchObject({ code: 'VALIDATION' })
    await editSite(local, DEMO_PROJECT_ID, 'shop', { volume: null, steps: APP })
    expect((await findSiteByName(DEMO_PROJECT_ID, 'shop'))?.volumeId).toBeUndefined()

    await updateSite(row.id, { deployWorkspaceId: 'rel-2' })
    await expect(editSite(local, DEMO_PROJECT_ID, 'shop', { port: 5000 })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(editSite(stranger, DEMO_PROJECT_ID, 'shop', { port: 5000 })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(editSite(local, DEMO_PROJECT_ID, 'none', { port: 5000 })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('deleteSite', () => {
  it('drops the site and its route', async () => {
    await create()
    await create({ name: 'blog', hostname: 'blog.example.com' })
    await expect(deleteSite(stranger, DEMO_PROJECT_ID, 'shop')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await deleteSite(local, DEMO_PROJECT_ID, 'shop')
    expect(await findSiteByName(DEMO_PROJECT_ID, 'shop')).toBeUndefined()
    expect(routed.at(-1)?.map((r) => r.hostname)).toEqual(['blog.example.com'])

    // A share its source removed runs nothing and routes nothing, but its
    // owner may still delete its site to free the hostname.
    await setProjectShareRevoked(DEMO_PROJECT_ID, true)
    await expect(deleteSite(stranger, DEMO_PROJECT_ID, 'blog')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await deleteSite(local, DEMO_PROJECT_ID, 'blog')
    expect(await findSiteByName(DEMO_PROJECT_ID, 'blog')).toBeUndefined()
    expect(routed.at(-1)).toEqual([])
  })
})

describe('listProjectSiteEntries', () => {
  it('answers each site with its live release and the deploy under way', async () => {
    await createVolume(local, DEMO_PROJECT_ID, 'data')
    await create({ volume: 'data' })
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'rel-1' })
    const row = (await findSiteByName(DEMO_PROJECT_ID, 'shop'))!
    const since = new Date('2026-11-03T10:00:00Z')
    await updateSite(row.id, {
      liveWorkspaceId: 'rel-1', liveSince: since, releaseCommit: 'a'.repeat(40),
      deployWorkspaceId: 'rel-2', deployCommit: 'b'.repeat(40), deployStartedAt: since, deployPhase: 'building', deployReplacing: true,
    })
    expect(await listProjectSiteEntries(DEMO_PROJECT_ID)).toEqual([expect.objectContaining({
      name: 'shop',
      hostname: 'shop.example.com',
      volume: 'data',
      live: { workspaceId: 'rel-1', commit: 'a'.repeat(40), since: since.toISOString(), running: true },
      deploy: { workspaceId: 'rel-2', commit: 'b'.repeat(40), startedAt: since.toISOString(), phase: 'building', replacing: true },
    })])
  })
})

describe('showSite', () => {
  it('lists the site\'s releases, newest first', async () => {
    await create()
    const row = (await findSiteByName(DEMO_PROJECT_ID, 'shop'))!
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'rel-1', siteId: row.id })
    await new Promise((r) => setTimeout(r, 5))
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'rel-2', siteId: row.id, rerunOf: 'rel-1' })
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'dev' })
    const detail = await showSite(DEMO_PROJECT_ID, 'shop')
    expect(detail.releases.map((r) => [r.workspaceId, r.rerunOf])).toEqual([['rel-2', 'rel-1'], ['rel-1', undefined]])
    await expect(showSite(DEMO_PROJECT_ID, 'none')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('getSiteEdge', () => {
  it('answers the install\'s domains and its tunnel\'s state', async () => {
    expect(await getSiteEdge()).toEqual({ domains: ['example.com', 'shop.test'], tunnel: 'connected' })
  })
})
