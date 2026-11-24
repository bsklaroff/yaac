/**
 * Public sites (docs/public-sites.md): a project's app served on the
 * internet at a hostname, by one release workspace at a time. This module
 * owns a site's settings and what the API answers about it, and hands the
 * driver the routes to converge. Deploys, and replacing a release that
 * died, are deploys.ts.
 *
 * Building a site (its repos, workflow, ports, volume, following) is its
 * project owner's, and so its agents'. Exposing one (publishing it at a
 * hostname, unpublishing, stopping or deleting it once published) is a
 * person's, and publishing an admin's (docs/public-sites.md "Publishing").
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
  getWorkflow,
  insertSite,
  listNamedWorkflows,
  listProjectSites,
  listSiteReleases,
  listSites,
  listVolumeSites,
  updateSite,
  type SitePatch,
  type SiteRow,
  type WorkspaceRow,
} from '#db'
import { authorizeProject, isProjectHeld, requireAdmin, requirePerson, type Actor } from '#domain/access'
import { remoteBranchExists } from '#domain/git'
import { approveStart, missingRepos, projectRepo, resolveWorkflow } from '#domain/projects'
import { fetchRepoOrigin } from '#domain/repos'
import { VOLUME_NEED } from '#domain/workspaces'
import { isInfraPort } from '#lib/port-policy'
import { env, testEnv } from '@yaac/shared/env'
import { ServerError } from '@yaac/shared/errors'
import { isBranchName } from '@yaac/shared/git'
import { repoDir } from '@yaac/shared/project-paths'
import { siteEdgeOf } from '@yaac/shared/site-edge'
import { FULL_COMMIT_PATTERN, parseStepGraph } from '@yaac/shared/steps'
import type { ProjectRow } from '#db'
import type { RepoCommits, RepoStart, SiteCommit, SiteDetail, SiteEdgeStatus, SiteEntry, SiteSummary } from '@yaac/shared/types'
import {
  approveRelease, authorizeExposure, endReleases, followPause, sameCommits, siteConfig, siteSpec, siteTarget, withSiteLock,
} from './deploys'

const SITE_NAME = /^[a-z0-9-]{1,40}$/
const DNS_NAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/

/** How many releases `GET /site/show` lists. */
const SHOWN_RELEASES = 20

/** Authorize publishing a site or moving its hostname: its project's owner,
 *  in person, while an admin of the install. */
async function authorizeSitePublish(principal: Actor, projectId: string): Promise<void> {
  await authorizeProject(principal, projectId)
  await requireAdmin(principal, 'publish sites')
}

/**
 * Authorize stopping or deleting a site (at `delegate`) or unpublishing it
 * (at `owner`): any admin, or its project's owner even once they are not
 * one, so a site can always be taken down and its hostname freed.
 */
export async function authorizeSiteEnd(principal: Actor, projectId: string, level: 'delegate' | 'owner'): Promise<void> {
  const project = await getProjectRow(projectId)
  const admin = await requireAdmin(principal).then(() => true, () => false)
  if (project && admin && !isProjectHeld(projectId)) return
  await authorizeProject(principal, projectId, level)
}

export async function requireSite(projectId: string, name: string): Promise<SiteRow> {
  const row = await findSiteByName(projectId, name)
  if (!row) throw new ServerError('NOT_FOUND', `this project has no site named "${name}"`)
  return row
}

/**
 * A hostname, lowercased. A name under the install's site domain is a
 * tailnet site's (docs/public-sites.md "Tailnet sites"): it must be one
 * label under the domain, which is what a wildcard certificate covers, and
 * needs a `tailnet` install, since a `local` one has no logins to stamp.
 * Any other name is public and accepted: it only receives traffic once the
 * install's Cloudflare tunnel routes it, which is decided in the Cloudflare
 * account (docs/public-sites.md "The edge"). A name the server itself
 * answers at is refused, since the tailnet tunnel sends the server's name
 * to the server.
 */
function checkHostname(raw: string): string {
  const hostname = raw.trim().toLowerCase()
  if (!DNS_NAME.test(hostname)) throw new ServerError('VALIDATION', `"${raw}" is not a hostname like shop.example.com`)
  if (env.allowedHosts.includes(hostname)) {
    throw new ServerError('VALIDATION', `${hostname} is where this yaac server answers, so no site may take it`)
  }
  const domain = env.siteDomain
  if (hostname === domain) {
    throw new ServerError('VALIDATION', `${domain} is the site domain itself: name a site under it, like shop.${domain}`)
  }
  if (domain === undefined || siteEdgeOf(hostname, domain) === 'public') return hostname
  if (hostname.slice(0, -domain.length - 1).includes('.')) {
    throw new ServerError('VALIDATION', `a tailnet site's hostname is one label under ${domain}, like shop.${domain}`)
  }
  if (env.accessMode !== 'tailnet') {
    throw new ServerError(
      'VALIDATION',
      `${hostname} is under the site domain, so it would be a tailnet site, which needs a tailnet install: this one is local and has no logins to give it`,
    )
  }
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
 * Create a site, unpublished: only its owner's forward reaches its releases
 * until a person publishes it. Its releases start with `repos`, each at a
 * branch or a full commit: one at the release's root, several in their
 * folders. A person setting it to follow approves each branch and commit
 * for its spec (docs/workflows.md "Approvals").
 */
export async function createSite(principal: Actor, projectId: string, input: {
  name: string
  port: number
  adminPort?: number
  workflow: string
  volume?: string
  repos: RepoStart[]
  follow?: boolean
  deployTimeoutMinutes?: number
}): Promise<void> {
  await authorizeProject(principal, projectId, 'delegate')
  const project = await getProjectRow(projectId)
  if (!project) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  if (!SITE_NAME.test(input.name)) {
    throw new ServerError('VALIDATION', `"${input.name}" is not a site name: use 1-40 of a-z, 0-9 and -`)
  }
  checkPorts(input.port, input.adminPort)
  const repos = await siteRepos(project, input.repos)
  const namedWorkflowId = await siteWorkflow(projectId, input.workflow, input.volume !== undefined, repos)
  const follow = input.follow === true
  const site = await insertSite({
    projectId,
    name: input.name,
    port: input.port,
    ...(input.adminPort !== undefined ? { adminPort: input.adminPort } : {}),
    namedWorkflowId,
    ...(input.volume !== undefined ? { volumeId: await volumeId(projectId, input.volume) } : {}),
    repos,
    follow,
    ...(input.deployTimeoutMinutes !== undefined ? { deployTimeoutMinutes: input.deployTimeoutMinutes } : {}),
  })
  if (follow) await approveStart(principal, siteSpec(site.id, await siteConfig(site)), repos)
}

/**
 * Change how a site is built: its owner's, and its agents' while it is
 * unpublished; a published site's, a person's who is an admin. The admin
 * port moves at once; the port, workflow, volume, repos and deploy
 * timeout apply from the next deploy, so the live release keeps serving
 * as it was started. A following site deploys its target at the next
 * reconcile if it is not what the site serves. Refused while a deploy
 * runs, which was started with the old settings, except an edit that only
 * stops following: that publishes nothing, so whoever may stop the site
 * may make it, mid-deploy too.
 */
export async function editSite(principal: Actor, projectId: string, name: string, input: {
  port?: number
  adminPort?: number | null
  workflow?: string
  volume?: string | null
  repos?: RepoStart[]
  follow?: boolean
  deployTimeoutMinutes?: number
}): Promise<void> {
  if (input.follow === false && Object.entries(input).every(([k, v]) => k === 'follow' || v === undefined)) {
    await authorizeSiteEnd(principal, projectId, 'delegate')
    const { id } = await requireSite(projectId, name)
    await withSiteLock(id, () => updateSite(id, { follow: false }))
    return
  }
  await authorizeProject(principal, projectId, 'delegate')
  const found = await requireSite(projectId, name)
  await authorizeExposure(principal, found, 'change a published site')
  const { id } = found
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
    const adminPort = input.adminPort === undefined ? row.adminPort : input.adminPort ?? undefined
    checkPorts(input.port ?? row.port, adminPort)
    if (input.port !== undefined) patch.port = input.port
    if (input.adminPort !== undefined) patch.adminPort = input.adminPort
    if (input.volume !== undefined) patch.volumeId = input.volume === null ? null : await volumeId(projectId, input.volume, id)
    if (repos !== undefined) patch.repos = repos
    if (input.follow !== undefined) patch.follow = input.follow
    if (input.deployTimeoutMinutes !== undefined) patch.deployTimeoutMinutes = input.deployTimeoutMinutes
    const hasVolume = input.volume !== undefined ? input.volume !== null : row.volumeId !== undefined
    // The graph is checked against the volume and repos it will run with,
    // so dropping the volume, or a repo, that the graph needs is refused.
    patch.namedWorkflowId = await siteWorkflow(projectId, input.workflow, hasVolume, repos ?? row.repos, row)
    await updateSite(id, patch)
    // A person setting a site to follow, or changing what a following site
    // runs, approves each branch and commit it names for its new spec
    // (docs/workflows.md "Approvals").
    const edited = await getSiteRow(id)
    if (edited?.follow === true) await approveStart(principal, siteSpec(id, await siteConfig(edited)), edited.repos)
    await reofferAdminPort(row, adminPort)
  })
}

/**
 * Publish a site at `hostname`, or move a published site to another: its
 * hostname is routed on its edge from the next sync. `release`, the
 * release the person previewed, must be the one serving, so what goes live
 * is what they saw. Publishing approves that release's commits for the
 * spec it ran, so its replacement passes, and for a following site its
 * branches for that spec, where a person wrote its workflow
 * (`approveRelease`).
 */
export async function publishSite(principal: Actor, projectId: string, name: string, input: {
  hostname: string
  release?: string
}): Promise<void> {
  await authorizeSitePublish(principal, projectId)
  const { id } = await requireSite(projectId, name)
  const hostname = checkHostname(input.hostname)
  await withSiteLock(id, async () => {
    const row = await getSiteRow(id)
    if (!row) throw new ServerError('NOT_FOUND', `this project has no site named "${name}"`)
    if (input.release !== undefined && !row.liveWorkspaceId?.startsWith(input.release)) {
      throw new ServerError('CONFLICT', row.liveWorkspaceId === undefined
        ? `site "${name}" serves no release now`
        : `site "${name}" serves release ${row.liveWorkspaceId.slice(0, 8)}, not ${input.release}; preview that one first`)
    }
    await approveRelease(principal, row)
    await updateSite(id, { published: true, hostname })
  })
  await syncSiteRoutes()
}

/** Stop routing a site's hostname and let it go. Its releases keep running
 *  for its owner's forward, as before it was published. */
export async function unpublishSite(principal: Actor, projectId: string, name: string): Promise<void> {
  await authorizeSiteEnd(principal, projectId, 'owner')
  const { id } = await requireSite(projectId, name)
  await withSiteLock(id, () => updateSite(id, { published: false, hostname: null }))
  await syncSiteRoutes()
}

/** Delete a site: stop its releases and its deploy, then the row, under
 *  one lock so no deploy starts between, and the hostname stops routing. */
export async function deleteSite(principal: Actor, projectId: string, name: string): Promise<void> {
  await authorizeSiteEnd(principal, projectId, 'delegate')
  const { id, published } = await requireSite(projectId, name)
  if (published) requirePerson(principal, 'delete a published site')
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

/** The state of the install's two site tunnels, and its site domain. */
export async function getSiteEdge(): Promise<SiteEdgeStatus> {
  const driver = workspaceDriver()
  const [cloudflare, tailnet] = await Promise.all([driver.siteCloudflareStatus(), driver.siteTailnetStatus()])
  return { cloudflare, tailnet, ...(env.siteDomain !== undefined ? { siteDomain: env.siteDomain } : {}) }
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

/** Every project's sites as the snapshot carries them, read from their
 *  rows alone, so a snapshot build costs no git or user lookup. */
export async function listSiteSummaries(): Promise<SiteSummary[]> {
  const [rows, workflows] = await Promise.all([listSites(), listNamedWorkflows()])
  const projects = new Map(await Promise.all([...new Set(rows.map((r) => r.projectId))]
    .map(async (id) => [id, await getProjectRow(id)] as const)))
  const names = new Map(workflows.map((w) => [w.id, w.name]))
  return rows.map((row) => siteSummary(row, projects.get(row.projectId), names.get(row.namedWorkflowId) ?? ''))
}

function siteSummary(row: SiteRow, project: ProjectRow | undefined, workflow: string): SiteSummary {
  const commits = (map: RepoCommits): SiteCommit[] => siteCommits(project, map)
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    published: row.published,
    ...(row.hostname !== undefined ? { hostname: row.hostname, edge: siteEdgeOf(row.hostname, env.siteDomain) } : {}),
    workflow,
    follow: row.follow,
    ...(row.liveWorkspaceId !== undefined && row.releaseCommits !== undefined && row.liveSince !== undefined
      ? {
        live: {
          workspaceId: row.liveWorkspaceId,
          commits: commits(row.releaseCommits),
          since: row.liveSince.toISOString(),
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
    ...(row.requestedCommits !== undefined ? { awaitingApproval: true as const } : {}),
  }
}

/** A site's requested deploy as a person reviewing it is shown it. */
async function requestedOf(row: SiteRow, live: WorkspaceRow | undefined): Promise<Pick<SiteEntry, 'requested'>> {
  const workflow = row.requestedWorkflowId !== undefined ? await getWorkflow(row.requestedWorkflowId) : undefined
  if (row.requestedCommits === undefined || row.requestedAt === undefined || workflow === undefined) return {}
  const by = row.requestedBy
  const from = by === 'following' ? 'following' : by === 'person' ? 'person' : 'agent'
  const changes = live === undefined ? [] : [
    ...(live.workflowId !== workflow.id ? ['workflow' as const] : []),
    ...((row.livePort ?? row.port) !== row.port ? ['port' as const] : []),
    ...(live.volumeId !== row.volumeId ? ['volume' as const] : []),
  ]
  return {
    requested: {
      workflowId: workflow.id,
      steps: workflow.steps,
      secrets: workflow.secrets,
      ...(workflow.personWritten ? {} : { writtenByAgent: true as const }),
      commits: siteCommits(await getProjectRow(row.projectId), row.requestedCommits),
      at: row.requestedAt.toISOString(),
      from,
      ...(from === 'agent' && by !== undefined ? { workspaceId: by } : {}),
      changes,
    },
  }
}

async function toSiteEntry(row: SiteRow): Promise<SiteEntry> {
  const project = await getProjectRow(row.projectId)
  const volume = row.volumeId !== undefined ? await getVolumeRow(row.volumeId) : undefined
  const live = row.liveWorkspaceId !== undefined ? await findWorkspaceRow(row.liveWorkspaceId) : undefined
  const paused = row.follow ? await followPause(row) : undefined
  const target = row.follow && row.failedCommits !== undefined ? await siteTarget(row) : undefined
  const workflow = await getNamedWorkflow(row.namedWorkflowId)
  const { id: _id, projectId: _projectId, live: served, awaitingApproval: _awaiting, ...summary } = siteSummary(row, project, workflow?.name ?? '')
  return {
    ...summary,
    port: row.port,
    ...(row.adminPort !== undefined ? { adminPort: row.adminPort } : {}),
    deployTimeoutMinutes: row.deployTimeoutMinutes,
    steps: workflow?.workflow.steps ?? {},
    ...(volume !== undefined ? { volume: volume.name } : {}),
    repos: row.repos.map((r) => ({
      dir: project?.repos.find((l) => l.repo.id === r.repo)?.dir ?? r.repo,
      ...(r.branch !== undefined ? { branch: r.branch } : {}),
      ...(r.commit !== undefined ? { commit: r.commit } : {}),
    })),
    ...(paused !== undefined ? { followPaused: paused } : {}),
    ...(target !== undefined && sameCommits(target, row.failedCommits) && !sameCommits(target, row.releaseCommits)
      ? { followSkipped: siteCommits(project, target) } : {}),
    createdAt: row.createdAt.toISOString(),
    ...(served !== undefined ? { live: { ...served, running: live !== undefined && live.stoppedAt === undefined } } : {}),
    ...(await requestedOf(row, live)),
  }
}

/**
 * Hand the driver every published site's route: its hostname, the port its
 * live release serves on, and that release, which is absent while none is
 * meant to serve. An unpublished site has none, so no edge reaches it.
 */
export async function syncSiteRoutes(): Promise<void> {
  const routes: SiteRoute[] = (await listSites()).flatMap((row) => (!row.published || row.hostname === undefined ? [] : [{
    siteId: row.id,
    hostname: row.hostname,
    edge: siteEdgeOf(row.hostname, env.siteDomain),
    port: row.livePort ?? row.port,
    ...(row.liveWorkspaceId !== undefined ? { liveWorkspaceId: row.liveWorkspaceId } : {}),
  }]))
  await workspaceDriver().syncSites(routes)
}
