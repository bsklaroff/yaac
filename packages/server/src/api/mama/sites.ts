/**
 * The `yaac-mama site …` commands (docs/public-sites.md), on the site
 * routes: what a workspace's agent may do with its project's sites. It
 * builds, deploys, starts, stops and deletes unpublished ones as its
 * project's owner would; the routes refuse it publishing, and stopping or
 * deleting a published site, and keep its unapproved deploy of a published
 * site as the site's requested deploy for a person to make.
 */
import { ServerError } from '@yaac/shared/errors'
import { FULL_COMMIT_PATTERN, formatCommits } from '@yaac/shared/steps'
import { formatDuration } from '@yaac/shared/schedule'
import { DEPLOY_TIMEOUT_FORMAT, parseDeployTimeout, type RepoStart, type SiteCommit, type SiteEntry } from '@yaac/shared/types'
import type { MamaCaller, MamaOutcome, MamaRequestInput } from './commands'

/** A JSON list of strings an option carried, as the script sends one. */
function list(raw: string | undefined, flag: string): string[] | undefined {
  if (raw === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ServerError('VALIDATION', `${flag} is not a JSON list`)
  }
  if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === 'string')) throw new ServerError('VALIDATION', `${flag} is not a list`)
  return parsed
}

/** `--repo <dir>@<branch or full commit>` values as a site's repos. */
function repos(raw: string | undefined): RepoStart[] | undefined {
  return list(raw, '--repo')?.map((entry) => {
    const at = entry.indexOf('@')
    if (at <= 0 || at === entry.length - 1) {
      throw new ServerError('VALIDATION', `--repo takes <dir>@<branch or full commit> (got "${entry}")`)
    }
    const ref = entry.slice(at + 1)
    return { repo: entry.slice(0, at), ...(FULL_COMMIT_PATTERN.test(ref) ? { commit: ref } : { branch: ref }) }
  })
}

function port(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new ServerError('VALIDATION', `${flag} takes a port number, 1-65535`)
  return n
}

/** A `--deploy-timeout` duration in minutes. */
function deployTimeout(raw: string | undefined): { deployTimeoutMinutes?: number } {
  if (raw === undefined) return {}
  const minutes = parseDeployTimeout(raw)
  if (minutes === undefined) throw new ServerError('VALIDATION', `--deploy-timeout takes ${DEPLOY_TIMEOUT_FORMAT} (got "${raw}")`)
  return { deployTimeoutMinutes: minutes }
}

const short = (commits: SiteCommit[]): string => (commits.length > 0 ? formatCommits(commits, 8) : '-')

/** One line per site: where it is published, what it serves, and what
 *  waits for a person. */
function line(s: SiteEntry): string {
  return [
    s.name.padEnd(16),
    s.hostname !== undefined ? `published at https://${s.hostname}` : 'unpublished',
    `port ${String(s.port)}`,
    `live ${s.live !== undefined ? `${short(s.live.commits)} in ${s.live.workspaceId.slice(0, 8)}` : '-'}`,
    ...(s.deploy !== undefined ? [`deploying ${short(s.deploy.commits)} (${s.deploy.phase}) in ${s.deploy.workspaceId.slice(0, 8)}`] : []),
    ...(s.requested !== undefined ? [`requested ${short(s.requested.commits)}, awaiting a person's approval`] : []),
  ].join('  ')
}

/** Answer one `site-*` command for the caller's project. */
export async function runSiteCommand(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const { args } = request
  if (request.body.trim() !== '') return { ok: false, error: `${request.command} takes no prompt` }
  if (request.command === 'site-list') {
    const sites = await caller.api.site.list.$get({ query: { project: caller.projectId } })
    return { ok: true, output: sites.length === 0 ? 'This project has no sites.' : sites.map(line).join('\n') }
  }
  const name = args.name?.trim() ?? ''
  if (name === '') return { ok: false, error: `${request.command.replace('-', ' ')} needs a site name` }
  for (const [on, off] of [['admin-port', 'no-admin-port'], ['volume', 'no-volume'], ['follow', 'no-follow']] as const) {
    if (args[on] !== undefined && args[off] !== undefined) return { ok: false, error: `give --${on} or --${off}, not both` }
  }
  const { api, projectId } = caller
  const site = { project: projectId, name }
  switch (request.command) {
    case 'site-show': {
      const shown = await api.site.show.$get({ query: site })
      return { ok: true, output: [
        line(shown),
        `workflow ${shown.workflow}; repos ${shown.repos.map((r) => `${r.dir}@${r.branch ?? r.commit ?? '?'}`).join(' ')}`
          + `${shown.volume !== undefined ? `; volume ${shown.volume}` : ''}${shown.adminPort !== undefined ? `; admin port ${String(shown.adminPort)}` : ''}`
          + `; deploy timeout ${formatDuration(shown.deployTimeoutMinutes)}`
          + `${shown.follow ? '; follows its branches' : ''}`,
        ...(shown.lastDeploy !== undefined
          ? [`last deploy ${shown.lastDeploy.outcome} at ${short(shown.lastDeploy.commits)}${shown.lastDeploy.error !== undefined ? `: ${shown.lastDeploy.error}` : ''}`]
          : []),
        ...shown.releases.map((r) => `release ${r.workspaceId.slice(0, 8)} ${short(r.commits)} ${r.stoppedAt !== undefined ? 'stopped' : 'running'}`),
      ].join('\n') }
    }
    case 'site-create': {
      const sitePort = port(args.port, '--port')
      const siteRepos = repos(args.repos)
      if (sitePort === undefined || args.workflow === undefined || siteRepos === undefined) {
        return { ok: false, error: 'site create needs --port, --workflow and at least one --repo <dir>@<branch or commit>' }
      }
      const adminPort = port(args['admin-port'], '--admin-port')
      await api.site.create.$post({ json: {
        ...site,
        port: sitePort,
        workflow: args.workflow,
        repos: siteRepos,
        ...(adminPort !== undefined ? { adminPort } : {}),
        ...(args.volume !== undefined ? { volume: args.volume } : {}),
        ...deployTimeout(args['deploy-timeout']),
        ...(args.follow !== undefined ? { follow: true } : {}),
      } })
      return { ok: true, output: `created site ${name}, unpublished: only your user reaches it. Deploy it with \`yaac-mama site deploy ${name}\`; a person publishes it.` }
    }
    case 'site-edit': {
      const sitePort = port(args.port, '--port')
      const adminPort = args['no-admin-port'] !== undefined ? null : port(args['admin-port'], '--admin-port')
      const siteRepos = repos(args.repos)
      const patch = {
        ...(sitePort !== undefined ? { port: sitePort } : {}),
        ...(adminPort !== undefined ? { adminPort } : {}),
        ...(args.workflow !== undefined ? { workflow: args.workflow } : {}),
        ...(args['no-volume'] !== undefined ? { volume: null } : args.volume !== undefined ? { volume: args.volume } : {}),
        ...(siteRepos !== undefined ? { repos: siteRepos } : {}),
        ...deployTimeout(args['deploy-timeout']),
        ...(args.follow !== undefined ? { follow: true } : args['no-follow'] !== undefined ? { follow: false } : {}),
      }
      if (Object.keys(patch).length === 0) return { ok: false, error: 'site edit needs something to change' }
      await api.site.edit.$post({ json: { ...site, ...patch } })
      return { ok: true, output: `updated site ${name}; its next deploy uses the change` }
    }
    case 'site-deploy': {
      const given = list(args.refs, '--ref') ?? []
      const bare = given.filter((r) => !r.includes('@'))
      if (bare.length > 1) return { ok: false, error: 'give one bare --ref, for a site of one repo; name each repo\'s as --ref <dir>@<ref>' }
      const refs = Object.fromEntries(given.filter((r) => r.includes('@')).map((r) => [r.slice(0, r.indexOf('@')), r.slice(r.indexOf('@') + 1)]))
      const result = await api.site.deploy.$post({ json: {
        ...site,
        ...(bare.length === 1 ? { ref: bare[0] } : {}),
        ...(Object.keys(refs).length > 0 ? { refs } : {}),
      } })
      return { ok: true, output: result.workspaceId !== undefined
        ? `deploying ${short(result.commits)} in release ${result.workspaceId}; follow it with \`yaac-mama logs ${result.workspaceId.slice(0, 8)}\``
        : `deploying ${short(result.commits)} needs a person's approval: it is site ${name}'s requested deploy until a person deploys it` }
    }
    case 'site-start': {
      const { workspaceId, commits } = await api.site.start.$post({ json: site })
      return { ok: true, output: `starting site ${name} at ${short(commits)} in release ${workspaceId}` }
    }
    case 'site-stop':
      await api.site.stop.$post({ json: site })
      return { ok: true, output: `stopped site ${name}` }
    case 'site-delete':
      await api.site.delete.$post({ json: site })
      return { ok: true, output: `deleted site ${name}` }
    default:
      return { ok: false, error: `unknown command '${request.command}'` }
  }
}
