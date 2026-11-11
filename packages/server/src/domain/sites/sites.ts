/**
 * Public sites (docs/public-sites.md): a project's app served on the
 * internet at a hostname, by one release workspace at a time. This module
 * owns a site's settings and what the API answers about it, and hands the
 * driver the routes to converge. Deploys, and replacing a release that
 * died, are deploys.ts.
 */
import { workspaceDriver } from '#drivers/driver'
import type { SiteRoute } from '#drivers/contract'
import {
  deleteSiteRow,
  findSiteByName,
  findVolumeByName,
  findWorkspaceRow,
  getProjectRow,
  getSiteRow,
  getVolumeRow,
  getNamedWorkflow,
  insertSite,
  listProjectSites,
  listSiteReleases,
  listSites,
  listVolumeSites,
  updateSite,
  type SitePatch,
  type SiteRow,
} from '#db'
import { authorizeProject, isProjectHeld, requireAdmin, type Actor } from '#domain/access'
import { remoteBranchExists } from '#domain/git'
import { approveWorkflowStart, checkWorkflowStart, missingRepos, projectRepo, resolveWorkflow } from '#domain/projects'
import { fetchRepoOrigin } from '#domain/repos'
import { VOLUME_NEED } from '#domain/workspaces'
import { isInfraPort } from '#lib/port-policy'
import { testEnv } from '@yaac/shared/env'
import { ServerError } from '@yaac/shared/errors'
import { isBranchName } from '@yaac/shared/git'
import { repoDir } from '@yaac/shared/project-paths'
import { FULL_COMMIT_PATTERN, parseStepGraph } from '@yaac/shared/steps'
import type { ProjectRow } from '#db'
import type { RepoCommits, RepoStart, SiteCommit, SiteDetail, SiteEdgeStatus, SiteEntry } from '@yaac/shared/types'
import { endReleases, followPause, sameCommits, siteTarget, withSiteLock } from './deploys'

const SITE_NAME = /^[a-z0-9-]{1,40}$/
const DNS_NAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/

/** How many releases `GET /site/show` lists. */
const SHOWN_RELEASES = 20

/**
 * Authorize publishing a site (create, edit, deploy, start): its project's
 * owner, who must also be an admin of the install (docs/public-sites.md
 * "Sites and releases").
 */
export async function authorizeSitePublish(principal: Actor, projectId: string): Promise<void> {
  await authorizeProject(principal, projectId)
  await requireAdmin(principal, 'publish sites')
}

/**
 * Authorize stopping or deleting a site: any admin, or its project's owner
 * even once they are not one, so a site can always be taken down and its
 * hostname freed.
 */
export async function authorizeSiteEnd(principal: Actor, projectId: string): Promise<void> {
  const project = await getProjectRow(projectId)
  const admin = await requireAdmin(principal).then(() => true, () => false)
  if (project && admin && !isProjectHeld(projectId)) return
  await authorizeProject(principal, projectId)
}

export async function requireSite(projectId: string, name: string): Promise<SiteRow> {
  const row = await findSiteByName(projectId, name)
  if (!row) throw new ServerError('NOT_FOUND', `this project has no site named "${name}"`)
  return row
}

/**
 * A hostname, lowercased. Any name is accepted: it only receives traffic
 * once the install's Cloudflare tunnel routes it, which is decided in the
 * Cloudflare account (docs/public-sites.md "The edge").
 */
function checkHostname(raw: string): string {
  const hostname = raw.trim().toLowerCase()
  if (!DNS_NAME.test(hostname)) throw new ServerError('VALIDATION', `"${raw}" is not a hostname like shop.example.com`)
  return hostname
}

function checkPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || isInfraPort(port)) {
    throw new ServerError('VALIDATION', `${String(port)} is not a port a site may serve on`)
  }
}

/** A site's ports: the admin port, which no login guards, must not be the
 *  one the router serves to the internet. */
function checkPorts(port: number, adminPort: number | undefined): void {
  checkPort(port)
  if (adminPort === undefined) return
  checkPort(adminPort)
  if (adminPort === port) throw new ServerError('VALIDATION', 'a site\'s admin port must differ from the port the internet reaches')
}

/**
 * Offer a site's running releases its new admin port in place of the old
 * one, so a removed admin port closes at once, and a server restart, which
 * offers what the site names (`offeredForwards`), finds nothing to change.
 * Only a release started since listens on a new one.
 */
async function reofferAdminPort(row: SiteRow, adminPort: number | undefined): Promise<void> {
  if (adminPort === row.adminPort) return
  const driver = workspaceDriver()
  for (const id of new Set([row.liveWorkspaceId, row.drainWorkspaceId].filter((w) => w !== undefined))) {
    const handle = await driver.find(id)
    if (handle?.running !== true) continue
    if (row.adminPort !== undefined) await driver.unforwardPort({ workspaceId: id, jobName: handle.jobName }, row.adminPort)
    if (adminPort !== undefined) await driver.declareForwards(id, [{ containerPort: adminPort, hostPortStart: adminPort }])
  }
}

/**
 * A branch of a site's repo, which must be on origin now. A name that reads
 * as a ref (`origin/main`, `refs/heads/main`) would deploy a branch
 * literally so named, which anyone who may push can create, and `agent/*`
 * branches are each a workspace's own; both are refused.
 */
async function checkBranch(dir: string, repoId: string, branch: string): Promise<string> {
  if (!isBranchName(branch)) throw new ServerError('VALIDATION', `${dir}: "${branch}" is not a branch name`)
  if (/^(?:origin|refs|agent)\//.test(branch)) {
    throw new ServerError('VALIDATION', `${dir}: "${branch}" names a branch by its own name on origin, like main`)
  }
  if (!testEnv.e2eSkipFetch) await fetchRepoOrigin(repoId)
  if (!await remoteBranchExists(repoDir(repoId), branch)) {
    throw new ServerError('VALIDATION', `${dir}: "${branch}" is not a branch on origin`)
  }
  return branch
}

/**
 * A site's repos as given (by folder or id), checked and stored by id: at
 * least one, each once, each at a branch on origin or a full commit. No
 * repo falls back to a default branch, which a rename on the remote would
 * change under the site.
 */
async function siteRepos(project: ProjectRow, raw: RepoStart[]): Promise<RepoStart[]> {
  if (raw.length === 0) throw new ServerError('VALIDATION', 'a site starts with at least one repo')
  const out: RepoStart[] = []
  for (const r of raw) {
    const link = projectRepo(project, r.repo)
    if (out.some((o) => o.repo === link.repo.id)) throw new ServerError('VALIDATION', `${link.dir} is named twice`)
    if ((r.branch === undefined) === (r.commit === undefined)) {
      throw new ServerError('VALIDATION', `${link.dir}: name a branch or a full commit, as ${link.dir}@<branch or commit>`)
    }
    if (r.commit !== undefined && !FULL_COMMIT_PATTERN.test(r.commit)) {
      throw new ServerError('VALIDATION', `${link.dir}: "${r.commit}" is not a full commit id (40 or 64 hex digits)`)
    }
    out.push(r.commit !== undefined
      ? { repo: link.repo.id, commit: r.commit }
      : { repo: link.repo.id, branch: await checkBranch(link.dir, link.repo.id, r.branch ?? '') })
  }
  return out
}

/**
 * The named workflow a site's releases run (docs/workflows.md): the one
 * named, else the site's own. Its current graph is checked as a release's:
 * it needs a service, and may need `volume` only when the site has one; and
 * the site's repos must include every repo it names. A deploy checks the
 * graph it runs again.
 */
async function siteWorkflow(
  projectId: string,
  name: string | undefined,
  hasVolume: boolean,
  repos: RepoStart[],
  row?: SiteRow,
): Promise<string> {
  const named = name !== undefined ? await resolveWorkflow(projectId, name) : await getNamedWorkflow(row?.namedWorkflowId ?? '')
  if (!named) throw new ServerError('VALIDATION', 'a site runs a named workflow; give one')
  try {
    parseStepGraph(named.workflow.steps, new Set(hasVolume ? [VOLUME_NEED] : []))
  } catch (err) {
    throw new ServerError('VALIDATION', `workflow "${named.name}": ${(err as Error).message}`)
  }
  if (!Object.values(named.workflow.steps).some((s) => s.service === true)) {
    throw new ServerError('VALIDATION', `workflow "${named.name}" needs a service, which serves the site`)
  }
  const missing = await missingRepos(projectId, named.workflow.repos, repos.map((r) => r.repo))
  if (missing.length > 0) {
    throw new ServerError('VALIDATION', `workflow "${named.name}" runs in ${missing.join(', ')}, which the site does not include`)
  }
  return named.id
}

/** A volume of the project that no other site keeps its data in. */
async function volumeId(projectId: string, name: string, siteId?: string): Promise<string> {
  const row = await findVolumeByName(projectId, name)
  if (!row) throw new ServerError('NOT_FOUND', `this project has no volume named "${name}"; create it with \`yaac volume create\``)
  const other = (await listVolumeSites(row.id)).find((s) => s.id !== siteId)
  if (other) throw new ServerError('CONFLICT', `volume "${name}" already holds site "${other.name}"'s data`)
  return row.id
}

/**
 * Create a site. Its releases start with `repos`, each at a branch or a
 * full commit: one at the release's root, several in their folders.
 * Setting it to follow approves each branch and commit for its workflow
 * (docs/workflows.md "Approvals"), refused, if at all, before the site
 * exists.
 */
export async function createSite(principal: Actor, projectId: string, input: {
  name: string
  hostname: string
  port: number
  adminPort?: number
  workflow: string
  volume?: string
  repos: RepoStart[]
  follow?: boolean
}): Promise<void> {
  await authorizeSitePublish(principal, projectId)
  const project = await getProjectRow(projectId)
  if (!project) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  if (!SITE_NAME.test(input.name)) {
    throw new ServerError('VALIDATION', `"${input.name}" is not a site name: use 1-40 of a-z, 0-9 and -`)
  }
  checkPorts(input.port, input.adminPort)
  const repos = await siteRepos(project, input.repos)
  const namedWorkflowId = await siteWorkflow(projectId, input.workflow, input.volume !== undefined, repos)
  const follow = input.follow === true
  if (follow) await checkWorkflowStart(principal, namedWorkflowId, repos)
  await insertSite({
    projectId,
    name: input.name,
    hostname: checkHostname(input.hostname),
    port: input.port,
    ...(input.adminPort !== undefined ? { adminPort: input.adminPort } : {}),
    namedWorkflowId,
    ...(input.volume !== undefined ? { volumeId: await volumeId(projectId, input.volume) } : {}),
    repos,
    follow,
  })
  if (follow) await approveWorkflowStart(principal, namedWorkflowId, repos)
  await syncSiteRoutes()
}

/**
 * Change a site. The hostname and admin port move at once; the port,
 * workflow, volume and repos apply from the next deploy, so the live
 * release keeps serving as it was started. A following site deploys its
 * target at the next reconcile if it is not what the site serves. Refused
 * while a deploy runs, which was started with the old settings, except an
 * edit that only stops following: that publishes nothing, so whoever may
 * stop the site may make it, mid-deploy too.
 */
export async function editSite(principal: Actor, projectId: string, name: string, input: {
  hostname?: string
  port?: number
  adminPort?: number | null
  workflow?: string
  volume?: string | null
  repos?: RepoStart[]
  follow?: boolean
}): Promise<void> {
  if (input.follow === false && Object.entries(input).every(([k, v]) => k === 'follow' || v === undefined)) {
    await authorizeSiteEnd(principal, projectId)
    const { id } = await requireSite(projectId, name)
    await withSiteLock(id, () => updateSite(id, { follow: false }))
    return
  }
  await authorizeSitePublish(principal, projectId)
  const { id } = await requireSite(projectId, name)
  const project = await getProjectRow(projectId)
  if (!project) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  const repos = input.repos !== undefined ? await siteRepos(project, input.repos) : undefined
  await withSiteLock(id, async () => {
    const row = await getSiteRow(id)
    if (!row) throw new ServerError('NOT_FOUND', `this project has no site named "${name}"`)
    if (row.deployWorkspaceId !== undefined) {
      throw new ServerError('CONFLICT', `site "${name}" is deploying; edit it once the deploy ends`)
    }
    const patch: SitePatch = {}
    if (input.hostname !== undefined) patch.hostname = checkHostname(input.hostname)
    const adminPort = input.adminPort === undefined ? row.adminPort : input.adminPort ?? undefined
    checkPorts(input.port ?? row.port, adminPort)
    if (input.port !== undefined) patch.port = input.port
    if (input.adminPort !== undefined) patch.adminPort = input.adminPort
    if (input.volume !== undefined) patch.volumeId = input.volume === null ? null : await volumeId(projectId, input.volume, id)
    if (repos !== undefined) patch.repos = repos
    if (input.follow !== undefined) patch.follow = input.follow
    const hasVolume = input.volume !== undefined ? input.volume !== null : row.volumeId !== undefined
    // The graph is checked against the volume and repos it will run with,
    // so dropping the volume, or a repo, that the graph needs is refused.
    patch.namedWorkflowId = await siteWorkflow(projectId, input.workflow, hasVolume, repos ?? row.repos, row)
    // A person setting a site to follow, or changing what a following site
    // runs, approves each branch and commit it names for its workflow
    // (docs/workflows.md "Approvals"), refused before anything is written.
    const approves = (input.follow ?? row.follow)
      && (input.follow === true || repos !== undefined || input.workflow !== undefined)
    if (approves) await checkWorkflowStart(principal, patch.namedWorkflowId, repos ?? row.repos)
    await updateSite(id, patch)
    if (approves) await approveWorkflowStart(principal, patch.namedWorkflowId, repos ?? row.repos)
    await reofferAdminPort(row, adminPort)
  })
  await syncSiteRoutes()
}

/** Delete a site: stop its releases and its deploy, then the row, under
 *  one lock so no deploy starts between, and the hostname stops routing. */
export async function deleteSite(principal: Actor, projectId: string, name: string): Promise<void> {
  await authorizeSiteEnd(principal, projectId)
  const { id } = await requireSite(projectId, name)
  await withSiteLock(id, async () => {
    await endReleases(id)
    await deleteSiteRow(id)
  })
  await syncSiteRoutes()
}

/** A project's sites. Any user may read them, as every other resource. */
export async function listProjectSiteEntries(projectId: string): Promise<SiteEntry[]> {
  return await Promise.all((await listProjectSites(projectId)).map(toSiteEntry))
}

export async function showSite(projectId: string, name: string): Promise<SiteDetail> {
  const row = await requireSite(projectId, name)
  const releases = await listSiteReleases(row.id, SHOWN_RELEASES)
  return {
    ...await toSiteEntry(row),
    releases: releases.map((r) => ({
      workspaceId: r.workspaceId,
      commits: r.checkouts.flatMap((c) => (c.startCommit !== undefined ? [{ dir: c.path, commit: c.startCommit }] : [])),
      createdAt: r.createdAt.toISOString(),
      ...(r.stoppedAt !== undefined ? { stoppedAt: r.stoppedAt.toISOString() } : {}),
      ...(r.rerunOf !== undefined ? { rerunOf: r.rerunOf } : {}),
    })),
  }
}

/** Whether the install's tunnel is connected. */
export async function getSiteEdge(): Promise<SiteEdgeStatus> {
  return { tunnel: await workspaceDriver().siteTunnelStatus() }
}

/**
 * Commits by repo as a release's checkouts sit: a lone repo at the root,
 * several each in its folder (the repo's id where the project links it no
 * more).
 */
export function siteCommits(project: ProjectRow | undefined, commits: RepoCommits): SiteCommit[] {
  const entries = Object.entries(commits)
  if (entries.length === 1) return [{ dir: '', commit: entries[0][1] }]
  return entries.map(([repoId, commit]) => ({ dir: project?.repos.find((l) => l.repo.id === repoId)?.dir ?? repoId, commit }))
    .sort((a, b) => a.dir.localeCompare(b.dir))
}

async function toSiteEntry(row: SiteRow): Promise<SiteEntry> {
  const project = await getProjectRow(row.projectId)
  const volume = row.volumeId !== undefined ? await getVolumeRow(row.volumeId) : undefined
  const live = row.liveWorkspaceId !== undefined ? await findWorkspaceRow(row.liveWorkspaceId) : undefined
  const paused = row.follow ? await followPause(row) : undefined
  const target = row.follow && row.failedCommits !== undefined ? await siteTarget(row) : undefined
  const workflow = await getNamedWorkflow(row.namedWorkflowId)
  const commits = (map: RepoCommits): SiteCommit[] => siteCommits(project, map)
  return {
    name: row.name,
    hostname: row.hostname,
    port: row.port,
    ...(row.adminPort !== undefined ? { adminPort: row.adminPort } : {}),
    workflow: workflow?.name ?? '',
    steps: workflow?.workflow.steps ?? {},
    ...(volume !== undefined ? { volume: volume.name } : {}),
    repos: row.repos.map((r) => ({
      dir: project?.repos.find((l) => l.repo.id === r.repo)?.dir ?? r.repo,
      ...(r.branch !== undefined ? { branch: r.branch } : {}),
      ...(r.commit !== undefined ? { commit: r.commit } : {}),
    })),
    follow: row.follow,
    ...(paused !== undefined ? { followPaused: paused } : {}),
    ...(target !== undefined && sameCommits(target, row.failedCommits) && !sameCommits(target, row.releaseCommits)
      ? { followSkipped: commits(target) } : {}),
    createdAt: row.createdAt.toISOString(),
    ...(row.liveWorkspaceId !== undefined && row.releaseCommits !== undefined && row.liveSince !== undefined
      ? {
        live: {
          workspaceId: row.liveWorkspaceId,
          commits: commits(row.releaseCommits),
          since: row.liveSince.toISOString(),
          running: live !== undefined && live.stoppedAt === undefined,
        },
      }
      : {}),
    ...(row.deployWorkspaceId !== undefined && row.deployCommits !== undefined && row.deployStartedAt !== undefined
      ? {
        deploy: {
          workspaceId: row.deployWorkspaceId,
          commits: commits(row.deployCommits),
          startedAt: row.deployStartedAt.toISOString(),
          phase: row.deployPhase ?? 'launching',
          ...(row.deployReplacing ? { replacing: true as const } : {}),
        },
      }
      : {}),
    ...(row.lastDeployWorkspaceId !== undefined && row.lastDeployCommits !== undefined
      && row.lastDeployOutcome !== undefined && row.lastDeployFinishedAt !== undefined
      ? {
        lastDeploy: {
          workspaceId: row.lastDeployWorkspaceId,
          commits: commits(row.lastDeployCommits),
          outcome: row.lastDeployOutcome,
          ...(row.lastDeployError !== undefined ? { error: row.lastDeployError } : {}),
          finishedAt: row.lastDeployFinishedAt.toISOString(),
        },
      }
      : {}),
  }
}

/**
 * Hand the driver every site's route: its hostname, the port its live
 * release serves on, and that release, which is absent while none is
 * meant to serve.
 */
export async function syncSiteRoutes(): Promise<void> {
  const routes: SiteRoute[] = (await listSites()).map((row) => ({
    siteId: row.id,
    hostname: row.hostname,
    port: row.livePort ?? row.port,
    ...(row.liveWorkspaceId !== undefined ? { liveWorkspaceId: row.liveWorkspaceId } : {}),
  }))
  await workspaceDriver().syncSites(routes)
}
