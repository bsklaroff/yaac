/**
 * Deploys of public sites (docs/public-sites.md "Deploys"): a release
 * created for real against the fake driver, advanced by `reconcileSites` as
 * its steps settle, with the volume handed over between releases. Step
 * states are set as the steps reconcile would record them; what the driver
 * is asked to route is what the assertions land on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import type * as ChildProcessModule from 'node:child_process'

/** The children running a stop's detached teardown, which a case ends by
 *  emitting `exit`. */
const teardowns = vi.hoisted(() => ({ children: [] as EventEmitter[] }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>()
  return {
    ...actual,
    spawn: (cmd: string, args: string[], opts: ChildProcessModule.SpawnOptions) => {
      if (cmd !== 'sh') return actual.spawn(cmd, args, opts)
      const child = Object.assign(new EventEmitter(), { unref: () => { /* detached */ } })
      teardowns.children.push(child)
      return child
    },
  }
})

import { backfillSiteBranches, createSite, deploySite, editSite, onSiteTimer, reconcileSites, showSite, startSite, stopSite } from '#domain/sites'
import { createVolume } from '#domain/workspaces'
import { createWorkflow, editWorkflow, setRunSecret } from '#domain/projects'
import { clearAllProvisioningForTests, listProvisioning } from '#domain/workspaces/provisioning'
import {
  BUILT_IN_USER_ID,
  applyWorkspaceEvent,
  findVolumeByName,
  findWorkspaceRow,
  getSiteRow,
  listWorkspaceRepos,
  listWorkspaceSteps,
  findSiteByName,
  insertRepo,
  insertSite,
  linkProjectRepo,
  seeTailnetUser,
  setUserRole,
} from '#db'
import { closeDb, getDb } from '#db/client'
import { repos } from '#db/schema'
import { eq } from 'drizzle-orm'
import { cleanupTempDir, createTempDataDir } from '@yaac/test-utils/setup'
import { git } from '@yaac/test-utils/git'
import { handleFixture, installFakeWorkspaceDriver, resetWorkspaceDriver, substrateFixture } from '#test/support/fake-driver'
import { DEMO_PROJECT_ID, seedProject } from '@yaac/test-utils/project-fixture'
import { repoDir } from '@yaac/shared/project-paths'
import { _clearTerminatingForTests } from '#runtime/status/terminating'
import type { RuntimeHandle, RuntimeSnapshot, SiteRoute, WorkspaceSpec } from '#drivers/contract'

const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const stranger = { kind: 'local', userId: '4101bef8-794f-4d98-8e95-dfb54850c68b' } as const

const STEPS = {
  build: { run: 'pnpm build' },
  db: { run: 'postgres -D "$YAAC_VOLUME_DIR/pg"', service: true, needs: ['volume'] },
  app: { run: 'pnpm start', service: true, needs: ['build', 'db'] },
}

let tmpDir: string
/** Units the driver reports running, by workspace id. */
let running: Map<string, RuntimeHandle>
/** What each launch was given. */
let launched: WorkspaceSpec[]
/** Every route set the driver was handed, last last. */
let routed: SiteRoute[][]
/** The owner key each workspace's egress registration named. */
let owners: string[]
let images: number

function snapshot(): RuntimeSnapshot {
  return {
    resync: false,
    takenAtMs: Date.now(),
    workspaces: () => Promise.resolve([...running.values()]),
    strayUnits: () => Promise.resolve([]),
  }
}

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await seedProject()
  await createWorkflow(local, DEMO_PROJECT_ID, { name: 'app', steps: { app: { run: 'pnpm start', service: true } } })
  clearAllProvisioningForTests()
  _clearTerminatingForTests()
  teardowns.children = []
  running = new Map()
  launched = []
  routed = []
  owners = []
  images = 0
  installDriver()
})

function installDriver(): void {
  installFakeWorkspaceDriver({
    launch: (spec) => {
      launched.push(spec)
      const handle = handleFixture({ projectId: DEMO_PROJECT_ID, workspaceId: spec.workspaceId, jobName: `yaac-${spec.workspaceId}` })
      running.set(spec.workspaceId, handle)
      return Promise.resolve(handle)
    },
    prepareImage: () => Promise.resolve(`registry.test/proj:${String(++images)}`),
    find: (id) => Promise.resolve(running.get(id)),
    findForTeardown: (id) => Promise.resolve(running.has(id)
      ? { workspaceId: id, projectId: DEMO_PROJECT_ID, unitName: `yaac-${id}` }
      : undefined),
    syncSites: (sites) => { routed.push(sites); return Promise.resolve() },
    prepareSubstrate: (intent) => { owners.push(intent.owner); return Promise.resolve(substrateFixture()) },
  })
}

afterEach(async () => {
  vi.useRealTimers()
  clearAllProvisioningForTests()
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

/** Wait for a deploy's detached create to finish. */
async function created(workspaceId: string): Promise<void> {
  await expect.poll(() => listProvisioning().some((p) => p.workspaceId === workspaceId), { timeout: 20_000 }).toBe(false)
  await expect.poll(async () => (await findWorkspaceRow(workspaceId))?.lifeStartedAt).toBeInstanceOf(Date)
}

/** How many stops have spawned their detached teardown. */
const stopsSpawned = (n: number): Promise<void> => expect.poll(() => teardowns.children.length).toBe(n)

/** Record a release's steps as the steps reconcile would. */
async function stepsAre(workspaceId: string, states: Record<string, 'running' | 'succeeded' | 'ready' | 'failed'>): Promise<void> {
  const row = await findWorkspaceRow(workspaceId)
  for (const [name, state] of Object.entries(states)) {
    await applyWorkspaceEvent({
      type: 'step-changed', projectId: DEMO_PROJECT_ID, workspaceId, life: row!.lifeStartedAt!, workflowName: row!.workflowName ?? '', name, state,
      ...(state === 'failed' ? { exitCode: 2 } : {}),
    })
  }
}

/** A stopped release's runtime is gone: its teardown finished. */
function gone(workspaceId: string): void {
  running.delete(workspaceId)
  for (const child of teardowns.children.splice(0)) child.emit('exit', 0)
}

const site = async () => (await findSiteByName(DEMO_PROJECT_ID, 'shop'))!
/** The site `shop`, of the demo repo at main unless `over` says. */
const createShop = (over: Partial<Parameters<typeof createSite>[2]> = {}): Promise<void> => createSite(local, DEMO_PROJECT_ID, {
  name: 'shop', hostname: 'shop.example.com', port: 3000, workflow: 'app', repos: [{ repo: 'demo', branch: 'main' }], ...over,
})
/** A second repo, `docs`, whose main clone is a copy of the first's. */
const DOCS = '0a0a0a0a-0000-4000-8000-0000000000aa'
async function linkDocs(): Promise<void> {
  await fs.cp(repoDir(DEMO_PROJECT_ID), repoDir(DOCS), { recursive: true })
  await insertRepo({ id: DOCS, owner: BUILT_IN_USER_ID, remoteUrl: 'https://example.com/docs' })
  await linkProjectRepo(DEMO_PROJECT_ID, DOCS, 'docs')
}
const lastRoute = (): SiteRoute | undefined => routed.at(-1)?.[0]

describe('deploySite', () => {
  it('starts a release at the commit, builds it, hands it the volume, and points the hostname at it once ready', async () => {
    await createVolume(local, DEMO_PROJECT_ID, 'data')
    // Its graph is a workflow's, which gives its releases a run secret.
    await setRunSecret(local, DEMO_PROJECT_ID, { name: 'P8_KEY', value: 'pem' })
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'shop', steps: STEPS, secrets: ['P8_KEY'] })
    await createShop({ adminPort: 3001, workflow: 'shop', volume: 'data' })
    const head = (await git(repoDir(DEMO_PROJECT_ID), ['rev-parse', 'origin/main'])).trim()
    await expect(deploySite(stranger, DEMO_PROJECT_ID, 'shop')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    // Deploying publishes, so its owner must also be an admin.
    await setUserRole(await seeTailnetUser('admin@example.com', 'Admin'), 'admin')
    await setUserRole(BUILT_IN_USER_ID, 'member')
    await expect(deploySite(local, DEMO_PROJECT_ID, 'shop'))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('publish sites') as unknown })
    await setUserRole(BUILT_IN_USER_ID, 'admin')

    // First deploy: nothing holds the volume, so it passes once the steps
    // before it are done.
    const first = await deploySite(local, DEMO_PROJECT_ID, 'shop')
    expect(first.commits).toEqual([{ dir: '', commit: head }])
    await created(first.workspaceId)
    // Another deploy of the commit deploying is that deploy.
    expect(await deploySite(local, DEMO_PROJECT_ID, 'shop')).toEqual(first)
    const spec = launched.at(-1)!
    // The workflow's run secrets, held by the runtime and named on the spec:
    // the deploy was a person's, so it approved its commit.
    expect(spec).toMatchObject({ siteId: (await site()).id, image: 'registry.test/proj:1', runSecrets: ['P8_KEY'] })
    expect(spec.env.some((e) => e.startsWith('YAAC_VOLUME_DIR='))).toBe(false)
    // The one port it offers is the site's admin port.
    expect(spec.env.filter((e) => e.startsWith('YAAC_PORT_'))).toEqual(['YAAC_PORT_3001=3001'])
    // No user's credentials are swapped into a workspace that serves the
    // internet, and it mounts nothing the project's other workspaces read.
    expect(owners).toEqual(['none'])
    expect(spec.mounts.filter((m) => !m.mountPath.startsWith('/usr/local/bin/')).map((m) => m.mountPath).sort())
      .toEqual(['/home/yaac/.yaac-logs', '/home/yaac/volume', `${repoDir(DEMO_PROJECT_ID)}/.git`, '/tmp/yaac-tmux', '/workspace'].sort())
    expect(spec.mounts.find((m) => m.mountPath === `${repoDir(DEMO_PROJECT_ID)}/.git`)?.readOnly).toBe(true)
    expect(spec.mounts.filter((m) => m.mountPath.startsWith('/usr/local/bin/')).every((m) => m.readOnly === true)).toBe(true)
    expect(spec.mounts).toContainEqual(expect.objectContaining({ mountPath: '/home/yaac/volume' }))
    expect(await findWorkspaceRow(first.workspaceId)).toMatchObject({ siteId: (await site()).id, cwd: '' })
    // The site's repo alone, at the workspace root, at the commit.
    expect(await listWorkspaceRepos(first.workspaceId))
      .toEqual([{ workspaceId: first.workspaceId, repoId: DEMO_PROJECT_ID, path: '', startCommit: head }])

    await reconcileSites(snapshot(), false)
    expect((await site()).deployPhase).toBe('building')
    await stepsAre(first.workspaceId, { build: 'succeeded' })
    await reconcileSites(snapshot(), false)
    expect((await findVolumeByName(DEMO_PROJECT_ID, 'data'))?.holderWorkspaceId).toBe(first.workspaceId)
    expect((await site()).deployPhase).toBe('starting')

    await stepsAre(first.workspaceId, { db: 'ready', app: 'ready' })
    await reconcileSites(snapshot(), false)
    expect(await site()).toMatchObject({
      liveWorkspaceId: first.workspaceId, releaseCommits: { [DEMO_PROJECT_ID]: head }, releaseImage: 'registry.test/proj:1', livePort: 3000,
    })
    expect(lastRoute()).toEqual({ siteId: (await site()).id, hostname: 'shop.example.com', port: 3000, liveWorkspaceId: first.workspaceId })
    expect((await showSite(DEMO_PROJECT_ID, 'shop')).lastDeploy).toMatchObject({ outcome: 'succeeded', commits: [{ dir: '', commit: head }] })
    expect((await findWorkspaceRow(first.workspaceId))?.title).toBe(`shop @ ${head.slice(0, 8)}`)

    // A redeploy builds beside the live release, mounted on its node, then
    // stops it to take the volume, and flips once ready.
    const second = await deploySite(local, DEMO_PROJECT_ID, 'shop', { ref: 'main' })
    await created(second.workspaceId)
    expect(launched.at(-1)).toMatchObject({ colocateWith: first.workspaceId })
    await stepsAre(second.workspaceId, { build: 'succeeded' })
    await reconcileSites(snapshot(), false)
    expect((await site()).deployPhase).toBe('handoff')
    await stopsSpawned(1)
    expect(lastRoute()?.liveWorkspaceId).toBe(first.workspaceId)
    gone(first.workspaceId)
    await reconcileSites(snapshot(), false)
    expect((await findVolumeByName(DEMO_PROJECT_ID, 'data'))?.holderWorkspaceId).toBe(second.workspaceId)
    await stepsAre(second.workspaceId, { db: 'ready', app: 'ready' })
    await reconcileSites(snapshot(), false)
    expect((await site()).liveWorkspaceId).toBe(second.workspaceId)
    expect(lastRoute()?.liveWorkspaceId).toBe(second.workspaceId)

    // A deploy whose step fails stops its release; the site keeps serving.
    const third = await deploySite(local, DEMO_PROJECT_ID, 'shop', { ref: head })
    await created(third.workspaceId)
    await stepsAre(third.workspaceId, { build: 'failed' })
    await reconcileSites(snapshot(), false)
    expect(await site()).toMatchObject({ liveWorkspaceId: second.workspaceId, lastDeployOutcome: 'failed' })
    expect((await site()).lastDeployError).toContain('step "shop.build" failed')
    expect((await findVolumeByName(DEMO_PROJECT_ID, 'data'))?.nextHolderWorkspaceId).toBeUndefined()
    await expect(deploySite(local, DEMO_PROJECT_ID, 'shop', { ref: 'nope' })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('starts a release of several repos, each in its folder, at a ref per repo or its setting', async () => {
    const repo = repoDir(DEMO_PROJECT_ID)
    await git(repo, ['update-ref', 'refs/remotes/origin/dev', (await git(repo, ['commit-tree', 'origin/dev^{tree}', '-p', 'origin/dev', '-m', 'dev'])).trim()])
    await linkDocs()
    const [main, dev] = await Promise.all(['origin/main', 'origin/dev'].map(async (r) => (await git(repo, ['rev-parse', r])).trim()))
    await createShop({ repos: [{ repo: 'demo', branch: 'main' }, { repo: 'docs', commit: main }] })
    await expect(deploySite(local, DEMO_PROJECT_ID, 'shop', { ref: 'dev' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(deploySite(local, DEMO_PROJECT_ID, 'shop', { refs: { nope: 'dev' } })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const deploy = await deploySite(local, DEMO_PROJECT_ID, 'shop', { refs: { docs: dev } })
    expect(deploy.commits).toEqual([{ dir: 'demo', commit: main }, { dir: 'docs', commit: dev }])
    // The same commits deploying are that deploy; any others are refused.
    expect(await deploySite(local, DEMO_PROJECT_ID, 'shop', { refs: { demo: 'main', docs: dev } })).toEqual(deploy)
    await expect(deploySite(local, DEMO_PROJECT_ID, 'shop')).rejects.toMatchObject({ code: 'CONFLICT' })
    await created(deploy.workspaceId)
    expect((await listWorkspaceRepos(deploy.workspaceId)).map((r) => [r.repoId, r.path, r.startCommit, r.baseBranch])).toEqual([
      [DEMO_PROJECT_ID, 'demo', main, undefined], [DOCS, 'docs', dev, undefined],
    ])
    expect((await findWorkspaceRow(deploy.workspaceId))?.title).toBe(`shop @ demo@${main.slice(0, 8)} docs@${dev.slice(0, 8)}`)
    expect((await showSite(DEMO_PROJECT_ID, 'shop')).releases[0].commits).toEqual(deploy.commits)
  })

  // A release runs no git of its own: the server makes its checkout.
  it('deploys a project with no git credential, whose release is given none', async () => {
    await (await getDb()).update(repos).set({ gitCredentialId: null }).where(eq(repos.id, DEMO_PROJECT_ID))
    await createShop()
    const deploy = await deploySite(local, DEMO_PROJECT_ID, 'shop')
    await created(deploy.workspaceId)
    expect(launched.at(-1)?.gitCredentials).toEqual([])
    expect(launched.at(-1)?.env.some((e) => e.startsWith('GH_TOKEN='))).toBe(false)
  })

  it('fails a deploy that is not ready by its deadline', async () => {
    await createShop()
    const deploy = await deploySite(local, DEMO_PROJECT_ID, 'shop', { timeoutMinutes: 1 })
    await created(deploy.workspaceId)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 2 * 60_000)
    await reconcileSites(snapshot(), false)
    expect(await site()).toMatchObject({ lastDeployOutcome: 'failed', lastDeployError: expect.stringContaining('1 minutes') as unknown })
    expect((await site()).deployWorkspaceId).toBeUndefined()
  })
})

describe('reconcileSites', () => {
  it('replaces a live release whose runtime is gone, at its commit and image, after a backoff', async () => {
    await createShop()
    const due = vi.fn()
    onSiteTimer(due)
    const first = await deploySite(local, DEMO_PROJECT_ID, 'shop')
    await created(first.workspaceId)
    await stepsAre(first.workspaceId, { app: 'ready' })
    await reconcileSites(snapshot(), false)
    expect((await site()).liveWorkspaceId).toBe(first.workspaceId)
    // An edit not yet deployed is not what a replacement runs.
    await editWorkflow(local, DEMO_PROJECT_ID, 'app', { steps: { web: { run: 'pnpm serve', service: true } } })

    vi.useFakeTimers({ toFake: ['Date'] })
    running.delete(first.workspaceId)
    await reconcileSites(snapshot(), false)
    const waiting = await site()
    expect(waiting.replaceAfter).toBeInstanceOf(Date)
    expect(waiting.deployWorkspaceId).toBeUndefined()

    vi.setSystemTime(waiting.replaceAfter!.getTime() + 1)
    await reconcileSites(snapshot(), false)
    const replacing = await site()
    expect(replacing).toMatchObject({ deployReplacing: true, deployCommits: waiting.releaseCommits })
    vi.useRealTimers()
    await created(replacing.deployWorkspaceId!)
    expect(launched.at(-1)).toMatchObject({ image: 'registry.test/proj:1' })
    expect(await findWorkspaceRow(replacing.deployWorkspaceId!)).toMatchObject({ rerunOf: first.workspaceId })
    expect((await findWorkspaceRow(replacing.deployWorkspaceId!))?.workflowId)
      .toBe((await findWorkspaceRow(first.workspaceId))?.workflowId)
    expect((await findWorkspaceRow(replacing.deployWorkspaceId!))?.workflowName).toBe('app')
    await stepsAre(replacing.deployWorkspaceId!, { app: 'ready' })
    await reconcileSites(snapshot(), false)
    expect((await site()).liveWorkspaceId).toBe(replacing.deployWorkspaceId)
  })

  it('stops the old release once its drain is over, or at once when the next flip comes first', async () => {
    await createShop()
    const flip = async (): Promise<string> => {
      const deploy = await deploySite(local, DEMO_PROJECT_ID, 'shop')
      await created(deploy.workspaceId)
      await stepsAre(deploy.workspaceId, { app: 'ready' })
      await reconcileSites(snapshot(), false)
      return deploy.workspaceId
    }
    const first = await flip()
    const second = await flip()
    expect(await site()).toMatchObject({ liveWorkspaceId: second, drainWorkspaceId: first })
    expect(teardowns.children).toHaveLength(0)

    // A third flip inside the drain stops the first now, rather than
    // forgetting it while it runs.
    const third = await flip()
    await stopsSpawned(1)
    expect(await site()).toMatchObject({ liveWorkspaceId: third, drainWorkspaceId: second })
    gone(first)

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 31_000)
    // A stop that fails keeps the release named, so the next pass retries.
    installFakeWorkspaceDriver({
      find: (id) => Promise.resolve(running.get(id)),
      findForTeardown: () => Promise.reject(new Error('apiserver unreachable')),
      syncSites: (sites) => { routed.push(sites); return Promise.resolve() },
    })
    await reconcileSites(snapshot(), false)
    expect((await site()).drainWorkspaceId).toBe(second)
    installDriver()
    await reconcileSites(snapshot(), false)
    await stopsSpawned(1)
    expect((await site()).drainWorkspaceId).toBeUndefined()
  })

  it('deploys each new tip of the branch a serving site follows, keeping the last good release when one fails', async () => {
    const repo = repoDir(DEMO_PROJECT_ID)
    /** Move origin/dev to a new commit on top of it, as a fetch would. */
    const push = async (): Promise<string> => {
      const sha = (await git(repo, ['commit-tree', 'origin/dev^{tree}', '-p', 'origin/dev', '-m', 'next'])).trim()
      await git(repo, ['update-ref', 'refs/remotes/origin/dev', sha])
      return sha
    }
    // Setting it to follow approves the branch for its workflow, so each
    // tip deploys with the workflow's run secret.
    await setRunSecret(local, DEMO_PROJECT_ID, { name: 'P8_KEY', value: 'pem' })
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'shop', steps: { app: { run: 'pnpm start', service: true } }, secrets: ['P8_KEY'] })
    await createShop({ workflow: 'shop', repos: [{ repo: 'demo', branch: 'dev' }], follow: true })
    // Not serving yet, so nothing follows.
    await reconcileSites(snapshot(), false)
    expect((await site()).deployWorkspaceId).toBeUndefined()
    await expect(deploySite(local, DEMO_PROJECT_ID, 'shop', { ref: 'main' })).rejects.toMatchObject({ code: 'CONFLICT' })
    const first = await deploySite(local, DEMO_PROJECT_ID, 'shop')
    expect(first.commits).toEqual([{ dir: '', commit: (await git(repo, ['rev-parse', 'origin/dev'])).trim() }])
    await created(first.workspaceId)
    await stepsAre(first.workspaceId, { app: 'ready' })
    await reconcileSites(snapshot(), false)
    expect((await site()).liveWorkspaceId).toBe(first.workspaceId)

    // A new tip that fails leaves the release that worked serving, and is
    // not tried again.
    const broken = await push()
    await reconcileSites(snapshot(), false)
    const failing = await site()
    expect(failing).toMatchObject({ deployCommits: { [DEMO_PROJECT_ID]: broken }, deployReplacing: false })
    await created(failing.deployWorkspaceId!)
    await stepsAre(failing.deployWorkspaceId!, { app: 'failed' })
    await reconcileSites(snapshot(), false)
    expect(await site()).toMatchObject({
      liveWorkspaceId: first.workspaceId, releaseCommits: { [DEMO_PROJECT_ID]: first.commits[0].commit }, failedCommits: { [DEMO_PROJECT_ID]: broken },
    })
    await reconcileSites(snapshot(), false)
    expect((await site()).deployWorkspaceId).toBeUndefined()
    expect((await showSite(DEMO_PROJECT_ID, 'shop')).followSkipped).toEqual([{ dir: '', commit: broken }])

    // The next tip is deployed and takes the hostname.
    const fixed = await push()
    await reconcileSites(snapshot(), false)
    const next = (await site()).deployWorkspaceId!
    await created(next)
    expect(launched.at(-1)?.runSecrets).toEqual(['P8_KEY'])
    await stepsAre(next, { app: 'ready' })
    await reconcileSites(snapshot(), false)
    expect(await site()).toMatchObject({ liveWorkspaceId: next, releaseCommits: { [DEMO_PROJECT_ID]: fixed } })
    expect(lastRoute()?.liveWorkspaceId).toBe(next)
    expect((await showSite(DEMO_PROJECT_ID, 'shop')).followSkipped).toBeUndefined()

    // Only while its owner may publish.
    await setUserRole(await seeTailnetUser('admin@example.com', 'Admin'), 'admin')
    await setUserRole(BUILT_IN_USER_ID, 'member')
    await push()
    await reconcileSites(snapshot(), false)
    expect((await site()).deployWorkspaceId).toBeUndefined()
  })
})

describe('reconcileSites across repos', () => {
  it('follows a site of a branch and a commit, deploying once per move, and replaces a release at the commits it ran', async () => {
    await linkDocs()
    const repo = repoDir(DEMO_PROJECT_ID)
    const main = (await git(repo, ['rev-parse', 'origin/main'])).trim()
    await createShop({ repos: [{ repo: 'demo', branch: 'dev' }, { repo: 'docs', commit: main }], follow: true })
    // Following deploys only its target.
    await expect(deploySite(local, DEMO_PROJECT_ID, 'shop', { refs: { docs: 'dev' } })).rejects.toMatchObject({ code: 'CONFLICT' })
    const first = await deploySite(local, DEMO_PROJECT_ID, 'shop')
    await created(first.workspaceId)
    await stepsAre(first.workspaceId, { app: 'ready' })
    await reconcileSites(snapshot(), false)
    expect((await site()).liveWorkspaceId).toBe(first.workspaceId)
    await reconcileSites(snapshot(), false)
    expect((await site()).deployWorkspaceId).toBeUndefined()

    // A move of its branch deploys once, the commit repo where it was.
    const moved = (await git(repo, ['commit-tree', 'origin/dev^{tree}', '-p', 'origin/dev', '-m', 'next'])).trim()
    await git(repo, ['update-ref', 'refs/remotes/origin/dev', moved])
    await reconcileSites(snapshot(), false)
    const deploying = await site()
    expect(deploying.deployCommits).toEqual({ [DEMO_PROJECT_ID]: moved, [DOCS]: main })
    await reconcileSites(snapshot(), false)
    expect((await site()).deployWorkspaceId).toBe(deploying.deployWorkspaceId)
    await created(deploying.deployWorkspaceId!)
    await stepsAre(deploying.deployWorkspaceId!, { app: 'ready' })
    await reconcileSites(snapshot(), false)
    const live = (await site()).liveWorkspaceId!
    expect(live).toBe(deploying.deployWorkspaceId)

    // Its runtime gone, the replacement starts the commits and layout it ran,
    // whatever the site names since.
    await editSite(local, DEMO_PROJECT_ID, 'shop', { follow: false, repos: [{ repo: 'demo', branch: 'main' }] })
    vi.useFakeTimers({ toFake: ['Date'] })
    running.delete(live)
    await reconcileSites(snapshot(), false)
    vi.setSystemTime((await site()).replaceAfter!.getTime() + 1)
    await reconcileSites(snapshot(), false)
    const replacing = (await site()).deployWorkspaceId!
    vi.useRealTimers()
    await created(replacing)
    expect((await listWorkspaceRepos(replacing)).map((r) => [r.repoId, r.path, r.startCommit])).toEqual([
      [DEMO_PROJECT_ID, 'demo', moved], [DOCS, 'docs', main],
    ])
  })
})

describe('onSiteTimer', () => {
  it('is called when a drain is due', async () => {
    await createShop()
    const due = vi.fn()
    onSiteTimer(due)
    const first = await deploySite(local, DEMO_PROJECT_ID, 'shop')
    await created(first.workspaceId)
    await stepsAre(first.workspaceId, { app: 'ready' })
    await reconcileSites(snapshot(), false)
    const second = await deploySite(local, DEMO_PROJECT_ID, 'shop')
    await created(second.workspaceId)
    await stepsAre(second.workspaceId, { app: 'ready' })
    const timers = vi.spyOn(globalThis, 'setTimeout')
    await reconcileSites(snapshot(), false)
    const drain = timers.mock.calls.find(([, ms]) => (ms ?? 0) >= 30_000)
    timers.mockRestore()
    expect(due).not.toHaveBeenCalled()
    drain![0]()
    expect(due).toHaveBeenCalled()
  })
})

describe('stopSite', () => {
  it('stops the live release and its route, keeping what it ran for startSite', async () => {
    await createShop()
    const first = await deploySite(local, DEMO_PROJECT_ID, 'shop')
    await created(first.workspaceId)
    await stepsAre(first.workspaceId, { app: 'ready' })
    await reconcileSites(snapshot(), false)

    await expect(stopSite(stranger, DEMO_PROJECT_ID, 'shop')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await stopSite(local, DEMO_PROJECT_ID, 'shop')
    await stopsSpawned(1)
    expect(lastRoute()).toEqual({ siteId: (await site()).id, hostname: 'shop.example.com', port: 3000 })
    expect(await site()).toMatchObject({ releaseCommits: { [DEMO_PROJECT_ID]: expect.any(String) as unknown }, releaseImage: 'registry.test/proj:1' })
    expect((await site()).liveWorkspaceId).toBeUndefined()
  })

  it('forgets nothing when a release cannot be stopped, so a retry stops it', async () => {
    await createShop()
    const first = await deploySite(local, DEMO_PROJECT_ID, 'shop')
    await created(first.workspaceId)
    await stepsAre(first.workspaceId, { app: 'ready' })
    await reconcileSites(snapshot(), false)
    installFakeWorkspaceDriver({ findForTeardown: () => Promise.reject(new Error('apiserver unreachable')) })
    await expect(stopSite(local, DEMO_PROJECT_ID, 'shop')).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    expect((await site()).liveWorkspaceId).toBe(first.workspaceId)
  })
})

describe('startSite', () => {
  it('deploys the release a stopped site last ran, at its commit and image', async () => {
    await createShop()
    await expect(startSite(local, DEMO_PROJECT_ID, 'shop')).rejects.toMatchObject({ code: 'CONFLICT' })
    const first = await deploySite(local, DEMO_PROJECT_ID, 'shop')
    await created(first.workspaceId)
    await stepsAre(first.workspaceId, { app: 'ready' })
    await reconcileSites(snapshot(), false)
    await expect(startSite(local, DEMO_PROJECT_ID, 'shop')).rejects.toMatchObject({ code: 'CONFLICT' })

    await stopSite(local, DEMO_PROJECT_ID, 'shop')
    gone(first.workspaceId)
    const again = await startSite(local, DEMO_PROJECT_ID, 'shop')
    expect(again.commits).toEqual([{ dir: '', commit: (await site()).releaseCommits?.[DEMO_PROJECT_ID] }])
    await created(again.workspaceId)
    expect(launched.at(-1)).toMatchObject({ image: 'registry.test/proj:1' })
    expect((await getSiteRow((await site()).id))?.deployWorkspaceId).toBe(again.workspaceId)
    expect((await listWorkspaceSteps(again.workspaceId)).map((s) => s.name)).toEqual(['app'])
  })
})

describe('backfillSiteBranches', () => {
  it('names the default branch for a site repo the upgrade left with neither branch nor commit', async () => {
    await createShop()
    const named = (await site()).namedWorkflowId
    const legacy = await insertSite({
      projectId: DEMO_PROJECT_ID, name: 'legacy', hostname: 'legacy.example.com', port: 3000, namedWorkflowId: named,
      repos: [{ repo: DEMO_PROJECT_ID }], follow: false,
    })
    await backfillSiteBranches()
    expect((await getSiteRow(legacy.id))?.repos).toEqual([{ repo: DEMO_PROJECT_ID, branch: 'main' }])
    expect((await site()).repos).toEqual([{ repo: DEMO_PROJECT_ID, branch: 'main' }])
  })
})
