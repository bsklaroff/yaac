import { api, resolveProjectId } from '#commands/api'
import { printTable } from '#commands/table'
import { durationOption } from '#commands/workspace-create'
import { FULL_COMMIT_PATTERN, formatCommits } from '@yaac/shared/steps'
import { siteEdgeOf } from '@yaac/shared/site-edge'
import type { RepoStart, SiteCommit, SiteEntry, SiteTailnetState } from '@yaac/shared/types'

/**
 * `yaac site …`: a project's sites (docs/public-sites.md), each a hostname
 * served by a locked workspace, its release, on the internet or, under the
 * install's site domain, only on its tailnet. Cluster servers only; a
 * containerless one refuses every route with `NOT_SUPPORTED`.
 */

/**
 * What a tunnel's public hostname points at. cloudflared runs in the
 * router's namespace, so the Service's short name resolves there, and the
 * CLI need not know which namespace the install uses.
 */
const ROUTER_URL = 'http://yaac-site-router:8080'

export interface SiteOptions {
  hostname?: string
  port?: string
  /** False (`--no-admin-port`) for none. */
  adminPort?: string | false
  /** The named workflow each release runs. */
  workflow?: string
  /** A volume name; false (`--no-volume`) for none. */
  volume?: string | false
  /** Deploy whenever a branch in its repos moves (`--follow`), or not
   *  (`--no-follow`). */
  follow?: boolean
  /** Each repo its releases start with, as `<dir>@<branch or commit>`. */
  repo: string[]
  /** False when `--no-repos` was given, which a site refuses. */
  repos?: boolean
}

/** The `--repo` values as a site's repos, each naming a branch or commit. */
function siteRepos(opts: SiteOptions): RepoStart[] {
  if (opts.repos === false) throw new Error('A site starts with at least one repo; name each with --repo <dir>@<branch or commit>.')
  return opts.repo.map((entry) => {
    const at = entry.indexOf('@')
    if (at <= 0 || at === entry.length - 1) {
      throw new Error(`--repo takes <dir>@<branch or full commit> (got "${entry}"): a site names what each repo deploys.`)
    }
    const ref = entry.slice(at + 1)
    return { repo: entry.slice(0, at), ...(FULL_COMMIT_PATTERN.test(ref) ? { commit: ref } : { branch: ref }) }
  })
}

export async function siteCreate(
  project: string,
  name: string,
  opts: SiteOptions & { hostname: string; port: string; workflow: string },
): Promise<void> {
  const repos = siteRepos(opts)
  if (repos.length === 0) throw new Error('Name the repos its releases start with: --repo <dir>@<branch or commit>, repeatable.')
  await api.site.create.$post({ json: {
    project: await resolveProjectId(project),
    name,
    hostname: opts.hostname,
    port: portOption('--port', opts.port),
    ...(typeof opts.adminPort === 'string' ? { adminPort: portOption('--admin-port', opts.adminPort) } : {}),
    workflow: opts.workflow,
    ...(typeof opts.volume === 'string' ? { volume: opts.volume } : {}),
    repos,
    ...(opts.follow === true ? { follow: true } : {}),
  } })
  const edge = await api.site.edge.$get()
  if (siteEdgeOf(opts.hostname, edge.siteDomain) === 'tailnet') {
    console.log(`Created site "${name}", a tailnet site: https://${opts.hostname.trim().toLowerCase()} answers only users on this install's tailnet.`)
    const state = tailnetStateNote(edge.tailnet, edge.siteDomain ?? '')
    if (state) console.log(state)
  } else {
    console.log(`Created site "${name}", a public site. In Cloudflare, add a public hostname to the install's tunnel:`)
    console.log(`  hostname  ${opts.hostname}`)
    console.log(`  service   ${ROUTER_URL}`)
    if (edge.cloudflare === 'absent') {
      console.log('This install has no tunnel yet: run `CF_TUNNEL_TOKEN=<token> yaac cluster install`.')
    } else if (edge.cloudflare === 'disconnected') {
      console.log('The tunnel holds no connection to Cloudflare; check its token and the yaac-site-tunnel-cloudflare pods.')
    }
  }
  console.log(`Then publish it with: yaac site deploy ${project} ${name}`)
}

/** What keeps the tailnet tunnel from serving, or null while it serves. */
function tailnetStateNote(state: SiteTailnetState, siteDomain: string): string | null {
  switch (state) {
    case 'ready': return null
    case 'absent': return `This install has no tailnet tunnel yet: run \`TS_SITE_AUTHKEY=<key> yaac cluster install --site-domain ${siteDomain}\`.`
    case 'joining': return 'The tailnet tunnel has not joined the tailnet; check its auth key and the yaac-site-tunnel-tailnet pod.'
    case 'no-certificate': return `The tailnet tunnel has no certificate yet: put one for *.${siteDomain} in the Secret yaac-site-tunnel-tailnet-tls.`
  }
}

export async function siteEdit(project: string, name: string, opts: SiteOptions): Promise<void> {
  const repos = siteRepos(opts)
  const patch = {
    ...(opts.hostname !== undefined ? { hostname: opts.hostname } : {}),
    ...(opts.port !== undefined ? { port: portOption('--port', opts.port) } : {}),
    ...(opts.adminPort !== undefined
      ? { adminPort: opts.adminPort === false ? null : portOption('--admin-port', opts.adminPort) }
      : {}),
    ...(opts.workflow !== undefined ? { workflow: opts.workflow } : {}),
    ...(opts.volume !== undefined ? { volume: opts.volume === false ? null : opts.volume } : {}),
    ...(repos.length > 0 ? { repos } : {}),
    ...(opts.follow !== undefined ? { follow: opts.follow } : {}),
  }
  if (Object.keys(patch).length === 0) throw new Error('Nothing to change: give an option to edit.')
  await api.site.edit.$post({ json: { project: await resolveProjectId(project), name, ...patch } })
  const later = Object.keys(patch).some((k) => k !== 'hostname' && k !== 'adminPort' && k !== 'follow')
  console.log(`Updated site "${name}"`
    + (opts.hostname !== undefined ? `; it answers at ${opts.hostname} now` : '')
    + (later ? `${opts.hostname !== undefined ? ', and' : ';'} its next deploy uses the rest` : '') + '.')
  if (opts.follow === true) {
    console.log('While it serves, it deploys whenever one of its branches moves: whoever can push one, '
      + 'the project\'s agents included, now publishes the site, unless the remote\'s branch protection stops them.')
  }
}

export async function siteList(project: string): Promise<void> {
  const sites = await api.site.list.$get({ query: { project: await resolveProjectId(project) } })
  if (sites.length === 0) {
    console.log(`No sites in ${project}. Create one with: yaac site create ${project} <name> --hostname <host> --port <n> --workflow <name>`)
    return
  }
  printTable(
    [
      { header: 'NAME' }, { header: 'HOSTNAME' }, { header: 'EDGE' }, { header: 'PORT' }, { header: 'LIVE' },
      { header: 'DEPLOYING', optional: true }, { header: 'LAST DEPLOY' },
    ],
    sites.map((s) => [s.name, s.hostname, s.edge, String(s.port), liveOf(s), deployOf(s), lastDeployOf(s)]),
  )
}

export async function siteShow(project: string, name: string): Promise<void> {
  const site = await api.site.show.$get({ query: { project: await resolveProjectId(project), name } })
  console.log(`Site "${site.name}": https://${site.hostname} -> port ${site.port}`)
  console.log(`  edge         ${site.edge === 'tailnet' ? 'tailnet (only tailnet users reach it)' : 'public (the internet, once the tunnel routes it)'}`)
  console.log(`  admin port   ${site.adminPort ?? '-'}`)
  console.log(`  workflow     ${site.workflow} (${Object.keys(site.steps).join(', ')})`)
  console.log(`  volume       ${site.volume ?? '-'}`)
  console.log(`  repos        ${site.repos.map((r) => `${r.dir}@${r.branch ?? r.commit ?? '?'}`).join(' ')}`)
  console.log(`  follow       ${site.follow ? 'yes' : 'no'}${site.followPaused !== undefined ? ` (paused: ${site.followPaused})` : ''}`)
  if (site.followSkipped !== undefined) {
    console.log(`  not retrying ${short(site.followSkipped)}, whose deploy failed; \`yaac site deploy\` retries it`)
  }
  console.log(`  live         ${liveOf(site)}${site.live !== undefined ? ` in ${site.live.workspaceId}, since ${site.live.since}` : ''}`)
  if (site.deploy !== undefined) console.log(`  deploying    ${deployOf(site)} in ${site.deploy.workspaceId}, since ${site.deploy.startedAt}`)
  if (site.lastDeploy !== undefined) console.log(`  last deploy  ${lastDeployOf(site)} (${site.lastDeploy.finishedAt})`)
  if (site.releases.length === 0) return
  printTable(
    [{ header: 'RELEASE' }, { header: 'COMMITS' }, { header: 'STARTED' }, { header: 'STOPPED' }, { header: 'REPLACED', optional: true }],
    site.releases.map((r) => [
      r.workspaceId, short(r.commits), r.createdAt, r.stoppedAt ?? '-', r.rerunOf ?? '',
    ]),
  )
}

/** How often `--wait` reads the site. */
const WAIT_POLL_MS = 2_000

export async function siteDeploy(
  project: string,
  name: string,
  opts: { ref: string[]; timeout?: string; wait?: boolean },
): Promise<void> {
  const projectId = await resolveProjectId(project)
  const bare = opts.ref.filter((r) => !r.includes('@'))
  if (bare.length > 1) throw new Error('Give one bare --ref, for a site of one repo; name each repo\'s as --ref <dir>@<ref>.')
  const refs = Object.fromEntries(opts.ref.filter((r) => r.includes('@')).map((r) => [r.slice(0, r.indexOf('@')), r.slice(r.indexOf('@') + 1)]))
  const { workspaceId, commits } = await api.site.deploy.$post({ json: {
    project: projectId,
    name,
    ...(bare.length === 1 ? { ref: bare[0] } : {}),
    ...(Object.keys(refs).length > 0 ? { refs } : {}),
    ...(opts.timeout !== undefined ? { timeoutMinutes: durationOption('--timeout', opts.timeout) } : {}),
  } })
  console.log(`Deploying ${short(commits)} to site "${name}" in release ${workspaceId}.`)
  if (!opts.wait) {
    console.log(`Follow it with \`yaac site show ${project} ${name}\`, and its steps with \`yaac workspace logs ${workspaceId}\`.`)
    return
  }
  let phase: string | undefined
  for (;;) {
    const site = await api.site.show.$get({ query: { project: projectId, name } })
    if (site.deploy?.workspaceId !== workspaceId) {
      const last = site.lastDeploy?.workspaceId === workspaceId ? site.lastDeploy : undefined
      if (last?.outcome === 'succeeded') {
        console.log(`Deployed: https://${site.hostname} serves ${short(commits)}.`)
        return
      }
      console.log(last !== undefined
        ? `The deploy failed${last.error !== undefined ? `: ${last.error}` : ''}. See \`yaac workspace logs ${workspaceId}\`.`
        : 'The deploy ended without an outcome; see `yaac site show`.')
      process.exitCode = 1
      return
    }
    if (site.deploy.phase !== phase) {
      phase = site.deploy.phase
      console.log(`  ${phase}`)
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS))
  }
}

export async function siteStop(project: string, name: string): Promise<void> {
  await api.site.stop.$post({ json: { project: await resolveProjectId(project), name } })
  console.log(`Stopped site "${name}"; its hostname answers 503 until \`yaac site start\` or a deploy.`)
}

export async function siteStart(project: string, name: string): Promise<void> {
  const { workspaceId, commits } = await api.site.start.$post({ json: { project: await resolveProjectId(project), name } })
  console.log(`Starting site "${name}" at ${short(commits)} in release ${workspaceId}.`)
}

export async function siteDelete(project: string, name: string): Promise<void> {
  const projectId = await resolveProjectId(project)
  const { edge } = await api.site.show.$get({ query: { project: projectId, name } })
  await api.site.delete.$post({ json: { project: projectId, name } })
  console.log(`Deleted site "${name}".${edge === 'public' ? ' Remove its public hostname from the Cloudflare tunnel too.' : ''}`)
}

/** A port option's value, refusing anything but a TCP port number. */
function portOption(flag: string, text: string): number {
  const port = Number(text)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${flag} takes a port number, 1-65535 (got "${text}").`)
  return port
}

/** Commits per repo, `<dir>@<short>` each, bare for a lone repo at the
 *  root. */
function short(commits: SiteCommit[]): string {
  return commits.length > 0 ? formatCommits(commits, 8) : '-'
}

function liveOf(site: SiteEntry): string {
  if (site.live === undefined) return '-'
  return `${short(site.live.commits)} ${site.live.running ? 'running' : 'replacing'}`
}

function deployOf(site: SiteEntry): string {
  if (site.deploy === undefined) return ''
  return `${short(site.deploy.commits)} ${site.deploy.phase}${site.deploy.replacing ? ' (replacement)' : ''}`
}

function lastDeployOf(site: SiteEntry): string {
  const last = site.lastDeploy
  if (last === undefined) return '-'
  return `${last.outcome} at ${short(last.commits)}${last.error !== undefined ? `: ${last.error}` : ''}`
}
