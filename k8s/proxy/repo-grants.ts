/**
 * Which git credential a workspace's request may carry, and whether it may
 * write (docs/workspace-egress.md "Git credentials"). A credential is
 * granted per (project, repo): the proxy uses it for requests to that
 * repo's path from that project's workspaces and nothing else. Pure
 * functions over the watched objects, read per request, so a changed grant
 * applies to running workspaces at once.
 */

import type { ProxyObjects } from './object-watch'
import { knownHostKeys, type RepoGrant, type SshRepoGrant } from './objects'

/** Prefix of the `GH_TOKEN` placeholder a workspace carries for one repo,
 *  `yaac-ph-gh-token-<repo id>`. Must match `ghTokenPlaceholder` in
 *  packages/shared/src/tool-auth.ts. */
export const PLACEHOLDER_GH_TOKEN = 'yaac-ph-gh-token'

const GH_PLACEHOLDER = new RegExp(`${PLACEHOLDER_GH_TOKEN}-([0-9a-f-]{36})`)

/**
 * The API host `gh` uses for a git host. Mirrors ghApiHostForGitHost in
 * packages/shared/src/credentials.ts.
 */
function ghApiHostForGitHost(host: string): string | null {
  if (host === 'github.com') return 'api.github.com'
  return null
}

/** The https grants of a workspace's project, each with its token. */
function httpsGrants(objects: ProxyObjects, workspaceId: string): Array<{ token: string; grant: RepoGrant }> {
  const projectId = objects.registration(workspaceId)?.projectId
  if (projectId === undefined) return []
  return objects.credentials(objects.ownerOf(workspaceId)).git.flatMap(({ token, grants }) =>
    grants.filter((g) => g.projectId === projectId).map((grant) => ({ token, grant })))
}

/** The ssh grants of a workspace's project, each with its private key. */
function sshGrants(objects: ProxyObjects, workspaceId: string): Array<{ privateKey: string; grant: SshRepoGrant }> {
  const projectId = objects.registration(workspaceId)?.projectId
  if (projectId === undefined) return []
  return objects.credentials(objects.ownerOf(workspaceId)).ssh.flatMap(({ privateKey, grants }) =>
    grants.filter((g) => g.projectId === projectId).map((grant) => ({ privateKey, grant })))
}

/**
 * A repo path as hosts compare them: no leading or trailing slash, no
 * `.git`, lowercased (GitHub and GitLab resolve a path whatever its case,
 * so a read-only repo must not be reachable under another spelling). Null
 * for a path with an empty or dot segment, which a host might resolve to
 * another repo than the one the path names.
 */
export function canonicalRepoPath(path: string): string | null {
  const trimmed = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').toLowerCase()
  const segments = trimmed.split('/')
  return segments.some((s) => s === '' || s === '.' || s === '..') ? null : trimmed
}

/**
 * A request's pathname as a host may resolve it: percent-encoding decoded,
 * an encoded or backward slash read as a separator, each segment's `;`
 * parameters dropped, and empty and dot segments resolved. Matching a repo
 * against this form catches every spelling of its path.
 */
function resolvedPathname(pathname: string): string {
  const out: string[] = []
  for (const raw of pathname.split('/')) {
    let segment = raw
    try {
      segment = decodeURIComponent(raw)
    } catch { /* not valid encoding: compared as it came */ }
    for (const spelled of segment.split(/[\\/]/)) {
      const part = spelled.replace(/;.*$/s, '')
      if (part === '..') out.pop()
      else if (part !== '' && part !== '.') out.push(part)
    }
  }
  return `/${out.join('/')}`
}

/** The part of `pathname` below the repo at `grantPath` (`''` for the
 *  repo's own URL, `/info/refs` and so on), or null when it is not under
 *  that repo. */
function underRepo(pathname: string, grantPath: string): string | null {
  const lower = pathname.toLowerCase()
  for (const prefix of [`/${grantPath.toLowerCase()}.git`, `/${grantPath.toLowerCase()}`]) {
    if (lower === prefix) return ''
    if (lower.startsWith(`${prefix}/`)) return pathname.slice(prefix.length)
  }
  return null
}

/** Whether a workspace's project has an https repo on `hostname`, so its
 *  requests there are read (to inject a token, or refuse a write). */
export function hasHttpsGrantOnHost(objects: ProxyObjects, workspaceId: string, hostname: string): boolean {
  return httpsGrants(objects, workspaceId).some(({ grant }) => grant.host === hostname)
}

/**
 * The https grant a request falls under: the project's repo on `hostname`
 * whose path the request resolves under, with the rest of the path below
 * the repo and its query. `token` is the repo's token when the path is
 * spelled plainly, and null for a spelling the host could resolve
 * differently than the proxy did, which therefore carries none. Null for
 * any other path on the host, which passes with no token.
 */
export function httpsGrantAt(
  objects: ProxyObjects,
  workspaceId: string,
  hostname: string,
  requestPath: string,
): { token: string | null; grant: RepoGrant; rest: string; query: string } | null {
  const [pathname, query = ''] = requestPath.split('?', 2)
  const resolved = resolvedPathname(pathname)
  for (const { token, grant } of httpsGrants(objects, workspaceId)) {
    if (grant.host !== hostname) continue
    const rest = underRepo(resolved, grant.path)
    if (rest !== null) return { token: resolved === pathname ? token : null, grant, rest, query }
  }
  return null
}

/**
 * What a read-only grant makes of an https request under its repo, given
 * the request's method and its path and query below the repo
 * (`httpsGrantAt`). Only the requests known to read pass, so no spelling of
 * a write gets through on the strength of not being recognized:
 * - `pass`: a GET or HEAD (a ref advertisement only for `git-upload-pack`),
 *   the fetch RPC, and an LFS lock `verify`;
 * - `inspect`: an LFS batch request, whose JSON body says whether it only
 *   downloads (`lfsBatchUploads`);
 * - `refuse`: everything else.
 *
 * The path is compared lowercased, since a host may route it whatever its
 * case.
 */
export function readOnlyVerdict(method: string | undefined, rest: string, query: string): 'pass' | 'refuse' | 'inspect' {
  const at = rest.toLowerCase()
  if (method === 'GET' || method === 'HEAD') {
    if (at !== '/info/refs') return 'pass'
    const services = [...new URLSearchParams(query)].filter(([name]) => name.toLowerCase() === 'service')
    return services.every(([, service]) => service === 'git-upload-pack') ? 'pass' : 'refuse'
  }
  if (method !== 'POST') return 'refuse'
  if (at === '/git-upload-pack' || at === '/info/lfs/locks/verify') return 'pass'
  return at === '/info/lfs/objects/batch' ? 'inspect' : 'refuse'
}

/** Whether an LFS batch request's body asks to upload. A body that is not
 *  the JSON object the API takes counts as an upload, so it is refused. */
export function lfsBatchUploads(body: Buffer): boolean {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'))
    return !parsed || typeof parsed !== 'object' || (parsed as Record<string, unknown>).operation !== 'download'
  } catch {
    return true
  }
}

/**
 * The token that replaces a `GH_TOKEN` placeholder in `authorization`, on a
 * request to `hostname`: the placeholder names a repo, and its token goes
 * out only toward the API host of that repo's git host, when the workspace's
 * project holds a grant for it with `ghToken` and not `readOnly` (through
 * the API a token writes whatever it can reach, so a read-only repo's never
 * goes there). Null leaves the request as it came.
 */
export function ghTokenSwap(
  objects: ProxyObjects,
  workspaceId: string,
  hostname: string,
  authorization: string | undefined,
): { placeholder: string; token: string } | null {
  const match = authorization === undefined ? null : GH_PLACEHOLDER.exec(authorization)
  if (!match) return null
  const found = httpsGrants(objects, workspaceId).find(({ grant }) =>
    grant.repoId === match[1] && grant.ghToken && !grant.readOnly
    && ghApiHostForGitHost(grant.host) === hostname)
  return found ? { placeholder: match[0], token: found.token } : null
}

/** Whether `hostname` is the API host of a git host the workspace's project
 *  may use a repo's token on as `GH_TOKEN`. */
export function isGhApiHostFor(objects: ProxyObjects, workspaceId: string, hostname: string): boolean {
  return httpsGrants(objects, workspaceId).some(({ grant }) =>
    grant.ghToken && !grant.readOnly && ghApiHostForGitHost(grant.host) === hostname)
}

/** Whether a workspace's project has an ssh repo on `hostname`, so its ssh
 *  sessions there end at the proxy (ssh-session.ts). */
export function hasSshGrantOnHost(objects: ProxyObjects, workspaceId: string, hostname: string): boolean {
  return sshGrants(objects, workspaceId).some(({ grant }) => grant.host === hostname)
}

/** What the proxy logs in upstream with for one repo. */
export interface SshRepoAccess {
  privateKey: string
  /** The host keys trusted for the repo's host. */
  hostKeys: Array<{ type: string; blob: string }>
  readOnly: boolean
}

/**
 * The key for the project's ssh repo at `repoPath` on `hostname` (a path as
 * git's command names it), or null when the project has no such repo.
 */
export function sshAccessAt(
  objects: ProxyObjects,
  workspaceId: string,
  hostname: string,
  repoPath: string,
): SshRepoAccess | null {
  const wanted = canonicalRepoPath(repoPath)
  if (wanted === null) return null
  const found = sshGrants(objects, workspaceId).find(({ grant }) =>
    grant.host === hostname && canonicalRepoPath(grant.path) === wanted)
  return found
    ? { privateKey: found.privateKey, hostKeys: knownHostKeys(found.grant.knownHostsEntry), readOnly: found.grant.readOnly }
    : null
}
