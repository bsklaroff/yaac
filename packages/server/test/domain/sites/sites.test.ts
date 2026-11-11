/**
 * Public sites' settings and what the API answers about them
 * (docs/public-sites.md). The driver is the fake, recording the routes it
 * is handed; deploys are deploys.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createSite,
  deleteSite,
  editSite,
  getSiteEdge,
  listProjectSiteEntries,
  showSite,
} from '#domain/sites'
import { createVolume, offeredForwards } from '#domain/workspaces'
import { createWorkflow, setRunSecret } from '#domain/projects'
import { addRepoShare, BUILT_IN_USER_ID, findSiteByName, insertRepo, linkProjectRepo, seeTailnetUser, setUserRole, updateSite } from '#db'
import { closeDb } from '#db/client'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { cleanupTempDir, createTempDataDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver, resetWorkspaceDriver } from '#test/support/fake-driver'
import { DEMO_PROJECT_ID, seedProject } from '@yaac/test-utils/project-fixture'
import type { SiteRoute } from '#drivers/contract'

const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const stranger = { kind: 'local', userId: '4101bef8-794f-4d98-8e95-dfb54850c68b' } as const
const APP = { app: { run: 'pnpm start', service: true } }
/** A second repo for the project, in the folder `docs`. */
const DOCS = '0a0a0a0a-0000-4000-8000-0000000000aa'

let tmpDir: string
let routed: SiteRoute[][]
/** What each running release offers, as the driver records it. */
let offered: Map<string, number[]>

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await seedProject()
  // The graphs its sites run: one that serves, one that serves from the
  // volume, and one with no service.
  await createWorkflow(local, DEMO_PROJECT_ID, { name: 'app', steps: APP })
  await createWorkflow(local, DEMO_PROJECT_ID, { name: 'on-volume', steps: { app: { run: 'x', service: true, needs: ['volume'] } } })
  await createWorkflow(local, DEMO_PROJECT_ID, { name: 'build', steps: { build: { run: 'make' } } })
  routed = []
  offered = new Map([['rel-1', [3001]]])
  installFakeWorkspaceDriver({
    syncSites: (sites) => { routed.push(sites); return Promise.resolve() },
    siteTunnelStatus: () => Promise.resolve('connected'),
    find: (id) => Promise.resolve(offered.has(id) ? handleFixture({ workspaceId: id, jobName: `yaac-${id}` }) : undefined),
    unforwardPort: ({ workspaceId }, port) => {
      offered.set(workspaceId, (offered.get(workspaceId) ?? []).filter((p) => p !== port))
      return Promise.resolve(true)
    },
    declareForwards: (workspaceId, forwards) => {
      offered.set(workspaceId, [...offered.get(workspaceId) ?? [], ...forwards.map((f) => f.containerPort)])
      return Promise.resolve(forwards.map(({ containerPort }) => ({ containerPort, hostPort: containerPort })))
    },
  })
})

afterEach(async () => {
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

/** Make another user the install's admin and the project's owner a
 *  member, answering the admin. */
async function demoteOwner(): Promise<{ kind: 'tailnet'; userId: string; login: string; name: string }> {
  const userId = await seeTailnetUser('admin@example.com', 'Admin')
  await setUserRole(userId, 'admin')
  await setUserRole(BUILT_IN_USER_ID, 'member')
  return { kind: 'tailnet', userId, login: 'admin@example.com', name: 'Admin' }
}

const create = (over: Partial<Parameters<typeof createSite>[2]> = {}): Promise<void> =>
  createSite(local, DEMO_PROJECT_ID, { name: 'shop', hostname: 'shop.example.com', port: 3000, workflow: 'app', ...over })

describe('createSite', () => {
  it('routes a new site with no release, refusing bad settings, a taken name or hostname and a non-owner', async () => {
    await create()
    const row = await findSiteByName(DEMO_PROJECT_ID, 'shop')
    expect(routed.at(-1)).toEqual([{ siteId: row!.id, hostname: 'shop.example.com', port: 3000 }])
    // A domain's apex is a hostname too, lowercased.
    await create({ name: 'apex', hostname: 'SHOP.test' })
    expect((await findSiteByName(DEMO_PROJECT_ID, 'apex'))?.hostname).toBe('shop.test')

    await expect(create({ name: 'Bad Name', hostname: 'a.example.com' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(create({ name: 'a', hostname: 'https://a.example.com' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(create({ name: 'a', hostname: 'a.example.com', port: 0 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(create({ name: 'a', hostname: 'a.example.com', adminPort: 70000 })).rejects.toMatchObject({ code: 'VALIDATION' })
    // The router serves the site's port to the internet, which the admin
    // port must never be.
    await expect(create({ name: 'a', hostname: 'a.example.com', adminPort: 3000 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(create({ name: 'a', hostname: 'a.example.com', workflow: 'build' }))
      .rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('service') as unknown })
    // Only a site with a volume may wait on it.
    await expect(create({ name: 'a', hostname: 'a.example.com', workflow: 'on-volume' }))
      .rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(create({ name: 'a', hostname: 'a.example.com', volume: 'missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(create({ name: 'a', hostname: 'a.example.com', followBranch: 'main..x' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(create({ hostname: 'other.example.com' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(create({ name: 'other' })).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('shop.example.com') as unknown })
    await expect(createSite(stranger, DEMO_PROJECT_ID, { name: 'x', hostname: 'x.example.com', port: 1, workflow: 'app' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })

    // One volume holds one site's data.
    await createVolume(local, DEMO_PROJECT_ID, 'data')
    await create({ name: 'v1', hostname: 'v1.example.com', volume: 'data' })
    await expect(create({ name: 'v2', hostname: 'v2.example.com', volume: 'data' })).rejects.toMatchObject({ code: 'CONFLICT' })

    // Any domain is taken, since the tunnel decides what is public.
    await create({ name: 'blog', hostname: ' Blog.Elsewhere.org ' })
    expect(routed.at(-1)?.map((r) => r.hostname).sort()).toEqual(['blog.elsewhere.org', 'shop.example.com', 'shop.test', 'v1.example.com'])

    // Publishing takes an admin, even on the caller's own project.
    await demoteOwner()
    await expect(create({ name: 'mine', hostname: 'mine.example.com' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('publish sites') as unknown })
  })
})

describe('editSite', () => {
  it('moves the hostname and admin port at once and keeps the rest for the next deploy, refusing during a deploy', async () => {
    await createVolume(local, DEMO_PROJECT_ID, 'data')
    await create({ adminPort: 3001, volume: 'data', workflow: 'on-volume' })
    const row = (await findSiteByName(DEMO_PROJECT_ID, 'shop'))!
    await updateSite(row.id, { liveWorkspaceId: 'rel-1', livePort: 3000 })

    await editSite(local, DEMO_PROJECT_ID, 'shop', { hostname: 'www.example.com', port: 4000, adminPort: 4001 })
    expect(routed.at(-1)).toEqual([{ siteId: row.id, hostname: 'www.example.com', port: 3000, liveWorkspaceId: 'rel-1' }])
    expect(await findSiteByName(DEMO_PROJECT_ID, 'shop')).toMatchObject({ port: 4000, adminPort: 4001 })
    // The live release offers the new admin port in place of the old, as a
    // server restart would.
    expect(offered.get('rel-1')).toEqual([4001])
    expect((await offeredForwards([], row.id)).map((f) => f.containerPort)).toEqual([4001])

    // Equal to the port the internet reaches, whichever side moves.
    await expect(editSite(local, DEMO_PROJECT_ID, 'shop', { adminPort: 4000 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(editSite(local, DEMO_PROJECT_ID, 'shop', { port: 4001 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(editSite(local, DEMO_PROJECT_ID, 'shop', { adminPort: 0 })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(offered.get('rel-1')).toEqual([4001])

    // Removing it closes it on the live release at once.
    await editSite(local, DEMO_PROJECT_ID, 'shop', { adminPort: null })
    expect((await findSiteByName(DEMO_PROJECT_ID, 'shop'))?.adminPort).toBeUndefined()
    expect(offered.get('rel-1')).toEqual([])
    expect(await offeredForwards([], row.id)).toEqual([])

    // Its workflow needs the volume, so the volume cannot go without a
    // workflow that does not.
    await expect(editSite(local, DEMO_PROJECT_ID, 'shop', { volume: null })).rejects.toMatchObject({ code: 'VALIDATION' })
    await editSite(local, DEMO_PROJECT_ID, 'shop', { volume: null, workflow: 'app' })
    expect((await findSiteByName(DEMO_PROJECT_ID, 'shop'))?.volumeId).toBeUndefined()

    // A branch to follow is one on origin, by its own name: a ref-like name
    // would follow a branch anyone who may push could create.
    await editSite(local, DEMO_PROJECT_ID, 'shop', { followBranch: 'dev' })
    expect((await listProjectSiteEntries(DEMO_PROJECT_ID))[0]).toMatchObject({ followBranch: 'dev' })
    for (const branch of ['HEAD', 'origin/main', 'refs/heads/main', 'agent/x', 'missing']) {
      await expect(editSite(local, DEMO_PROJECT_ID, 'shop', { followBranch: branch }), branch).rejects.toMatchObject({ code: 'VALIDATION' })
    }

    await updateSite(row.id, { deployWorkspaceId: 'rel-2' })
    await expect(editSite(local, DEMO_PROJECT_ID, 'shop', { port: 5000 })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(editSite(stranger, DEMO_PROJECT_ID, 'shop', { port: 5000 })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(editSite(local, DEMO_PROJECT_ID, 'none', { port: 5000 })).rejects.toMatchObject({ code: 'NOT_FOUND' })

    // Following pauses while its owner is not an admin, and saying so; and
    // stopping it publishes nothing, so any admin may, mid-deploy too.
    await expect(editSite(stranger, DEMO_PROJECT_ID, 'shop', { followBranch: null })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const admin = await demoteOwner()
    expect((await listProjectSiteEntries(DEMO_PROJECT_ID))[0]?.followPaused).toBe('its owner is not an admin')
    await editSite(admin, DEMO_PROJECT_ID, 'shop', { followBranch: null })
    expect((await findSiteByName(DEMO_PROJECT_ID, 'shop'))?.followBranch).toBeUndefined()
  })
})

describe('editSite on a workflow', () => {
  it('moves a site to another named workflow, checked as a release\'s graph', async () => {
    await create({})
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'web', steps: { web: { run: 'pnpm serve', service: true } } })
    await editSite(local, DEMO_PROJECT_ID, 'shop', { workflow: 'web' })
    expect((await listProjectSiteEntries(DEMO_PROJECT_ID))[0]).toMatchObject({ workflow: 'web', steps: { web: { run: ['pnpm serve'], service: true } } })
    await expect(editSite(local, DEMO_PROJECT_ID, 'shop', { workflow: 'build' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(editSite(local, DEMO_PROJECT_ID, 'shop', { workflow: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('createSite and editSite on a shared remote', () => {
  it('build from one of the project\'s repos, which a project with several must name', async () => {
    await create()
    expect((await findSiteByName(DEMO_PROJECT_ID, 'shop'))?.repoId).toBe(DEMO_PROJECT_ID)
    await insertRepo({ id: DOCS, owner: BUILT_IN_USER_ID, remoteUrl: 'https://example.com/docs' })
    await linkProjectRepo(DEMO_PROJECT_ID, DOCS, 'docs')
    await expect(create({ name: 'b', hostname: 'b.example.com' })).rejects.toMatchObject({ code: 'VALIDATION', message: /several repos/ })
    await create({ name: 'b', hostname: 'b.example.com', repo: 'demo' })
    expect((await findSiteByName(DEMO_PROJECT_ID, 'b'))?.repoId).toBe(DEMO_PROJECT_ID)
    await expect(create({ name: 'c', hostname: 'c.example.com', repo: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('refuse following a branch for a workflow naming secrets before writing anything', async () => {
    await setRunSecret(local, DEMO_PROJECT_ID, { name: 'P8_KEY', value: 'pem' })
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'keyed', steps: APP, secrets: ['P8_KEY'] })
    await create({ workflow: 'keyed', followBranch: 'dev' })
    // Another user can push the remote once it is shared.
    await addRepoShare(DEMO_PROJECT_ID, await seeTailnetUser('other@example.com', 'Other'))
    await expect(create({ name: 'b', hostname: 'b.example.com', workflow: 'keyed', followBranch: 'dev' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await findSiteByName(DEMO_PROJECT_ID, 'b')).toBeUndefined()
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'keyed-2', steps: APP, secrets: ['P8_KEY'] })
    await expect(editSite(local, DEMO_PROJECT_ID, 'shop', { workflow: 'keyed-2', hostname: 'moved.example.com' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await findSiteByName(DEMO_PROJECT_ID, 'shop')).toMatchObject({ hostname: 'shop.example.com' })
    // An edit that changes neither its workflow nor its branch approves nothing.
    await editSite(local, DEMO_PROJECT_ID, 'shop', { hostname: 'moved.example.com' })
    expect((await findSiteByName(DEMO_PROJECT_ID, 'shop'))?.hostname).toBe('moved.example.com')
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
  })

  it('lets any admin take a site down, and its owner once demoted', async () => {
    await create()
    await create({ name: 'blog', hostname: 'blog.example.com' })
    const admin = await demoteOwner()
    await deleteSite(admin, DEMO_PROJECT_ID, 'shop')
    await deleteSite(local, DEMO_PROJECT_ID, 'blog')
    expect(routed.at(-1)).toEqual([])
  })
})

describe('listProjectSiteEntries', () => {
  it('answers each site with its live release and the deploy under way', async () => {
    await createVolume(local, DEMO_PROJECT_ID, 'data')
    await create({ volume: 'data', adminPort: 3001 })
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
      adminPort: 3001,
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
  it('answers the install\'s tunnel\'s state', async () => {
    expect(await getSiteEdge()).toEqual({ tunnel: 'connected' })
  })
})
