import { api, resolveProjectId } from '#commands/api'
import { confirmDefault } from '@yaac/shared/confirm'
import { printTable } from '#commands/table'
import { FULL_COMMIT_PATTERN, formatCommits } from '@yaac/shared/steps'
import { siteEdgeOf } from '@yaac/shared/site-edge'
import { formatDuration } from '@yaac/shared/schedule'
import { DEPLOY_TIMEOUT_FORMAT, parseDeployTimeout } from '@yaac/shared/types'
import type { RepoStart, SiteCommit, SiteEntry, SiteTailnetState } from '@yaac/shared/types'

/**
 * `yaac site …`: a project's sites (docs/public-sites.md), each served by a
 * locked workspace, its release. A site starts unpublished, reached only by
 * its owner's forward; publishing it puts it at a hostname on the internet
 * or, under the install's site domain, only on its tailnet. Cluster servers
 * only; a containerless one refuses every route with `NOT_SUPPORTED`.
 */

/**
 * What a tunnel's public hostname points at. cloudflared runs in the
 * router's namespace, so the Service's short name resolves there, and the
 * CLI need not know which namespace the install uses.
 */
const ROUTER_URL = 'http://yaac-site-router:8080'

export interface SiteOptions {
  port?: string
  /** False (`--no-admin-port`) for none. */
  adminPort?: string | false
  /** The named workflow each release runs. */
  workflow?: string
  /** A volume name; false (`--no-volume`) for none. */
  volume?: string | false
  /** An image of the project, by name; false (`--no-image`) for the
   *  project's default. */
  image?: string | false
  /** Deploy whenever a branch in its repos moves (`--follow`), or not
   *  (`--no-follow`). */
  follow?: boolean
  /** How long a deploy may take to be ready, as a duration. */
  deployTimeout?: string
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

function deployTimeoutOf(opts: SiteOptions): { deployTimeoutMinutes?: number } {
  return opts.deployTimeout !== undefined ? { deployTimeoutMinutes: deployTimeoutOption('--deploy-timeout', opts.deployTimeout) } : {}
}

function deployTimeoutOption(flag: string, text: string): number {
  const minutes = parseDeployTimeout(text)
  if (minutes === undefined) throw new Error(`${flag} takes ${DEPLOY_TIMEOUT_FORMAT} (got "${text}").`)
  return minutes
}

export async function siteCreate(
  project: string,
  name: string,
  opts: SiteOptions & { port: string; workflow: string },
): Promise<void> {
  const repos = siteRepos(opts)
  if (repos.length === 0) throw new Error('Name the repos its releases start with: --repo <dir>@<branch or commit>, repeatable.')
  await api.site.create.$post({ json: {
    project: await resolveProjectId(project),
    name,
    port: portOption('--port', opts.port),
    ...(typeof opts.adminPort === 'string' ? { adminPort: portOption('--admin-port', opts.adminPort) } : {}),
    workflow: opts.workflow,
    ...(typeof opts.volume === 'string' ? { volume: opts.volume } : {}),
    ...(typeof opts.image === 'string' ? { image: opts.image } : {}),
    repos,
    ...(opts.follow === true ? { follow: true } : {}),
    ...deployTimeoutOf(opts),
  } })
  console.log(`Created site "${name}", unpublished: only you reach its releases, with \`yaac forward\` or the webapp's Preview.`)
  console.log(`Deploy it with \`yaac site deploy ${project} ${name}\`, then publish it with \`yaac site publish ${project} ${name} --hostname <host>\`.`)
}

/**
 * Publish a site at a hostname, or move a published one: `--release` names
 * the release previewed, which must be the one serving. Prints what the
 * site's edge still needs.
 */
export async function sitePublish(project: string, name: string, opts: { hostname: string; release?: string }): Promise<void> {
  await api.site.publish.$post({ json: {
    project: await resolveProjectId(project),
    name,
    hostname: opts.hostname,
    ...(opts.release !== undefined ? { release: opts.release } : {}),
  } })
  const hostname = opts.hostname.trim().toLowerCase()
  const edge = await api.site.edge.$get()
  if (siteEdgeOf(hostname, edge.siteDomain) === 'tailnet') {
    console.log(`Published site "${name}", a tailnet site: https://${hostname} answers only users on this install's tailnet.`)
    const state = tailnetStateNote(edge.tailnet, edge.siteDomain ?? '')
    if (state) console.log(state)
    return
  }
  console.log(`Published site "${name}", a public site. In Cloudflare, add a public hostname to the install's tunnel:`)
  console.log(`  hostname  ${hostname}`)
  console.log(`  service   ${ROUTER_URL}`)
  if (edge.cloudflare === 'absent') {
    console.log('This install has no tunnel yet: run `CF_TUNNEL_TOKEN=<token> yaac cluster install`.')
  } else if (edge.cloudflare === 'disconnected') {
    console.log('The tunnel holds no connection to Cloudflare; check its token and the yaac-site-tunnel-cloudflare pods.')
  }
}

/** Stop routing a site's hostname; its releases keep running for its
 *  owner's forward. */
export async function siteUnpublish(project: string, name: string): Promise<void> {
  const projectId = await resolveProjectId(project)
  const { edge } = await api.site.show.$get({ query: { project: projectId, name } })
  await api.site.unpublish.$post({ json: { project: projectId, name } })
  console.log(`Unpublished site "${name}"; only you reach it now.${edge === 'public' ? ' Remove its public hostname from the Cloudflare tunnel too.' : ''}`)
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
    ...(opts.port !== undefined ? { port: portOption('--port', opts.port) } : {}),
    ...(opts.adminPort !== undefined
      ? { adminPort: opts.adminPort === false ? null : portOption('--admin-port', opts.adminPort) }
      : {}),
    ...(opts.workflow !== undefined ? { workflow: opts.workflow } : {}),
    ...(opts.volume !== undefined ? { volume: opts.volume === false ? null : opts.volume } : {}),
    ...(opts.image !== undefined ? { image: opts.image === false ? null : opts.image } : {}),
    ...(repos.length > 0 ? { repos } : {}),
    ...(opts.follow !== undefined ? { follow: opts.follow } : {}),
    ...deployTimeoutOf(opts),
  }
  if (Object.keys(patch).length === 0) throw new Error('Nothing to change: give an option to edit.')
  await api.site.edit.$post({ json: { project: await resolveProjectId(project), name, ...patch } })
  const later = Object.keys(patch).some((k) => k !== 'adminPort' && k !== 'follow')
  console.log(`Updated site "${name}"${later ? '; its next deploy uses the change' : ''}.`)
  if (opts.follow === true) {
    console.log('While it serves, it deploys whenever one of its branches moves: whoever can push one, '
      + 'the project\'s agents included, now publishes the site, unless the remote\'s branch protection stops them.')
  }
}

export async function siteList(project: string): Promise<void> {
  const sites = await api.site.list.$get({ query: { project: await resolveProjectId(project) } })
  if (sites.length === 0) {
    console.log(`No sites in ${project}. Create one with: yaac site create ${project} <name> --port <n> --workflow <name> --repo <dir>@<branch>`)
    return
  }
  printTable(
    [
      { header: 'NAME' }, { header: 'HOSTNAME' }, { header: 'EDGE' }, { header: 'PORT' }, { header: 'LIVE' },
      { header: 'DEPLOYING', optional: true }, { header: 'LAST DEPLOY' },
    ],
    sites.map((s) => [s.name, s.hostname ?? '(unpublished)', s.edge ?? '-', String(s.port), liveOf(s), deployOf(s), lastDeployOf(s)]),
  )
}

export async function siteShow(project: string, name: string): Promise<void> {
  const projectId = await resolveProjectId(project)
  const site = await api.site.show.$get({ query: { project: projectId, name } })
  const image = site.imageId !== undefined
    ? (await api.image.project[':projectId'].$get({ param: { projectId } })).find((i) => i.id === site.imageId)?.name ?? site.imageId
    : '- (the project\'s default)'
  console.log(site.hostname !== undefined
    ? `Site "${site.name}": https://${site.hostname} -> port ${site.port}`
    : `Site "${site.name}": unpublished, port ${site.port}`)
  console.log(`  edge         ${site.edge === undefined ? '- (only you reach it, with `yaac forward`)'
    : site.edge === 'tailnet' ? 'tailnet (only tailnet users reach it)' : 'public (the internet, once the tunnel routes it)'}`)
  console.log(`  admin port   ${site.adminPort ?? '-'}`)
  console.log(`  workflow     ${site.workflow} (${Object.keys(site.steps).join(', ')})`)
  console.log(`  volume       ${site.volume ?? '-'}`)
  console.log(`  image        ${image}`)
  console.log(`  repos        ${site.repos.map((r) => `${r.dir}@${r.branch ?? r.commit ?? '?'}`).join(' ')}`)
  console.log(`  timeout      ${formatDuration(site.deployTimeoutMinutes)} per deploy`)
  console.log(`  follow       ${site.follow ? 'yes' : 'no'}${site.followPaused !== undefined ? ` (paused: ${site.followPaused})` : ''}`)
  if (site.followSkipped !== undefined) {
    console.log(`  not retrying ${short(site.followSkipped)}, whose deploy failed; \`yaac site deploy\` retries it`)
  }
  console.log(`  live         ${liveOf(site)}${site.live !== undefined ? ` in ${site.live.workspaceId}, since ${site.live.since}` : ''}`)
  if (site.deploy !== undefined) console.log(`  deploying    ${deployOf(site)} in ${site.deploy.workspaceId}, since ${site.deploy.startedAt}`)
  if (site.lastDeploy !== undefined) console.log(`  last deploy  ${lastDeployOf(site)} (${site.lastDeploy.finishedAt})`)
  if (site.requested !== undefined) printRequested(project, name, site.requested)
  if (site.releases.length === 0) return
  printTable(
    [{ header: 'RELEASE' }, { header: 'COMMITS' }, { header: 'STARTED' }, { header: 'STOPPED' }, { header: 'REPLACED', optional: true }],
    site.releases.map((r) => [
      r.workspaceId, short(r.commits), r.createdAt, r.stoppedAt ?? '-', r.rerunOf ?? '',
    ]),
  )
}

/**
 * A site's requested deploy, as a person reviews it: who asked, the commits,
 * what it changes, the run secrets it names and its whole graph, then how
 * to approve exactly that.
 */
function printRequested(project: string, name: string, requested: NonNullable<SiteEntry['requested']>): void {
  const who = requested.from === 'agent' ? `the agent of workspace ${requested.workspaceId?.slice(0, 8) ?? '?'}`
    : requested.from === 'token' ? `token ${requested.token ?? '?'}`
    : requested.from === 'following' ? 'following' : 'a deploy of content no person approved'
  console.log(`  requested    ${short(requested.commits)}, asked by ${who}, awaiting your approval`)
  if (requested.changes.length > 0) console.log(`               changes the live release's ${requested.changes.join(', ')}`)
  console.log(`               workflow ${requested.workflowId}${requested.writtenByAgent === true ? ', written by an agent' : ''}`
    + `, run secrets ${requested.secrets.join(', ') || 'none'}:`)
  for (const line of JSON.stringify(requested.steps, null, 2).split('\n')) console.log(`                 ${line}`)
  console.log(`               Approve and deploy exactly this: yaac site deploy ${project} ${name} --approve ${requested.workflowId}`)
}

/** How often `--wait` reads the site. */
const WAIT_POLL_MS = 2_000

export async function siteDeploy(
  project: string,
  name: string,
  opts: { ref: string[]; timeout?: string; wait?: boolean; approve?: string; yes?: boolean },
): Promise<void> {
  const projectId = await resolveProjectId(project)
  let approve: { workflowId: string; commits: SiteCommit[] } | undefined
  if (opts.approve !== undefined) {
    if (opts.ref.length > 0) throw new Error('--approve deploys the requested commits; it takes no --ref.')
    // Shown again as it is now, so what is approved is what was just seen.
    const { requested } = await api.site.show.$get({ query: { project: projectId, name } })
    if (requested === undefined) throw new Error(`Site "${name}" has no deploy awaiting approval.`)
    if (requested.workflowId !== opts.approve) {
      throw new Error(`Site "${name}"'s requested deploy now runs workflow ${requested.workflowId}, not ${opts.approve}; review it again.`)
    }
    printRequested(project, name, requested)
    if (!opts.yes && !process.stdin.isTTY) {
      console.error('No terminal to confirm on; pass --yes to approve what is shown above.')
      process.exitCode = 1
      return
    }
    if (!opts.yes && !await confirmDefault('Approve and deploy exactly this?')) {
      console.log('Not approved; it keeps waiting.')
      return
    }
    approve = { workflowId: requested.workflowId, commits: requested.commits }
  }
  const bare = opts.ref.filter((r) => !r.includes('@'))
  if (bare.length > 1) throw new Error('Give one bare --ref, for a site of one repo; name each repo\'s as --ref <dir>@<ref>.')
  const refs = Object.fromEntries(opts.ref.filter((r) => r.includes('@')).map((r) => [r.slice(0, r.indexOf('@')), r.slice(r.indexOf('@') + 1)]))
  const { workspaceId, commits } = await api.site.deploy.$post({ json: {
    project: projectId,
    name,
    ...(bare.length === 1 ? { ref: bare[0] } : {}),
    ...(Object.keys(refs).length > 0 ? { refs } : {}),
    ...(opts.timeout !== undefined ? { timeoutMinutes: deployTimeoutOption('--timeout', opts.timeout) } : {}),
    ...(approve !== undefined ? { approve } : {}),
  } })
  if (workspaceId === undefined) {
    console.log(`Deploying ${short(commits)} to site "${name}" needs a person's approval; it is the site's requested deploy.`)
    console.log(`Review it with \`yaac site show ${project} ${name}\`, which says how to approve it.`)
    return
  }
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
        console.log(site.hostname !== undefined
          ? `Deployed: https://${site.hostname} serves ${short(commits)}.`
          : `Deployed ${short(commits)}; preview it with \`yaac forward ${workspaceId} ${String(site.port)}\`.`)
        return
      }
      console.log(last !== undefined
        ? `The deploy failed${last.error !== undefined ? `: ${last.error}` : ''}. See \`yaac workspace logs ${workspaceId}\`.`
        : 'The deploy ended without an outcome; see `yaac site show`.')
      process.exitCode = 1
      return
    }
    if (site.deploy?.phase !== phase) {
      phase = site.deploy?.phase
      console.log(`  ${phase}`)
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS))
  }
}

export async function siteStop(project: string, name: string): Promise<void> {
  await api.site.stop.$post({ json: { project: await resolveProjectId(project), name } })
  console.log(`Stopped site "${name}"; it serves nothing until \`yaac site start\` or a deploy.`)
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
