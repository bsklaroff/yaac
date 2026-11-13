import { describe, it, expect } from 'vitest'
import { ProxyObjects } from 'yaac-proxy-sidecar/object-watch'
import { LABEL_WORKSPACE_ID } from 'yaac-proxy-sidecar/objects'
import {
  PLACEHOLDER_GH_TOKEN,
  canonicalRepoPath,
  ghTokenSwap,
  hasHttpsGrantOnHost,
  hasSshGrantOnHost,
  httpsGrantAt,
  isGhApiHostFor,
  lfsBatchUploads,
  readOnlyVerdict,
  sshAccessAt,
} from 'yaac-proxy-sidecar/repo-grants'

/**
 * Which credential a request may carry: grants are per (project, repo), read
 * from the credentials Secret of the workspace's owner as it stands.
 */

const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64')
const blob = (v: string): string => Buffer.from(v).toString('base64')
const REPO = '11111111-1111-4111-8111-111111111111'
const RO_REPO = '22222222-2222-4222-8222-222222222222'

const grant = (over: Record<string, unknown> = {}) => ({
  projectId: 'demo', repoId: REPO, host: 'github.com', path: 'acme/repo', readOnly: false, ghToken: true, ...over,
})
const sshGrant = (over: Record<string, unknown> = {}) => ({
  ...grant(over), knownHostsEntry: `github.com ssh-ed25519 ${blob('hk')}\ngithub.com ssh-rsa ${blob('hk-rsa')}`,
})

/** Owner `o`'s credentials, with workspaces `ws` (project `demo`) and
 *  `other` (project `elsewhere`), and `stranger` naming another owner. */
function load(files: Record<string, unknown>): ProxyObjects {
  const objects = new ProxyObjects({ log: () => {} })
  objects.applyCredentials({
    metadata: { name: 'yaac-proxy-credentials' },
    data: Object.fromEntries(Object.entries(files).map(([k, v]) => [`o.${k}`, b64(v)])),
  })
  for (const [workspaceId, reg] of Object.entries({
    ws: {}, other: { projectId: 'elsewhere' }, stranger: { owner: 'someone' },
  })) {
    objects.applyRegistration({
      metadata: { name: `yaac-proxy-reg-${workspaceId}`, labels: { [LABEL_WORKSPACE_ID]: workspaceId } },
      data: { 'registration.json': JSON.stringify({ rules: [], allowedHosts: ['*'], projectId: 'demo', owner: 'o', ...reg }) },
    })
  }
  return objects
}

const HTTPS = {
  'git-tokens.json': [
    { token: 'ghp_repo', grants: [grant(), grant({ projectId: 'elsewhere', repoId: RO_REPO, path: 'acme/elsewhere' })] },
    { token: 'ghp_ro', grants: [grant({ repoId: RO_REPO, path: 'acme/ro', readOnly: true })] },
    { token: 'glpat', grants: [grant({ host: 'gitlab.com', path: 'group/sub/repo', ghToken: false })] },
  ],
}

describe('canonicalRepoPath', () => {
  it('reads every spelling of one repo path alike, and refuses a path with dot segments', () => {
    for (const path of ['acme/repo', '/acme/repo.git', 'Acme/Repo.GIT', 'acme/repo/', '//acme/repo']) {
      expect(canonicalRepoPath(path), path).toBe('acme/repo')
    }
    for (const path of ['acme/../repo', 'acme/./repo', 'acme//repo', '', '.git']) {
      expect(canonicalRepoPath(path), path).toBeNull()
    }
  })
})

describe('httpsGrantAt', () => {
  it('finds the project\'s repo a request is under, with its token only for a plain spelling', () => {
    const objects = load(HTTPS)
    const at = (path: string, ws = 'ws', host = 'github.com') => {
      const found = httpsGrantAt(objects, ws, host, path)
      return found && [found.grant.path, found.token, found.rest, found.query]
    }
    expect(at('/acme/repo.git/info/refs?service=git-upload-pack'))
      .toEqual(['acme/repo', 'ghp_repo', '/info/refs', 'service=git-upload-pack'])
    expect(at('/acme/repo')).toEqual(['acme/repo', 'ghp_repo', '', ''])
    expect(at('/ACME/Repo.git/git-upload-pack')).toEqual(['acme/repo', 'ghp_repo', '/git-upload-pack', ''])
    expect(at('/group/sub/repo.git/info/lfs/objects/batch', 'ws', 'gitlab.com'))
      .toEqual(['group/sub/repo', 'glpat', '/info/lfs/objects/batch', ''])
    // A spelling the host may resolve to the repo is under it, tokenless.
    for (const path of [
      '/acme/%72epo.git/x', '/acme/other/../repo.git/x', '/acme//repo.git/x', '/acme/repo.git%2Fx', '/acme\\repo.git/x',
      '/acme/repo.git;v=1/x', '/acme;a/repo/x;y', '/acme/repo.git/x%3Bz', '/acme/repo/;/x/',
    ]) {
      expect(at(path), path).toEqual(['acme/repo', null, '/x', ''])
    }
    // Under no repo of the project: a neighbour, a longer name, another
    // host, another project's repo, another project's or owner's workspace.
    for (const path of ['/acme/other.git/info/refs', '/acme/repository/info/refs', '/acme', '/']) {
      expect(at(path), path).toBeNull()
    }
    expect(at('/acme/repo.git/info/refs', 'ws', 'gitlab.com')).toBeNull()
    expect(at('/acme/elsewhere.git/info/refs')).toBeNull()
    expect(at('/acme/repo.git/info/refs', 'other')).toBeNull()
    expect(at('/acme/elsewhere.git/info/refs', 'other')).toEqual(['acme/elsewhere', 'ghp_repo', '/info/refs', ''])
    expect(at('/acme/repo.git/info/refs', 'stranger')).toBeNull()
    expect(at('/acme/repo.git/info/refs', 'unregistered')).toBeNull()
  })
})

describe('hasHttpsGrantOnHost', () => {
  it('is true only for a host the workspace\'s project has an https repo on', () => {
    const objects = load(HTTPS)
    expect(hasHttpsGrantOnHost(objects, 'ws', 'github.com')).toBe(true)
    expect(hasHttpsGrantOnHost(objects, 'ws', 'gitlab.com')).toBe(true)
    expect(hasHttpsGrantOnHost(objects, 'other', 'gitlab.com')).toBe(false)
    expect(hasHttpsGrantOnHost(objects, 'ws', 'api.github.com')).toBe(false)
    expect(hasHttpsGrantOnHost(objects, 'stranger', 'github.com')).toBe(false)
  })
})

describe('readOnlyVerdict', () => {
  it('passes only the requests known to read, and inspects an LFS batch', () => {
    const cases: Array<[method: string | undefined, rest: string, query: string, verdict: string]> = [
      // Reads.
      ['GET', '/info/refs', 'service=git-upload-pack', 'pass'],
      ['GET', '/info/refs', '', 'pass'],
      ['POST', '/git-upload-pack', '', 'pass'],
      ['POST', '/Git-Upload-Pack', '', 'pass'],
      ['POST', '/info/lfs/locks/verify', '', 'pass'],
      ['GET', '/info/lfs/locks', '', 'pass'],
      ['GET', '/info/lfs/objects/abc', '', 'pass'],
      ['HEAD', '/HEAD', '', 'pass'],
      ['GET', '', '', 'pass'],
      ['POST', '/info/lfs/objects/batch', '', 'inspect'],
      ['POST', '/INFO/LFS/objects/batch', '', 'inspect'],
      // A push, however its path or service is spelled.
      ['POST', '/git-receive-pack', '', 'refuse'],
      ['POST', '/Git-Receive-Pack', '', 'refuse'],
      ['GET', '/info/refs', 'service=git-receive-pack', 'refuse'],
      ['GET', '/info/refs', 'service=GIT-RECEIVE-PACK', 'refuse'],
      ['GET', '/INFO/refs', 'Service=git-receive-pack', 'refuse'],
      ['GET', '/info/refs', 'service=git-upload-pack&service=git-receive-pack', 'refuse'],
      ['GET', '/info/refs', 'service=git-upload-archive', 'refuse'],
      // Every other request that is not a read.
      ['POST', '/info/lfs/locks', '', 'refuse'],
      ['POST', '/info/lfs/locks/42/unlock', '', 'refuse'],
      ['POST', '/info/lfs/locks/verify/more', '', 'refuse'],
      ['POST', '/issues', '', 'refuse'],
      ['POST', '', '', 'refuse'],
      ['PUT', '/info/lfs/objects/abc', '', 'refuse'],
      ['PATCH', '', '', 'refuse'],
      ['DELETE', '/info/lfs/locks/42', '', 'refuse'],
      ['OPTIONS', '/git-upload-pack', '', 'refuse'],
      [undefined, '/info/refs', '', 'refuse'],
    ]
    for (const [method, rest, query, verdict] of cases) {
      expect(readOnlyVerdict(method, rest, query), `${String(method)} ${rest}?${query}`).toBe(verdict)
    }
  })

  it('refuses a push to a read-only repo under any spelling of the request', () => {
    const objects = load(HTTPS)
    const verdict = (method: string, path: string): string | null => {
      const at = httpsGrantAt(objects, 'ws', 'github.com', path)
      return at && readOnlyVerdict(method, at.rest, at.query)
    }
    for (const path of [
      '/acme/ro.git/git-receive-pack', '/acme/ro/Git-Receive-Pack', '/acme/ro/git-receive-pack;x',
      '/acme/ro/git-receive-pack/', '/acme/ro;v=1/git-receive-pack', '/ACME/RO.GIT/GIT-RECEIVE-PACK',
      '/acme/ro/git-receive-pack%3Bx', '/acme/ro/./git-receive-pack', '/acme/ro/git-upload-pack/../git-receive-pack',
    ]) {
      expect(verdict('POST', path), path).toBe('refuse')
    }
    expect(verdict('GET', '/acme/ro/info/refs?service=GIT-RECEIVE-PACK')).toBe('refuse')
    expect(verdict('GET', '/acme/ro/info/refs;x?service=git-receive-pack')).toBe('refuse')
    // Its fetches still pass, spelled as git spells them or not.
    expect(verdict('GET', '/acme/ro.git/info/refs?service=git-upload-pack')).toBe('pass')
    expect(verdict('POST', '/acme/ro.git/git-upload-pack')).toBe('pass')
    expect(verdict('POST', '/acme/ro/git-upload-pack;x')).toBe('pass')
  })
})

describe('lfsBatchUploads', () => {
  it('lets only a well-formed download through', () => {
    const body = (v: unknown): Buffer => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v))
    expect(lfsBatchUploads(body({ operation: 'download', objects: [] }))).toBe(false)
    expect(lfsBatchUploads(body({ operation: 'upload', objects: [] }))).toBe(true)
    expect(lfsBatchUploads(body({ objects: [] }))).toBe(true)
    expect(lfsBatchUploads(body('[]'))).toBe(true)
    expect(lfsBatchUploads(body('null'))).toBe(true)
    expect(lfsBatchUploads(body('{"operation":"download"'))).toBe(true)
    expect(lfsBatchUploads(Buffer.alloc(0))).toBe(true)
  })
})

describe('ghTokenSwap', () => {
  it('names the token of the repo a placeholder stands for, toward the GitHub API only', () => {
    const objects = load(HTTPS)
    const placeholder = `${PLACEHOLDER_GH_TOKEN}-${REPO}`
    const swap = (authorization: string | undefined, ws = 'ws', host = 'api.github.com') =>
      ghTokenSwap(objects, ws, host, authorization)
    expect(swap(`token ${placeholder}`)).toEqual({ placeholder, token: 'ghp_repo' })
    expect(swap(`Bearer ${placeholder}`)).toEqual({ placeholder, token: 'ghp_repo' })
    // No placeholder, the old unnumbered one, or a repo that is read-only,
    // not the project's, or not on a host with an API: left as it came.
    expect(swap(undefined)).toBeNull()
    expect(swap('token mine')).toBeNull()
    expect(swap(`token ${PLACEHOLDER_GH_TOKEN}`)).toBeNull()
    expect(swap(`token ${PLACEHOLDER_GH_TOKEN}-${RO_REPO}`)).toBeNull()
    expect(swap(`token ${placeholder}`, 'other')).toBeNull()
    expect(swap(`token ${placeholder}`, 'stranger')).toBeNull()
    expect(swap(`token ${placeholder}`, 'ws', 'github.com')).toBeNull()
    expect(swap(`token ${placeholder}`, 'ws', 'gitlab.com')).toBeNull()
    // The other project's grant for the read-write repo id it holds works there.
    expect(swap(`token ${PLACEHOLDER_GH_TOKEN}-${RO_REPO}`, 'other')?.token).toBe('ghp_repo')
  })

  it('stops as soon as the grant says so, on every GitHub API host', () => {
    const placeholder = `token ${PLACEHOLDER_GH_TOKEN}-${REPO}`
    for (const host of ['api.github.com', 'uploads.github.com']) {
      const swap = (flags: Record<string, unknown>, at = host) =>
        ghTokenSwap(load({ 'git-tokens.json': [{ token: 't', grants: [grant(flags)] }] }), 'ws', at, placeholder)
      expect(swap({})?.token, host).toBe('t')
      expect(swap({ ghToken: false }), host).toBeNull()
      expect(swap({ readOnly: true }), host).toBeNull()
      // A grant on any other git host, GitHub Enterprise included, has no API host.
      expect(swap({ host: 'github.acme.com' }), host).toBeNull()
      expect(swap({ host: 'gitlab.com' }), host).toBeNull()
      // Matched exactly, never as a suffix or another spelling.
      for (const spelled of [host.toUpperCase(), `${host}.`, `${host}.evil.example`, `x.${host}`]) {
        expect(swap({}, spelled), spelled).toBeNull()
      }
    }
  })
})

describe('isGhApiHostFor', () => {
  it('is true for the GitHub API hosts while a GitHub grant may be GH_TOKEN', () => {
    const objects = load(HTTPS)
    const readOnly = load({ 'git-tokens.json': [{ token: 't', grants: [grant({ readOnly: true })] }] })
    const noGhToken = load({ 'git-tokens.json': [{ token: 't', grants: [grant({ ghToken: false })] }] })
    for (const host of ['api.github.com', 'uploads.github.com']) {
      expect(isGhApiHostFor(objects, 'ws', host), host).toBe(true)
      expect(isGhApiHostFor(objects, 'stranger', host), host).toBe(false)
      expect(isGhApiHostFor(readOnly, 'ws', host), host).toBe(false)
      expect(isGhApiHostFor(noGhToken, 'ws', host), host).toBe(false)
    }
    expect(isGhApiHostFor(objects, 'ws', 'github.com')).toBe(false)
  })
})

const SSH = {
  'ssh-keys.json': [
    { privateKey: 'KEY-REPO', publicKey: `ssh-ed25519 ${blob('a')}`, grants: [sshGrant()] },
    { privateKey: 'KEY-RO', publicKey: `ssh-ed25519 ${blob('b')}`, grants: [
      sshGrant({ repoId: RO_REPO, path: 'acme/ro', readOnly: true }),
      sshGrant({ projectId: 'elsewhere', repoId: RO_REPO, path: 'acme/ro' }),
    ] },
  ],
}

describe('hasSshGrantOnHost', () => {
  it('is true only for a host the workspace\'s project has an ssh repo on', () => {
    const objects = load(SSH)
    expect(hasSshGrantOnHost(objects, 'ws', 'github.com')).toBe(true)
    expect(hasSshGrantOnHost(objects, 'ws', 'gitlab.com')).toBe(false)
    expect(hasSshGrantOnHost(objects, 'stranger', 'github.com')).toBe(false)
    expect(hasSshGrantOnHost(load(HTTPS), 'ws', 'github.com')).toBe(false)
  })
})

describe('sshAccessAt', () => {
  it('gives each repo its own key and host keys, by the path git names', () => {
    const objects = load(SSH)
    const hostKeys = [{ type: 'ssh-ed25519', blob: blob('hk') }, { type: 'ssh-rsa', blob: blob('hk-rsa') }]
    for (const path of ['acme/repo.git', '/acme/repo.git', 'acme/repo', 'Acme/Repo.git']) {
      expect(sshAccessAt(objects, 'ws', 'github.com', path), path).toEqual({ privateKey: 'KEY-REPO', hostKeys, readOnly: false })
    }
    // The same repo is read-only in one project and writable in another.
    expect(sshAccessAt(objects, 'ws', 'github.com', 'acme/ro.git')).toEqual({ privateKey: 'KEY-RO', hostKeys, readOnly: true })
    expect(sshAccessAt(objects, 'other', 'github.com', 'acme/ro.git')?.readOnly).toBe(false)
    // A path that is no repo of the project on that host has no key.
    expect(sshAccessAt(objects, 'ws', 'github.com', 'acme/other.git')).toBeNull()
    expect(sshAccessAt(objects, 'ws', 'github.com', 'acme/repo/../ro.git')).toBeNull()
    expect(sshAccessAt(objects, 'ws', 'gitlab.com', 'acme/repo.git')).toBeNull()
    expect(sshAccessAt(objects, 'other', 'github.com', 'acme/repo.git')).toBeNull()
    expect(sshAccessAt(objects, 'stranger', 'github.com', 'acme/repo.git')).toBeNull()
  })
})
