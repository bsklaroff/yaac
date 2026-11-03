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
import { authorizeProject, type Actor } from '#domain/access'
import { VOLUME_NEED } from '#domain/workspaces'
import { isInfraPort } from '#lib/port-policy'
import { env } from '@yaac/shared/env'
import { ServerError } from '@yaac/shared/errors'
import { parseStepGraph, type StepGraph } from '@yaac/shared/steps'
import type { SiteDetail, SiteEdgeStatus, SiteEntry } from '@yaac/shared/types'
import { endReleases, withSiteLock } from './deploys'

const SITE_NAME = /^[a-z0-9-]{1,40}$/
const DNS_NAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/

/** How many releases `GET /site/show` lists. */
const SHOWN_RELEASES = 20

/**
 * Authorize stopping or deleting a site: its project's owner, even once the
 * project is a share its source's owner removed, so the share's hostname
 * can still be freed.
 */
export async function authorizeSiteEnd(principal: Actor, projectId: string): Promise<void> {
  const project = await getProjectRow(projectId)
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

const underSiteDomain = (hostname: string): boolean =>
  env.siteDomains.some((d) => hostname === d || hostname.endsWith(`.${d}`))

/** A hostname under one of the install's site domains, lowercased. */
function checkHostname(raw: string): string {
  const hostname = raw.trim().toLowerCase()
  if (!DNS_NAME.test(hostname)) throw new ServerError('VALIDATION', `"${raw}" is not a hostname like shop.example.com`)
  const domains = env.siteDomains
  if (domains.length === 0) {
    throw new ServerError('VALIDATION', 'this install serves no site domains; '
      + 'reinstall with `yaac cluster install --site-domain <domain>`')
  }
  if (!underSiteDomain(hostname)) {
    throw new ServerError('VALIDATION', `${hostname} is under none of this install's site domains `
      + `(${domains.join(', ')})`)
  }
  return hostname
}

function checkPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || isInfraPort(port)) {
    throw new ServerError('VALIDATION', `${String(port)} is not a port a site may serve on`)
  }
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
  steps: unknown
  volume?: string
}): Promise<void> {
  await authorizeProject(principal, projectId)
  if (!SITE_NAME.test(input.name)) {
    throw new ServerError('VALIDATION', `"${input.name}" is not a site name: use 1-40 of a-z, 0-9 and -`)
  }
  checkPort(input.port)
  await insertSite({
    projectId,
    name: input.name,
    hostname: checkHostname(input.hostname),
    port: input.port,
    steps: checkSteps(input.steps, input.volume !== undefined),
    ...(input.volume !== undefined ? { volumeId: await volumeId(projectId, input.volume) } : {}),
  })
  await syncSiteRoutes()
}

/**
 * Change a site. The hostname moves at once; the port, steps and volume
 * apply from the next deploy, so the live release keeps serving as it was
 * started. Refused while a deploy runs, which was started with the old ones.
 */
export async function editSite(principal: Actor, projectId: string, name: string, input: {
  hostname?: string
  port?: number
  steps?: unknown
  volume?: string | null
}): Promise<void> {
  await authorizeProject(principal, projectId)
  const { id } = await requireSite(projectId, name)
  await withSiteLock(id, async () => {
    const row = await getSiteRow(id)
    if (!row) throw new ServerError('NOT_FOUND', `this project has no site named "${name}"`)
    if (row.deployWorkspaceId !== undefined) {
      throw new ServerError('CONFLICT', `site "${name}" is deploying; edit it once the deploy ends`)
    }
    const patch: SitePatch = {}
    if (input.hostname !== undefined) patch.hostname = checkHostname(input.hostname)
    if (input.port !== undefined) {
      checkPort(input.port)
      patch.port = input.port
    }
    if (input.volume !== undefined) patch.volumeId = input.volume === null ? null : await volumeId(projectId, input.volume, id)
    const hasVolume = input.volume !== undefined ? input.volume !== null : row.volumeId !== undefined
    // The graph is checked against the volume it will run with, so dropping
    // the volume of a graph that needs it is refused.
    patch.steps = checkSteps(input.steps ?? row.steps, hasVolume)
    await updateSite(id, patch)
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

/** The install's site domains and whether its tunnel is connected. */
export async function getSiteEdge(): Promise<SiteEdgeStatus> {
  return { domains: env.siteDomains, tunnel: await workspaceDriver().siteTunnelStatus() }
}

async function toSiteEntry(row: SiteRow): Promise<SiteEntry> {
  const volume = row.volumeId !== undefined ? await getVolumeRow(row.volumeId) : undefined
  const live = row.liveWorkspaceId !== undefined ? await findWorkspaceRow(row.liveWorkspaceId) : undefined
  return {
    name: row.name,
    hostname: row.hostname,
    port: row.port,
    steps: row.steps,
    ...(volume !== undefined ? { volume: volume.name } : {}),
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
 * meant to serve. A site the install no longer serves is left out, so its
 * hostname answers 404: one under none of `YAAC_SITE_DOMAINS` (the domains
 * changed since it was made) or of a revoked share.
 */
export async function syncSiteRoutes(): Promise<void> {
  const revoked = new Set((await listProjectRows()).filter((p) => p.shareRevoked).map((p) => p.id))
  const served = (await listSites()).filter((row) => !revoked.has(row.projectId) && underSiteDomain(row.hostname))
  const routes: SiteRoute[] = served.map((row) => ({
    siteId: row.id,
    hostname: row.hostname,
    port: row.livePort ?? row.port,
    ...(row.liveWorkspaceId !== undefined ? { liveWorkspaceId: row.liveWorkspaceId } : {}),
  }))
  await workspaceDriver().syncSites(routes)
}
