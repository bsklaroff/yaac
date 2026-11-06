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
  insertSite,
  listProjectRows,
  listProjectSites,
  listSiteReleases,
  listSites,
  listVolumeSites,
  updateSite,
  type SitePatch,
  type SiteRow,
} from '#db'
import { authorizeProject, isProjectHeld, requireAdmin, type Actor } from '#domain/access'
import { remoteBranchExists, resolveRemoteRef } from '#domain/git'
import { fetchProjectOrigin } from '#domain/projects'
import { VOLUME_NEED } from '#domain/workspaces'
import { isInfraPort } from '#lib/port-policy'
import { testEnv } from '@yaac/shared/env'
import { ServerError } from '@yaac/shared/errors'
import { isBranchName } from '@yaac/shared/git'
import { repoDir } from '@yaac/shared/project-paths'
import { parseStepGraph, type StepGraph } from '@yaac/shared/steps'
import type { SiteDetail, SiteEdgeStatus, SiteEntry } from '@yaac/shared/types'
import { endReleases, followPause, withSiteLock } from './deploys'

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
 * even once they are not one, or the project is a share its source's owner
 * removed, so a site can always be taken down and its hostname freed.
 */
export async function authorizeSiteEnd(principal: Actor, projectId: string): Promise<void> {
  const project = await getProjectRow(projectId)
  const admin = await requireAdmin(principal).then(() => true, () => false)
  if (project && admin && !isProjectHeld(projectId)) return
  if (project?.shareRevoked !== true) return await authorizeProject(principal, projectId)
  if (principal.kind !== 'system' && principal.userId !== project.owner) {
    throw new ServerError('FORBIDDEN', 'only the owner of this project may do that')
  }
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
 * A branch to follow, which must be on origin now. A name that reads as a
 * ref (`origin/main`, `refs/heads/main`) would follow a branch literally so
 * named, which anyone who may push can create, and `agent/*` branches are
 * each a workspace's own; both are refused.
 */
async function checkBranch(projectId: string, branch: string): Promise<string> {
  if (!isBranchName(branch)) throw new ServerError('VALIDATION', `"${branch}" is not a branch name`)
  if (/^(?:origin|refs|agent)\//.test(branch)) {
    throw new ServerError('VALIDATION', `"${branch}" names a branch to follow by its own name on origin, like main`)
  }
  if (!testEnv.e2eSkipFetch) await fetchProjectOrigin(projectId)
  if (!await remoteBranchExists(repoDir(projectId), branch)) {
    throw new ServerError('VALIDATION', `"${branch}" is not a branch on origin`)
  }
  return branch
}

/** A release's graph: it needs a service, and may need `volume` only when
 *  the site has one. */
function checkSteps(raw: unknown, hasVolume: boolean): StepGraph {
  let graph: StepGraph
  try {
    graph = parseStepGraph(raw, new Set(hasVolume ? [VOLUME_NEED] : []))
  } catch (err) {
    throw new ServerError('VALIDATION', (err as Error).message)
  }
  if (!Object.values(graph).some((s) => s.service === true)) {
    throw new ServerError('VALIDATION', 'a site\'s steps need a service, which serves the site')
  }
  return graph
}

/** A volume of the project that no other site keeps its data in. */
async function volumeId(projectId: string, name: string, siteId?: string): Promise<string> {
  const row = await findVolumeByName(projectId, name)
  if (!row) throw new ServerError('NOT_FOUND', `this project has no volume named "${name}"; create it with \`yaac volume create\``)
  const other = (await listVolumeSites(row.id)).find((s) => s.id !== siteId)
  if (other) throw new ServerError('CONFLICT', `volume "${name}" already holds site "${other.name}"'s data`)
  return row.id
}

export async function createSite(principal: Actor, projectId: string, input: {
  name: string
  hostname: string
  port: number
  adminPort?: number
  steps: unknown
  volume?: string
  followBranch?: string
}): Promise<void> {
  await authorizeSitePublish(principal, projectId)
  if (!SITE_NAME.test(input.name)) {
    throw new ServerError('VALIDATION', `"${input.name}" is not a site name: use 1-40 of a-z, 0-9 and -`)
  }
  checkPorts(input.port, input.adminPort)
  await insertSite({
    projectId,
    name: input.name,
    hostname: checkHostname(input.hostname),
    port: input.port,
    ...(input.adminPort !== undefined ? { adminPort: input.adminPort } : {}),
    steps: checkSteps(input.steps, input.volume !== undefined),
    ...(input.volume !== undefined ? { volumeId: await volumeId(projectId, input.volume) } : {}),
    ...(input.followBranch !== undefined ? { followBranch: await checkBranch(projectId, input.followBranch) } : {}),
  })
  await syncSiteRoutes()
}

/**
 * Change a site. The hostname and admin port move at once; the port, steps
 * and volume apply from the next deploy, so the live release keeps serving
 * as it was started. A followed branch is deployed at the next reconcile
 * if its tip is not what the site serves. Refused while a deploy runs,
 * which was started with the old settings, except an edit that only stops
 * following: that publishes nothing, so whoever may stop the site may make
 * it, mid-deploy too.
 */
export async function editSite(principal: Actor, projectId: string, name: string, input: {
  hostname?: string
  port?: number
  adminPort?: number | null
  steps?: unknown
  volume?: string | null
  followBranch?: string | null
}): Promise<void> {
  if (input.followBranch === null && Object.entries(input).every(([k, v]) => k === 'followBranch' || v === undefined)) {
    await authorizeSiteEnd(principal, projectId)
    const { id } = await requireSite(projectId, name)
    await withSiteLock(id, () => updateSite(id, { followBranch: null }))
    return
  }
  await authorizeSitePublish(principal, projectId)
  const { id } = await requireSite(projectId, name)
  const follow = typeof input.followBranch === 'string' ? await checkBranch(projectId, input.followBranch) : input.followBranch
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
    if (follow !== undefined) patch.followBranch = follow
    const hasVolume = input.volume !== undefined ? input.volume !== null : row.volumeId !== undefined
    // The graph is checked against the volume it will run with, so dropping
    // the volume of a graph that needs it is refused.
    patch.steps = checkSteps(input.steps ?? row.steps, hasVolume)
    await updateSite(id, patch)
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
      ...(r.startCommit !== undefined ? { commit: r.startCommit } : {}),
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

async function toSiteEntry(row: SiteRow): Promise<SiteEntry> {
  const volume = row.volumeId !== undefined ? await getVolumeRow(row.volumeId) : undefined
  const live = row.liveWorkspaceId !== undefined ? await findWorkspaceRow(row.liveWorkspaceId) : undefined
  const paused = row.followBranch !== undefined ? await followPause(row) : undefined
  const tip = row.followBranch !== undefined && row.failedCommit !== undefined
    ? await resolveRemoteRef(repoDir(row.projectId), row.followBranch).catch(() => undefined)
    : undefined
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    port: row.port,
    ...(row.adminPort !== undefined ? { adminPort: row.adminPort } : {}),
    steps: row.steps,
    ...(volume !== undefined ? { volume: volume.name } : {}),
    ...(row.followBranch !== undefined ? { followBranch: row.followBranch } : {}),
    ...(paused !== undefined ? { followPaused: paused } : {}),
    ...(tip !== undefined && tip === row.failedCommit && tip !== row.releaseCommit ? { followSkipped: tip } : {}),
    createdAt: row.createdAt.toISOString(),
    ...(row.liveWorkspaceId !== undefined && row.releaseCommit !== undefined && row.liveSince !== undefined
      ? {
        live: {
          workspaceId: row.liveWorkspaceId,
          commit: row.releaseCommit,
          since: row.liveSince.toISOString(),
          running: live !== undefined && live.stoppedAt === undefined,
        },
      }
      : {}),
    ...(row.deployWorkspaceId !== undefined && row.deployCommit !== undefined && row.deployStartedAt !== undefined
      ? {
        deploy: {
          workspaceId: row.deployWorkspaceId,
          commit: row.deployCommit,
          startedAt: row.deployStartedAt.toISOString(),
          phase: row.deployPhase ?? 'launching',
          ...(row.deployReplacing ? { replacing: true as const } : {}),
        },
      }
      : {}),
    ...(row.lastDeployWorkspaceId !== undefined && row.lastDeployCommit !== undefined
      && row.lastDeployOutcome !== undefined && row.lastDeployFinishedAt !== undefined
      ? {
        lastDeploy: {
          workspaceId: row.lastDeployWorkspaceId,
          commit: row.lastDeployCommit,
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
 * meant to serve. A revoked share's sites are left out, so their
 * hostnames answer 404.
 */
export async function syncSiteRoutes(): Promise<void> {
  const revoked = new Set((await listProjectRows()).filter((p) => p.shareRevoked).map((p) => p.id))
  const served = (await listSites()).filter((row) => !revoked.has(row.projectId))
  const routes: SiteRoute[] = served.map((row) => ({
    siteId: row.id,
    hostname: row.hostname,
    port: row.livePort ?? row.port,
    ...(row.liveWorkspaceId !== undefined ? { liveWorkspaceId: row.liveWorkspaceId } : {}),
  }))
  await workspaceDriver().syncSites(routes)
}
