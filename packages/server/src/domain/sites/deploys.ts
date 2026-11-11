/**
 * Deploys of public sites (docs/public-sites.md "Deploys"). A deploy starts
 * a release workspace with each of the site's repos at a commit, waits for
 * it to be ready, points the hostname at it and drains the old release. It
 * is a state on the site's row, advanced by `reconcileSites`, so a server
 * restart mid-deploy resumes it. A live release whose runtime is gone is
 * replaced by a deploy of the same commits and image, with backoff, and a
 * following site deploys its target when a branch of it moves.
 */
import { randomUUID } from 'node:crypto'
import type { RuntimeSnapshot } from '#drivers/contract'
import {
  beginSiteDeploy,
  findWorkspaceRow,
  getProjectRow,
  getSiteRow,
  getUser,
  getVolumeRow,
  getNamedWorkflow,
  handOverVolume,
  leaseOf,
  listSites,
  listWorkspaceSteps,
  unstageVolume,
  updateSite,
  type SitePatch,
  type SiteRow,
  type StepRow,
} from '#db'
import { isProjectHeld, systemPrincipal, type Actor } from '#domain/access'
import { approveWorkflowStart, projectRepo } from '#domain/projects'
import { fetchRepoOrigin, freshenOrigin } from '#domain/repos'
import { getDefaultBranch, resolveRemoteRef } from '#domain/git'
import {
  listProvisioning,
  prepareStart,
  startOf,
  stopWorkspace,
  volumeUsers,
  workspacesAlive,
} from '#domain/workspaces'
import { createKeyedMutex } from '#lib/keyed-mutex'
import { serverLog } from '#lib/log'
import { notifyWorkspaceListChanged } from '#lib/notify'
import { testEnv } from '@yaac/shared/env'
import { ServerError } from '@yaac/shared/errors'
import { repoDir } from '@yaac/shared/project-paths'
import { FULL_COMMIT_PATTERN, formatCommits, stepFullName } from '@yaac/shared/steps'
import type { RepoCommits, RepoStart, SiteCommit } from '@yaac/shared/types'
import { authorizeSiteEnd, authorizeSitePublish, requireSite, siteCommits, syncSiteRoutes } from './sites'

/** How long a deploy may take to be ready, unless it names its own. */
const DEFAULT_DEPLOY_TIMEOUT_MS = 15 * 60_000
/** How long the old release keeps serving the connections it holds after
 *  a flip. It covers the router's next DNS refresh too. */
const DRAIN_MS = 30_000
/** Backoff between replacements of a release that keeps dying: doubling
 *  from the first, up to the last, and back to the first once a release
 *  served this long. */
const REPLACE_FIRST_MS = 1000
const REPLACE_MAX_MS = 5 * 60_000
const REPLACE_RESET_MS = 10 * 60_000

/** One pass at a site at a time: a deploy's start, its run's outcome, an
 *  edit, a stop or delete, and the reconcile step all change the row. */
export const withSiteLock = createKeyedMutex()

let timerListener: (() => void) | null = null

/**
 * Register what runs when a site's timer is due (a drain ending, a
 * replacement's backoff), which the composition root wires to a reconcile
 * pass.
 */
export function onSiteTimer(fn: () => void): void {
  timerListener = fn
}

function wakeAt(at: number): void {
  setTimeout(() => timerListener?.(), Math.max(0, at - Date.now()) + 100).unref()
}

const replaceDelay = (failures: number): number => Math.min(REPLACE_MAX_MS, REPLACE_FIRST_MS * 2 ** failures)

/** Whether two sets of commits are the same: equal maps over the same
 *  repos. */
export function sameCommits(a: RepoCommits | undefined, b: RepoCommits | undefined): boolean {
  if (a === undefined || b === undefined) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
}

/** A branch's tip on the origin of a repo, after a fetch, or a full commit
 *  as given. */
async function resolveDeployCommit(repoId: string, ref: string): Promise<string> {
  if (FULL_COMMIT_PATTERN.test(ref)) return ref
  if (!testEnv.e2eSkipFetch) {
    await fetchRepoOrigin(repoId).catch((err: unknown) => {
      throw new ServerError('INTERNAL', `could not fetch from remote: ${err instanceof Error ? err.message : String(err)}`)
    })
  }
  return await resolveRemoteRef(repoDir(repoId), ref).catch(() => {
    throw new ServerError('VALIDATION', `"${ref}" is neither a branch on origin nor a full commit id`)
  })
}

/** What a site's repo is set to: its branch or its commit. A repo left
 *  with neither by the upgrade before the backfill names one deploys its
 *  default branch, as it did (docs/legacy-compat-shims.md "A site's repo
 *  with no branch"). */
async function settingOf(r: RepoStart): Promise<string> {
  return r.commit ?? r.branch ?? await getDefaultBranch(repoDir(r.repo))
}

/**
 * A site's target: each repo's branch tip in its main clone, or the commit
 * it names. Undefined when a branch has no tip there.
 */
export async function siteTarget(site: SiteRow): Promise<RepoCommits | undefined> {
  const target: RepoCommits = {}
  for (const r of site.repos) {
    const commit = r.commit ?? await resolveRemoteRef(repoDir(r.repo), await settingOf(r)).catch(() => undefined)
    if (commit === undefined) return undefined
    target[r.repo] = commit
  }
  return target
}

/** What a release runs with besides its commits and image: its named
 *  workflow's current workflow, or the workflow a release ran, by id with
 *  the name it had there (docs/workflows.md); and how its repos sit, where
 *  it repeats a release. */
interface ReleaseConfig {
  workflow: { name: string } | { id: string; name?: string }
  port: number
  volumeId?: string
  start?: { repos: RepoStart[]; nested: boolean; cwd: string }
}

/** The site's current settings, which a new deploy runs with. */
async function siteConfig(site: SiteRow): Promise<ReleaseConfig> {
  const named = await getNamedWorkflow(site.namedWorkflowId)
  if (!named) throw new ServerError('NOT_FOUND', `site "${site.name}" names a workflow that is gone`)
  return {
    workflow: { name: named.name },
    port: site.port,
    ...(site.volumeId !== undefined ? { volumeId: site.volumeId } : {}),
  }
}

/**
 * What the site's last release ran with, so a replacement or `site start`
 * runs as it did rather than with edits made since: its workflow, volume,
 * repos at their start commits in its layout, and the port it served on.
 * The site's current settings where that release's row is gone.
 */
async function lastReleaseConfig(site: SiteRow): Promise<ReleaseConfig> {
  const release = site.releaseWorkspaceId !== undefined ? await findWorkspaceRow(site.releaseWorkspaceId) : undefined
  if (release?.workflowId === undefined) return await siteConfig(site)
  return {
    workflow: { id: release.workflowId, ...(release.workflowName !== undefined ? { name: release.workflowName } : {}) },
    port: site.livePort ?? site.port,
    ...(release.volumeId !== undefined ? { volumeId: release.volumeId } : {}),
    start: await startOf(release, 'commit'),
  }
}

/** A site read again under its lock, so an edit or delete made while the
 *  caller waited is the one acted on. */
async function lockedSite(id: string, name: string): Promise<SiteRow> {
  const site = await getSiteRow(id)
  if (!site) throw new ServerError('NOT_FOUND', `this project has no site named "${name}"`)
  return site
}

/**
 * Deploy a site: each repo at the ref `refs` names for it (by folder or
 * id; `ref` alone for a site of one repo), else at its setting, its
 * branch's tip or its commit. A following site deploys only its target,
 * which the next reconcile would put back over anything else. A deploy of
 * the commits already deploying, as following may have started on the
 * fetch this one made, is that deploy. Resolves with its release and
 * commits.
 */
export async function deploySite(
  principal: Actor,
  projectId: string,
  name: string,
  opts: { ref?: string; refs?: Record<string, string>; timeoutMinutes?: number } = {},
): Promise<{ workspaceId: string; commits: SiteCommit[] }> {
  await authorizeSitePublish(principal, projectId)
  const found = await requireSite(projectId, name)
  const project = await getProjectRow(projectId)
  const named = new Map<string, string>()
  if (opts.ref !== undefined) {
    if (found.repos.length !== 1) {
      throw new ServerError('VALIDATION', `site "${name}" has several repos; name a ref per repo, as <dir>@<ref>`)
    }
    named.set(found.repos[0].repo, opts.ref)
  }
  for (const [repo, ref] of Object.entries(opts.refs ?? {})) {
    const id = project !== undefined ? projectRepo(project, repo).repo.id : repo
    if (!found.repos.some((r) => r.repo === id)) throw new ServerError('VALIDATION', `site "${name}" does not start with ${repo}`)
    named.set(id, ref)
  }
  if (found.follow) {
    for (const r of found.repos) {
      const ref = named.get(r.repo)
      if (ref !== undefined && ref !== (r.branch ?? r.commit)) {
        throw new ServerError('CONFLICT', `site "${name}" follows its repos' branches, so it deploys only what they `
          + 'name; stop following it to deploy anything else')
      }
    }
  }
  const commits: RepoCommits = {}
  for (const r of found.repos) commits[r.repo] = await resolveDeployCommit(r.repo, named.get(r.repo) ?? await settingOf(r))
  const timeoutMs = opts.timeoutMinutes !== undefined ? opts.timeoutMinutes * 60_000 : DEFAULT_DEPLOY_TIMEOUT_MS
  return await withSiteLock(found.id, async () => {
    const site = await lockedSite(found.id, name)
    if (site.deployWorkspaceId !== undefined && sameCommits(site.deployCommits, commits) && !site.deployReplacing) {
      return { workspaceId: site.deployWorkspaceId, commits: siteCommits(project, commits) }
    }
    // A person deploying a following site approves what it follows for its
    // workflow, as setting it to follow does.
    if (site.follow) await approveWorkflowStart(principal, site.namedWorkflowId, site.repos)
    return await startDeploy(principal, site, { ...await siteConfig(site), commits, timeoutMs })
  })
}

/** Serve a stopped site again: a deploy of the release it last ran, at
 *  its commits and image, with its graph and volume. */
export async function startSite(principal: Actor, projectId: string, name: string): Promise<{ workspaceId: string; commits: SiteCommit[] }> {
  await authorizeSitePublish(principal, projectId)
  const { id } = await requireSite(projectId, name)
  return await withSiteLock(id, async () => {
    const site = await lockedSite(id, name)
    if (site.liveWorkspaceId !== undefined) throw new ServerError('CONFLICT', `site "${name}" is already serving`)
    const commits = site.releaseCommits
    if (commits === undefined) throw new ServerError('CONFLICT', `site "${name}" has never been deployed; deploy it`)
    return await startDeploy(principal, site, {
      ...await lastReleaseConfig(site),
      commits,
      ...(site.releaseImage !== undefined ? { image: site.releaseImage } : {}),
      timeoutMs: DEFAULT_DEPLOY_TIMEOUT_MS,
    })
  })
}

/** Stop serving a site: its deploy and its releases stop, and its
 *  hostname answers 503 until it is started or deployed again. */
export async function stopSite(principal: Actor, projectId: string, name: string): Promise<void> {
  await authorizeSiteEnd(principal, projectId)
  const { id } = await requireSite(projectId, name)
  await withSiteLock(id, () => endReleases(id))
  await syncSiteRoutes()
}

/**
 * Stop a site's deploy and every release it runs, and forget the live
 * one, keeping the commit and image it ran for `startSite`. Called holding
 * the site's lock. A release that could not be stopped is refused as
 * RUNTIME_UNAVAILABLE with nothing forgotten, so a retry stops it.
 */
export async function endReleases(siteId: string): Promise<void> {
  const row = await getSiteRow(siteId)
  if (!row) return
  for (const id of [row.deployWorkspaceId, row.liveWorkspaceId, row.drainWorkspaceId]) {
    if (id !== undefined && !await stopRelease(id)) {
      throw new ServerError('RUNTIME_UNAVAILABLE', `release ${id.slice(0, 8)} of site "${row.name}" could not be stopped; try again`)
    }
  }
  if (row.deployWorkspaceId !== undefined) await unstageRelease(row.deployWorkspaceId)
  await updateSite(siteId, {
    ...clearedDeploy,
    ...(row.deployWorkspaceId !== undefined ? lastDeploy(row, 'failed', 'the site was stopped') : {}),
    liveWorkspaceId: null,
    liveSince: null,
    drainWorkspaceId: null,
    drainUntil: null,
    replaceAfter: null,
  })
  notifyWorkspaceListChanged()
}

/** Stop a release. Resolves whether it is stopping or already gone; a
 *  caller forgets a release only then, so a failed stop is retried. */
async function stopRelease(workspaceId: string): Promise<boolean> {
  try {
    await stopWorkspace(systemPrincipal, workspaceId)
    return true
  } catch (err) {
    if (err instanceof ServerError && err.code === 'NOT_FOUND') return true
    serverLog(`[sites] stopping release ${workspaceId}: ${String(err)}`)
    return false
  }
}

/** Forget a release as its volume's next holder. */
async function unstageRelease(workspaceId: string): Promise<void> {
  const volumeId = (await findWorkspaceRow(workspaceId))?.volumeId
  if (volumeId !== undefined) await unstageVolume(volumeId, workspaceId)
}

const clearedDeploy: SitePatch = {
  deployWorkspaceId: null,
  deployCommits: null,
  deployImage: null,
  deployPort: null,
  deployPhase: null,
  deployStartedAt: null,
  deployDeadline: null,
  deployReplacing: false,
  deployHandoffFrom: null,
}

/** How a deploy ended, its error a clause each surface punctuates. */
function lastDeploy(row: SiteRow, outcome: 'succeeded' | 'failed', error?: string): SitePatch {
  return {
    lastDeployWorkspaceId: row.deployWorkspaceId ?? null,
    lastDeployCommits: row.deployCommits ?? null,
    lastDeployOutcome: outcome,
    lastDeployError: error?.replace(/\.+$/, '') ?? null,
    lastDeployFinishedAt: new Date(),
  }
}

/**
 * Start a deploy's release, refusing while another deploy runs. Its repos
 * start at `commits`, in the layout `start` repeats or else the one their
 * count gives: one at the root, several in their folders. Its volume is
 * mounted as next holder, and on the node of the release holding it. The
 * create runs detached; its outcome is the reconcile step's to read.
 * Called holding the site's lock.
 */
async function startDeploy(
  principal: Actor,
  site: SiteRow,
  opts: ReleaseConfig & {
    commits: RepoCommits
    image?: string
    timeoutMs: number
    replacing?: { rerunOf: string }
  },
): Promise<{ workspaceId: string; commits: SiteCommit[] }> {
  const workspaceId = randomUUID()
  const now = Date.now()
  const project = await getProjectRow(site.projectId)
  const repos = Object.entries(opts.commits).map(([repo, commit]) => ({ repo, commit }))
  const start = opts.start ?? { repos, nested: repos.length > 1, cwd: '.' }
  const commits = siteCommits(project, opts.commits)
  const begun = await beginSiteDeploy(site.id, {
    deployWorkspaceId: workspaceId,
    deployCommits: opts.commits,
    deployImage: opts.image ?? null,
    deployPort: opts.port,
    deployPhase: 'launching',
    deployStartedAt: new Date(now),
    deployDeadline: new Date(now + opts.timeoutMs),
    deployReplacing: opts.replacing !== undefined,
    deployHandoffFrom: null,
  })
  if (!begun) throw new ServerError('CONFLICT', `site "${site.name}" is already deploying`)
  try {
    const holder = opts.volumeId !== undefined ? (await getVolumeRow(opts.volumeId))?.holderWorkspaceId : undefined
    const run = await prepareStart(principal, {
      projectId: site.projectId,
      workspaceId,
      ...start,
      ...('id' in opts.workflow
        ? { workflowId: opts.workflow.id, ...(opts.workflow.name !== undefined ? { workflowName: opts.workflow.name } : {}) }
        : { workflow: opts.workflow.name }),
      noSession: true,
      title: `${site.name} @ ${formatCommits(commits, 8)}`,
      siteId: site.id,
      ...(opts.image !== undefined ? { image: opts.image } : {}),
      ...(opts.volumeId !== undefined ? { stageVolumeId: opts.volumeId } : {}),
      ...(holder !== undefined ? { colocateWith: holder } : {}),
      ...(opts.replacing !== undefined ? { rerunOf: opts.replacing.rerunOf } : {}),
      rememberDefaults: false,
      claimSpare: false,
    })
    void run().then(
      (result) => withSiteLock(site.id, async () => {
        const row = await getSiteRow(site.id)
        if (result.image !== undefined && row?.deployWorkspaceId === workspaceId) {
          await updateSite(site.id, { deployImage: result.image })
        }
      }),
      (err: unknown) => withSiteLock(site.id, () =>
        failDeploy(site.id, workspaceId, `its release did not start: ${err instanceof Error ? err.message : String(err)}`)),
    ).catch((err: unknown) => serverLog(`[sites] deploy of ${site.name}: ${String(err)}`))
  } catch (err) {
    await failDeploy(site.id, workspaceId, err instanceof Error ? err.message : String(err))
    throw err
  }
  notifyWorkspaceListChanged()
  return { workspaceId, commits }
}

/**
 * End a deploy that failed: its release stops, and the site keeps the
 * release it had. If the deploy had stopped that release to hand over the
 * volume, the live one is now gone, so the supervisor replaces it. A failed
 * replacement backs off before the next; any other failed commits are ones
 * following does not deploy again.
 */
async function failDeploy(siteId: string, workspaceId: string, error: string): Promise<void> {
  const row = await getSiteRow(siteId)
  if (row?.deployWorkspaceId !== workspaceId) return
  // Kept until its release stops, so the next pass fails it again.
  if (!await stopRelease(workspaceId)) return
  const at = row.deployCommits !== undefined ? formatCommits(siteCommits(undefined, row.deployCommits)) : '?'
  serverLog(`[sites] deploy of ${row.name} at ${at} failed: ${error}`)
  await unstageRelease(workspaceId)
  await updateSite(siteId, {
    ...clearedDeploy,
    ...lastDeploy(row, 'failed', error),
    ...(row.deployReplacing
      ? { replaceFailures: row.replaceFailures + 1, replaceAfter: new Date(Date.now() + replaceDelay(row.replaceFailures)) }
      : { failedCommits: row.deployCommits ?? null }),
  })
  if (row.deployReplacing) wakeAt(Date.now() + replaceDelay(row.replaceFailures))
  notifyWorkspaceListChanged()
}

/**
 * Advance every site: end drains that are due, move each deploy along (and
 * flip it once its release is ready), and replace a live release whose
 * runtime is gone. Then hand the driver the routes, when any changed or on
 * the resync.
 */
export async function reconcileSites(snapshot: RuntimeSnapshot, resync: boolean): Promise<void> {
  const alive = await workspacesAlive(snapshot)
  let changed = false
  for (const site of await listSites()) {
    try {
      if (await withSiteLock(site.id, () => reconcileSite(site.id, alive))) changed = true
    } catch (err) {
      serverLog(`[sites] ${site.name}: ${String(err)}`)
    }
  }
  if (changed || resync) await syncSiteRoutes()
}

/**
 * One site's pass. Resolves whether its route changed.
 */
async function reconcileSite(siteId: string, alive: (id: string) => boolean): Promise<boolean> {
  const row = await getSiteRow(siteId)
  if (!row) return false
  const now = Date.now()
  if (row.drainWorkspaceId !== undefined && row.drainUntil !== undefined && now >= row.drainUntil.getTime()
    && await stopRelease(row.drainWorkspaceId)) {
    await updateSite(siteId, { drainWorkspaceId: null, drainUntil: null })
  }
  if (row.deployWorkspaceId !== undefined) return await advanceDeploy(row, row.deployWorkspaceId, alive)
  if (await superviseLive(row, alive)) await followSite(row)
  return false
}

/** Whether a step is where a ready release has it. */
const stepReady = (s: StepRow): boolean => s.state === (s.spec.service === true ? 'ready' : 'succeeded')

async function setPhase(row: SiteRow, phase: SiteRow['deployPhase']): Promise<void> {
  if (row.deployPhase === phase) return
  await updateSite(row.id, { deployPhase: phase ?? null })
  notifyWorkspaceListChanged()
}

/**
 * Move a deploy along: wait for its release to be created, fail it past
 * its deadline or once its release or a step of it fails, hand it the
 * volume once the steps before the volume are done (stopping the release
 * that holds it), and flip the hostname to it once every step is ready.
 */
async function advanceDeploy(row: SiteRow, releaseId: string, alive: (id: string) => boolean): Promise<boolean> {
  const fail = async (error: string): Promise<boolean> => {
    await failDeploy(row.id, releaseId, error)
    return false
  }
  if (row.deployDeadline !== undefined && Date.now() > row.deployDeadline.getTime()) {
    const minutes = row.deployStartedAt !== undefined
      ? Math.round((row.deployDeadline.getTime() - row.deployStartedAt.getTime()) / 60_000)
      : undefined
    return await fail(`its release was not ready within ${minutes !== undefined ? `${String(minutes)} minutes` : 'its deadline'}`)
  }
  if (listProvisioning().some((p) => p.workspaceId === releaseId)) {
    await setPhase(row, 'launching')
    return false
  }
  const release = await findWorkspaceRow(releaseId)
  if (release === undefined || release.stoppedAt !== undefined || !alive(releaseId)) {
    return await fail(release?.deathDetail !== undefined ? `its release stopped: ${release.deathDetail}` : 'its release stopped')
  }
  const life = release.lifeStartedAt?.getTime()
  const steps = (await listWorkspaceSteps(releaseId)).filter((s) => s.life.getTime() === life)
  const broken = steps.find((s) => s.state === 'failed' || s.state === 'cancelled'
    || s.state === 'skipped' || s.state === 'interrupted')
  if (broken !== undefined) {
    return await fail(`step "${stepFullName(broken.workflowName, broken.name)}" ${broken.state}${broken.exitCode !== undefined ? ` (exit ${String(broken.exitCode)})` : ''}`)
  }
  if (release.volumeId !== undefined) {
    const volume = await getVolumeRow(release.volumeId)
    if (volume === undefined) return await fail('its volume was deleted')
    if (volume.holderWorkspaceId !== releaseId) {
      const users = volumeUsers(steps)
      if (!steps.filter((s) => !users.has(stepFullName(s.workflowName, s.name))).every(stepReady)) {
        await setPhase(row, 'building')
        return false
      }
      const holder = volume.holderWorkspaceId
      if (holder !== undefined && alive(holder)) {
        // Another site's release, or a dev workspace, is not this deploy's
        // to stop.
        if ((await findWorkspaceRow(holder))?.siteId !== row.id) {
          return await fail(`its volume is attached to workspace ${holder.slice(0, 8)}, which is not a release `
            + 'of this site; stop it first')
        }
        if (row.deployHandoffFrom !== holder) {
          await stopRelease(holder)
          await updateSite(row.id, { deployHandoffFrom: holder })
        }
        await setPhase(row, 'handoff')
        return false
      }
      const lease = holder !== undefined ? leaseOf(volume) : undefined
      if (await handOverVolume(volume.id, releaseId, lease) === undefined) return false
      await setPhase(row, 'starting')
      return false
    }
  }
  if (steps.length === 0 || !steps.every(stepReady)) {
    await setPhase(row, 'starting')
    return false
  }
  // A drain still under way from the last flip ends now, before this flip
  // names a new one; if it cannot be stopped, the flip waits a pass.
  if (row.drainWorkspaceId !== undefined && !await stopRelease(row.drainWorkspaceId)) return false
  const now = Date.now()
  const old = row.liveWorkspaceId
  const drain = old !== undefined && old !== releaseId && alive(old) ? old : undefined
  await updateSite(row.id, {
    ...clearedDeploy,
    ...lastDeploy(row, 'succeeded'),
    liveWorkspaceId: releaseId,
    releaseWorkspaceId: releaseId,
    liveSince: new Date(now),
    livePort: row.deployPort ?? row.port,
    releaseCommits: row.deployCommits ?? null,
    releaseImage: row.deployImage ?? null,
    drainWorkspaceId: drain ?? null,
    drainUntil: drain !== undefined ? new Date(now + DRAIN_MS) : null,
    replaceAfter: null,
    ...(row.deployReplacing ? {} : { replaceFailures: 0 }),
  })
  if (drain !== undefined) wakeAt(now + DRAIN_MS)
  notifyWorkspaceListChanged()
  return true
}

/**
 * Replace the live release once its runtime is gone, after a backoff that
 * grows while replacements keep dying soon after taking the hostname.
 * Resolves whether the live release is serving.
 */
async function superviseLive(row: SiteRow, alive: (id: string) => boolean): Promise<boolean> {
  const live = row.liveWorkspaceId
  if (live === undefined || row.releaseCommits === undefined) return false
  const release = await findWorkspaceRow(live)
  if (release !== undefined && release.stoppedAt === undefined && alive(live)) return true
  const now = Date.now()
  if (row.replaceAfter === undefined) {
    const served = row.liveSince !== undefined && now - row.liveSince.getTime() >= REPLACE_RESET_MS
    const failures = served ? 0 : row.replaceFailures
    serverLog(`[sites] ${row.name}: release ${live.slice(0, 8)} is gone; replacing it`
      + `${failures > 0 ? ` in ${String(Math.round(replaceDelay(failures) / 1000))}s` : ''}`)
    await updateSite(row.id, { replaceFailures: failures + 1, replaceAfter: new Date(now + replaceDelay(failures)) })
    wakeAt(now + replaceDelay(failures))
    return false
  }
  if (now < row.replaceAfter.getTime()) return false
  await updateSite(row.id, { replaceAfter: null })
  await startDeploy(systemPrincipal, row, {
    ...await lastReleaseConfig(row),
    commits: row.releaseCommits,
    ...(row.releaseImage !== undefined ? { image: row.releaseImage } : {}),
    timeoutMs: DEFAULT_DEPLOY_TIMEOUT_MS,
    replacing: { rerunOf: live },
  }).catch((err: unknown) => serverLog(`[sites] replacing ${row.name}'s release: ${String(err)}`))
  return false
}

/** When each following site first saw the target it would deploy now, by
 *  site, keyed by that target. In memory: a server restart only fetches
 *  each branch once more. */
const targetSeen = new Map<string, { target: string; at: number }>()

/** The sites whose paused following has been logged, so it is logged once. */
const pauseLogged = new Set<string>()

/**
 * Why a following site deploys nothing now, if it does not: following
 * publishes as the project's owner, who must be an admin, as for a deploy
 * they start.
 */
export async function followPause(row: SiteRow): Promise<string | undefined> {
  const owner = (await getProjectRow(row.projectId))?.owner
  return owner !== undefined && (await getUser(owner))?.role === 'admin' ? undefined : 'its owner is not an admin'
}

/**
 * Deploy a serving site's target once it differs from what the site
 * serves (docs/public-sites.md "Following"). Targets whose deploy failed
 * are not tried again, so the site keeps serving the last release that
 * worked until a branch moves on. Before a deploy starts, each repo at a
 * branch must have been fetched by a fetch that started after this target
 * was first seen; one that was not is fetched in the background, whose
 * landing runs this again, so a refresh that fetches every repo deploys
 * once. Not while following is paused
 * (`followPause`), nor while the project is held, which would fail the
 * deploy.
 */
async function followSite(row: SiteRow): Promise<void> {
  if (!row.follow || isProjectHeld(row.projectId)) return
  const paused = await followPause(row)
  if (paused !== undefined) {
    if (!pauseLogged.has(row.id)) serverLog(`[sites] ${row.name}: not following: ${paused}`)
    pauseLogged.add(row.id)
    return
  }
  pauseLogged.delete(row.id)
  const target = await siteTarget(row)
  if (target === undefined || sameCommits(target, row.releaseCommits) || sameCommits(target, row.failedCommits)) return
  const key = JSON.stringify(target)
  let seen = targetSeen.get(row.id)
  if (seen?.target !== key) {
    seen = { target: key, at: Date.now() }
    targetSeen.set(row.id, seen)
  }
  const since = seen.at
  const stale = testEnv.e2eSkipFetch ? [] : row.repos.filter((r) => r.commit === undefined && !freshenOrigin(r.repo, since))
  if (stale.length > 0) return
  targetSeen.delete(row.id)
  const at = formatCommits(siteCommits(await getProjectRow(row.projectId), target))
  serverLog(`[sites] ${row.name}: following, deploying ${at}`)
  await startDeploy(systemPrincipal, row, { ...await siteConfig(row), commits: target, timeoutMs: DEFAULT_DEPLOY_TIMEOUT_MS })
}

/**
 * Give each site repo that names neither a branch nor a commit its main
 * clone's default branch (docs/legacy-compat-shims.md "A site's repo with
 * no branch"): the upgrade that gave sites their repos could not name the
 * default branch a site that followed nothing deployed. Run once at server
 * start.
 */
export async function backfillSiteBranches(): Promise<void> {
  for (const site of await listSites()) {
    if (site.repos.every((r) => r.branch !== undefined || r.commit !== undefined)) continue
    try {
      const repos = await Promise.all(site.repos.map(async (r) => (r.branch !== undefined || r.commit !== undefined
        ? r : { repo: r.repo, branch: await getDefaultBranch(repoDir(r.repo)) })))
      await withSiteLock(site.id, () => updateSite(site.id, { repos }))
    } catch (err) {
      serverLog(`[sites] ${site.name}: naming its repo's default branch failed: ${String(err)}`)
    }
  }
}
