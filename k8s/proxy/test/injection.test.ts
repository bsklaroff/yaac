import { describe, it, expect } from 'vitest'
import type http from 'node:http'
import { ProxyObjects } from 'yaac-proxy-sidecar/object-watch'
import { LABEL_WORKSPACE_ID, type ProxyRegistration } from 'yaac-proxy-sidecar/objects'
import {
  PLACEHOLDER_ACCESS_TOKEN as PH_ACCESS,
  PLACEHOLDER_API_KEY as PH_KEY,
  PLACEHOLDER_OPENCODE_API_KEY as PH_OC,
  PLACEHOLDER_PI_API_KEY as PH_PI,
  PLACEHOLDER_OMP_API_KEY as PH_OMP,
  PLACEHOLDER_REFRESH_TOKEN as PH_REFRESH,
  applyBodyInjections,
  applyInjections,
  bodyHasPlaceholderRefreshToken,
  buildDynamicRules,
  findRulesForHost,
  hostNeedsDynamicMitm,
  isHostAllowed,
} from 'yaac-proxy-sidecar/injection'
import { PLACEHOLDER_GH_TOKEN } from 'yaac-proxy-sidecar/repo-grants'

/**
 * The credential swaps, driven through the proxy's real object view: each
 * case loads a credentials Secret and registrations as the informers would,
 * then checks the headers a request would leave with.
 */

const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64')

/** `files` are owner `o`'s, `others` any further owners'; a registration
 *  names owner `o` unless it says otherwise. */
function load(
  files: Record<string, unknown>,
  registrations: Record<string, Partial<ProxyRegistration>> = {},
  others: Record<string, Record<string, unknown>> = {},
): ProxyObjects {
  const objects = new ProxyObjects({ log: () => {} })
  objects.applyCredentials({
    metadata: { name: 'yaac-proxy-credentials' },
    data: Object.fromEntries(Object.entries({ o: files, ...others }).flatMap(([owner, f]) =>
      Object.entries(f).map(([k, v]) => [`${owner}.${k}`, b64(v)]))),
  })
  for (const [workspaceId, reg] of Object.entries(registrations)) {
    objects.applyRegistration({
      metadata: { name: `yaac-proxy-reg-${workspaceId}`, labels: { [LABEL_WORKSPACE_ID]: workspaceId } },
      data: { 'registration.json': JSON.stringify({
        rules: [], allowedHosts: ['*'], projectId: 'demo', owner: 'o', ...reg,
      }) },
    })
  }
  return objects
}

/** The headers a request from `workspaceId` to `host` (at `path`) leaves
 *  with. */
function send(
  objects: ProxyObjects,
  host: string,
  headers: http.IncomingHttpHeaders,
  workspaceId = 'ws',
  path = '/v1/messages',
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = { ...headers }
  applyInjections(out, path, buildDynamicRules(objects, workspaceId, host, headers, path))
  return out
}

const REPO = '11111111-1111-4111-8111-111111111111'
const OTHER_REPO = '22222222-2222-4222-8222-222222222222'
const PH_GH = `${PLACEHOLDER_GH_TOKEN}-${REPO}`

/** One grant of project `demo` to `acme/repo` on GitHub, unless overridden. */
const grant = (over: Record<string, unknown> = {}) => ({
  projectId: 'demo', repoId: REPO, host: 'github.com', path: 'acme/repo', readOnly: false, ghToken: true, ...over,
})

const claudeOauth = (accessToken: string, expiresAt = 1) => ({
  kind: 'oauth',
  claudeAiOauth: { accessToken, refreshToken: `${accessToken}-r`, expiresAt, scopes: [] },
})

// Mirrors packages/server/test/lib/allowed-hosts.test.ts; keep the two tables equal.
const LABEL_CASES: [host: string, pattern: string, expected: boolean][] = [
  ['productionresultssa42.blob.core.windows.net', 'productionresultssa*.blob.core.windows.net', true],
  ['productionresultssa.blob.core.windows.net', 'productionresultssa*.blob.core.windows.net', true],
  ['otherstorage.blob.core.windows.net', 'productionresultssa*.blob.core.windows.net', false],
  ['productionresultssa42.evil.blob.core.windows.net', 'productionresultssa*.blob.core.windows.net', false],
  ['productionresultssa4.2.blob.core.windows.net', 'productionresultssa*.blob.core.windows.net', false],
  ['ab.example.com', 'a*b.example.com', true],
  ['axyzb.example.com', 'a*b.example.com', true],
  ['axyz.example.com', 'a*b.example.com', false],
  ['xab.example.com', '*ab.example.com', true],
  ['xa.example.com', '*ab.example.com', false],
  ['abc.example.com', 'a*b*c.example.com', true],
  ['axbyc.example.com', 'a*b*c.example.com', true],
  ['acb.example.com', 'a*b*c.example.com', false],
  ['ab.example.com', 'a*b*b.example.com', false],
  ['ProductionResultsSA42.blob.core.windows.net', 'productionresultssa*.blob.core.windows.net', false],
  ['api.example.com', '(*.example.com', false],
  ['apixyz.example.com', 'api|evil*.example.com', false],
  ['api|evilx.example.com', 'api|evil*.example.com', false],
]

describe('isHostAllowed', () => {
  it.each(LABEL_CASES)('matches %s against %s: %s', (host, pattern, expected) => {
    const objects = load({}, { ws: { allowedHosts: [pattern] } })
    expect(isHostAllowed(objects, 'ws', host)).toBe(expected)
  })

  it('answers quickly for many wildcards in one label', () => {
    const objects = load({}, { ws: { allowedHosts: ['*a*a*a*a*a*a*b.example.com'] } })
    const start = Date.now()
    expect(isHostAllowed(objects, 'ws', `${'a'.repeat(200)}.example.com`)).toBe(false)
    expect(Date.now() - start).toBeLessThan(200)
  })

  it('does not throw on a rule host holding regex metacharacters', () => {
    const objects = load({}, { ws: { rules: [{ hostPattern: '(*.example.com' } as never] } })
    expect(findRulesForHost(objects, 'ws', 'api.example.com')).toEqual([])
  })
})

describe('buildDynamicRules', () => {
  it('swaps a claude api key or oauth token only for its own placeholder', () => {
    const apiKey = load({ 'claude.json': { kind: 'api-key', apiKey: 'sk-ant-real' } }, { ws: {} })
    expect(send(apiKey, 'api.anthropic.com', { 'x-api-key': PH_KEY })['x-api-key']).toBe('sk-ant-real')
    // A key the user supplied, or the wrong placeholder, travels as itself.
    expect(send(apiKey, 'api.anthropic.com', { 'x-api-key': 'sk-user' })['x-api-key']).toBe('sk-user')
    expect(send(apiKey, 'api.anthropic.com', { authorization: `Bearer ${PH_ACCESS}` }).authorization)
      .toBe(`Bearer ${PH_ACCESS}`)
    // The connectors' host takes only the claude.ai bearer, never a key.
    expect(send(apiKey, 'mcp-proxy.anthropic.com', { 'x-api-key': PH_KEY })['x-api-key']).toBe(PH_KEY)

    const oauth = load({ 'claude.json': claudeOauth('real-access') }, { ws: {} })
    for (const host of ['api.anthropic.com', 'mcp-proxy.anthropic.com']) {
      expect(send(oauth, host, { authorization: `Bearer ${PH_ACCESS}` }).authorization).toBe('Bearer real-access')
    }
    expect(send(oauth, 'api.anthropic.com', { authorization: PH_ACCESS }).authorization).toBe(PH_ACCESS)
    expect(send(oauth, 'api.anthropic.com', { 'x-api-key': PH_KEY })['x-api-key']).toBe(PH_KEY)

    // A rotation the proxy captured is served until the pushed file catches up.
    oauth.capture('o', { claude: { accessToken: 'rotated', refreshToken: 'r2', expiresAt: 2, scopes: [] } })
    expect(send(oauth, 'api.anthropic.com', { authorization: `Bearer ${PH_ACCESS}` }).authorization)
      .toBe('Bearer rotated')
  })

  it('swaps a codex key or oauth token on both of its inference hosts', () => {
    const apiKey = load({ 'codex.json': { kind: 'api-key', apiKey: 'sk-oai' } }, { ws: {} })
    const oauth = load({ 'codex.json': { kind: 'oauth', codexOauth: {
      accessToken: 'real-access', refreshToken: 'r', idTokenRawJwt: 'id', expiresAt: 1, lastRefresh: '2026-01-01T00:00:00Z',
    } } }, { ws: {} })
    for (const host of ['api.openai.com', 'chatgpt.com']) {
      expect(send(apiKey, host, { authorization: `Bearer ${PH_KEY}` }).authorization).toBe('Bearer sk-oai')
      expect(send(apiKey, host, { authorization: `Bearer ${PH_ACCESS}` }).authorization).toBe(`Bearer ${PH_ACCESS}`)
      expect(send(oauth, host, { authorization: `Bearer ${PH_ACCESS}` }).authorization).toBe('Bearer real-access')
      expect(send(oauth, host, { authorization: 'Bearer sk-user' }).authorization).toBe('Bearer sk-user')
    }
    // Nothing is configured, so nothing is swapped.
    const none = load({}, { ws: {} })
    expect(send(none, 'api.openai.com', { authorization: `Bearer ${PH_KEY}` }).authorization).toBe(`Bearer ${PH_KEY}`)
  })

  it('sends a repo\'s git token only under that repo\'s path, to its project\'s workspaces', () => {
    const objects = load(
      { 'git-tokens.json': [
        { token: 'ghp_repo', grants: [grant()] },
        { token: 'ghp_web', grants: [grant({ repoId: OTHER_REPO, path: 'acme/web' })] },
        { token: 'glpat', grants: [grant({ projectId: 'lab', host: 'gitlab.com' })] },
      ] },
      { ws: {}, other: { projectId: 'elsewhere' }, gitlab: { projectId: 'lab' } },
    )
    const basic = (t: string): string => `Basic ${Buffer.from(`x-access-token:${t}`).toString('base64')}`
    const at = (path: string, ws = 'ws', host = 'github.com') => send(objects, host, {}, ws, path).authorization
    // Each repo's own token under its own path, with or without `.git`,
    // whatever the path's case, for git and for LFS.
    expect(at('/acme/repo.git/info/refs?service=git-upload-pack')).toBe(basic('ghp_repo'))
    expect(at('/acme/repo/info/lfs/objects/batch')).toBe(basic('ghp_repo'))
    expect(at('/Acme/Repo.git/git-upload-pack')).toBe(basic('ghp_repo'))
    expect(at('/acme/web.git/info/refs')).toBe(basic('ghp_web'))
    // Any other path on the host passes with no token: a neighbouring repo,
    // a repo whose name only starts the same, and the host's other pages.
    expect(at('/acme/other.git/info/refs')).toBeUndefined()
    expect(at('/acme/repository.git/info/refs')).toBeUndefined()
    expect(at('/')).toBeUndefined()
    // A spelling the host could resolve differently carries none either.
    expect(at('/acme/other/../repo.git/info/refs')).toBeUndefined()
    expect(at('/acme/%72epo.git/info/refs')).toBeUndefined()
    // Another project's workspace gets nothing; a grant elsewhere gets its
    // token on its own host only.
    expect(at('/acme/repo.git/info/refs', 'other')).toBeUndefined()
    expect(at('/acme/repo.git/info/refs', 'gitlab', 'gitlab.com')).toBe(basic('glpat'))
    expect(at('/acme/repo.git/info/refs', 'gitlab')).toBeUndefined()
  })

  it('swaps a GH_TOKEN placeholder for the token of the repo it names, toward the GitHub API only', () => {
    const objects = load(
      { 'git-tokens.json': [
        { token: 'ghp_repo', grants: [grant()] },
        { token: 'ghp_ro', grants: [grant({ repoId: OTHER_REPO, path: 'acme/ro', readOnly: true })] },
        { token: 'glpat', grants: [grant({ projectId: 'lab', host: 'gitlab.com' })] },
      ] },
      { ws: {}, other: { projectId: 'elsewhere' }, gitlab: { projectId: 'lab' } },
    )
    const gh = (authorization: string | undefined, ws = 'ws', host = 'api.github.com') =>
      send(objects, host, authorization === undefined ? {} : { authorization }, ws, '/repos/acme/repo/pulls').authorization
    // gh keeps its own scheme.
    expect(gh(`token ${PH_GH}`)).toBe('token ghp_repo')
    expect(gh(`Bearer ${PH_GH}`)).toBe('Bearer ghp_repo')
    expect(gh('token mine')).toBe('token mine')
    expect(gh(undefined)).toBeUndefined()
    // Not to the git host, where the token rides only under the repo's path.
    expect(gh(`token ${PH_GH}`, 'ws', 'github.com')).toBe(`token ${PH_GH}`)
    // A read-only repo's token never goes to the API, nor one of a repo the
    // project has no grant for, a bare placeholder, or a host with no API.
    const readOnly = `${PLACEHOLDER_GH_TOKEN}-${OTHER_REPO}`
    expect(gh(`token ${readOnly}`)).toBe(`token ${readOnly}`)
    expect(gh(`token ${PLACEHOLDER_GH_TOKEN}`)).toBe(`token ${PLACEHOLDER_GH_TOKEN}`)
    expect(gh(`token ${PH_GH}`, 'other')).toBe(`token ${PH_GH}`)
    expect(gh(`token ${PH_GH}`, 'gitlab')).toBe(`token ${PH_GH}`)
  })

  it('honors a grant\'s flags as they stand at each request', () => {
    const withFlags = (flags: Record<string, unknown>) =>
      load({ 'git-tokens.json': [{ token: 'ghp_repo', grants: [grant(flags)] }] }, { ws: {} })
    const gh = (flags: Record<string, unknown>) =>
      send(withFlags(flags), 'api.github.com', { authorization: `token ${PH_GH}` }).authorization
    expect(gh({})).toBe('token ghp_repo')
    expect(gh({ ghToken: false })).toBe(`token ${PH_GH}`)
    expect(gh({ readOnly: true })).toBe(`token ${PH_GH}`)
  })

  it('puts an opencode, pi or omp key wherever its own placeholder rides, on the host the server named', () => {
    const objects = load(
      {
        'opencode.json': { kind: 'api-key', apiKey: 'sk-or-oc', apiHost: 'openrouter.ai' },
        'pi.json': { kind: 'api-key', apiKey: 'sk-or-pi', apiHost: 'openrouter.ai' },
        'omp.json': { kind: 'api-key', apiKey: 'sk-or-omp', apiHost: 'openrouter.ai' },
      },
      { oc: {}, pi: {} },
    )
    // Every tool on one host with different keys: the placeholder picks the
    // key, whichever tool the workspace was created for.
    for (const ws of ['oc', 'pi']) {
      expect(send(objects, 'openrouter.ai', { authorization: `Bearer ${PH_OC}` }, ws).authorization).toBe('Bearer sk-or-oc')
      expect(send(objects, 'openrouter.ai', { authorization: `Bearer ${PH_PI}` }, ws).authorization).toBe('Bearer sk-or-pi')
      expect(send(objects, 'openrouter.ai', { authorization: `Bearer ${PH_OMP}` }, ws).authorization).toBe('Bearer sk-or-omp')
    }
    expect(send(objects, 'openrouter.ai', { authorization: PH_OC }, 'oc').authorization).toBe(PH_OC)
    expect(send(objects, 'groq.com', { authorization: `Bearer ${PH_OC}` }, 'oc').authorization).toBe(`Bearer ${PH_OC}`)
    // x-api-key wins when the placeholder is in both.
    const both = send(objects, 'openrouter.ai', { 'x-api-key': PH_PI, authorization: `Bearer ${PH_PI}` }, 'pi')
    expect(both['x-api-key']).toBe('sk-or-pi')
    expect(both.authorization).toBe(`Bearer ${PH_PI}`)
    // The shared placeholder is claude's and codex's, never opencode's or pi's.
    expect(send(objects, 'openrouter.ai', { authorization: `Bearer ${PH_KEY}` }, 'pi').authorization).toBe(`Bearer ${PH_KEY}`)
  })

  it('keeps claude\'s and pi\'s keys apart on a host both use', () => {
    const objects = load(
      {
        'claude.json': { kind: 'api-key', apiKey: 'sk-ant-claude' },
        'pi.json': { kind: 'api-key', apiKey: 'sk-ant-pi', apiHost: 'api.anthropic.com' },
      },
      { pi: {} },
    )
    expect(send(objects, 'api.anthropic.com', { 'x-api-key': PH_KEY }, 'pi')['x-api-key']).toBe('sk-ant-claude')
    expect(send(objects, 'api.anthropic.com', { 'x-api-key': PH_PI }, 'pi')['x-api-key']).toBe('sk-ant-pi')
  })

  it('swaps in only the credentials of the owner the workspace names', () => {
    const objects = load(
      {
        'claude.json': claudeOauth('alice-access'),
        'git-tokens.json': [{ token: 'ghp_alice', grants: [grant()] }],
      },
      {
        alice: {},
        bob: { owner: 'bob', projectId: 'bobs' },
        // Naming another owner's project does not reach into that owner's pool.
        intruder: { owner: 'bob', projectId: 'demo' },
        nobody: { owner: 'carol' },
      },
      { bob: {
        'claude.json': claudeOauth('bob-access'),
        'opencode.json': { kind: 'api-key', apiKey: 'sk-bob', apiHost: 'openrouter.ai' },
        'git-tokens.json': [{ token: 'ghp_bob', grants: [grant({ projectId: 'bobs' })] }],
      } },
    )
    const bearer = { authorization: `Bearer ${PH_ACCESS}` }
    expect(send(objects, 'api.anthropic.com', bearer, 'alice').authorization).toBe('Bearer alice-access')
    expect(send(objects, 'api.anthropic.com', bearer, 'bob').authorization).toBe('Bearer bob-access')
    expect(send(objects, 'api.anthropic.com', bearer, 'nobody').authorization).toBe(bearer.authorization)

    // A rotation captured for one owner never reaches the other.
    objects.capture('bob', { claude: { accessToken: 'bob-rotated', refreshToken: 'r2', expiresAt: 2, scopes: [] } })
    expect(send(objects, 'api.anthropic.com', bearer, 'bob').authorization).toBe('Bearer bob-rotated')
    expect(send(objects, 'api.anthropic.com', bearer, 'alice').authorization).toBe('Bearer alice-access')

    const basic = (t: string): string => `Basic ${Buffer.from(`x-access-token:${t}`).toString('base64')}`
    const refs = '/acme/repo.git/info/refs'
    expect(send(objects, 'github.com', {}, 'alice', refs).authorization).toBe(basic('ghp_alice'))
    expect(send(objects, 'github.com', {}, 'bob', refs).authorization).toBe(basic('ghp_bob'))
    expect(send(objects, 'github.com', {}, 'intruder', refs).authorization).toBeUndefined()
    expect(send(objects, 'api.github.com', { authorization: `token ${PH_GH}` }, 'intruder').authorization)
      .toBe(`token ${PH_GH}`)

    // A provider key opens MITM, and is swapped, for its owner's workspaces only.
    expect(hostNeedsDynamicMitm(objects, 'nobody', 'openrouter.ai', 443)).toBe(false)
    expect(hostNeedsDynamicMitm(objects, 'alice', 'openrouter.ai', 443)).toBe(false)
    expect(hostNeedsDynamicMitm(objects, 'bob', 'openrouter.ai', 443)).toBe(true)
    expect(send(objects, 'openrouter.ai', { authorization: `Bearer ${PH_OC}` }, 'alice').authorization)
      .toBe(`Bearer ${PH_OC}`)
    expect(send(objects, 'openrouter.ai', { authorization: `Bearer ${PH_OC}` }, 'bob').authorization)
      .toBe('Bearer sk-bob')
  })

  it('swaps nothing for a tool with no credential configured', () => {
    const none = load({}, { ws: {}, oc: {}, pi: {} })
    for (const ws of ['ws', 'oc', 'pi']) expect(hostNeedsDynamicMitm(none, ws, 'openrouter.ai', 443)).toBe(false)
    expect(send(none, 'api.anthropic.com', { 'x-api-key': PH_KEY })['x-api-key']).toBe(PH_KEY)
    expect(send(none, 'api.anthropic.com', { authorization: `Bearer ${PH_ACCESS}` }).authorization)
      .toBe(`Bearer ${PH_ACCESS}`)
    for (const ws of ['oc', 'pi']) {
      for (const ph of [PH_OC, PH_PI]) {
        expect(send(none, 'openrouter.ai', { authorization: `Bearer ${ph}` }, ws).authorization).toBe(`Bearer ${ph}`)
      }
    }
  })
})

describe('hostNeedsDynamicMitm', () => {
  it('opens the tool hosts always, a provider host whatever the workspace\'s tool, and never port 22', () => {
    const objects = load(
      {
        'opencode.json': { kind: 'api-key', apiKey: 'sk-or', apiHost: 'openrouter.ai' },
        'pi.json': { kind: 'api-key', apiKey: 'sk-groq', apiHost: 'api.groq.com' },
        'omp.json': { kind: 'api-key', apiKey: 'sk-ds', apiHost: 'api.deepseek.com' },
        'git-tokens.json': [{ token: 'ghp', grants: [grant()] }],
      },
      { oc: {}, pi: { projectId: 'p2' }, cl: { projectId: 'p3' } },
    )
    for (const host of ['api.anthropic.com', 'platform.claude.com', 'api.openai.com', 'auth.openai.com', 'chatgpt.com']) {
      expect(hostNeedsDynamicMitm(objects, 'cl', host, 443)).toBe(true)
    }
    // A claude workspace can run opencode or pi itself (yaac-in-yaac), and
    // carries their placeholders, so it gets their swaps too.
    for (const ws of ['oc', 'pi', 'cl']) {
      expect(hostNeedsDynamicMitm(objects, ws, 'openrouter.ai', 443)).toBe(true)
      expect(hostNeedsDynamicMitm(objects, ws, 'api.groq.com', 443)).toBe(true)
      expect(hostNeedsDynamicMitm(objects, ws, 'api.deepseek.com', 443)).toBe(true)
    }
    expect(hostNeedsDynamicMitm(objects, 'cl', 'groq.com', 443)).toBe(false)
    expect(hostNeedsDynamicMitm(objects, 'oc', 'github.com', 443)).toBe(true)
    expect(hostNeedsDynamicMitm(objects, 'oc', 'api.github.com', 443)).toBe(true)
    expect(hostNeedsDynamicMitm(objects, 'cl', 'github.com', 443)).toBe(false)
    expect(hostNeedsDynamicMitm(objects, 'oc', 'github.com', 22)).toBe(false)
  })
})

describe('applyBodyInjections', () => {
  const swaps = [{ name: 'client_id', value: 'real-id' }, { name: 'client_secret', value: 'real-secret' }]

  it('replaces only parameters the body carries, as JSON or form', () => {
    const json = JSON.parse(applyBodyInjections(
      Buffer.from(JSON.stringify({ client_id: 'ph', scope: 'repo' })), 'application/json; charset=utf-8', swaps,
    ).toString()) as Record<string, unknown>
    expect(json).toEqual({ client_id: 'real-id', scope: 'repo' })

    // No content type, or JSON that does not parse, is read as a form.
    for (const contentType of [undefined, 'application/json']) {
      const form = new URLSearchParams(applyBodyInjections(
        Buffer.from('client_id=ph&scope=repo'), contentType, swaps,
      ).toString())
      expect(Object.fromEntries(form)).toEqual({ client_id: 'real-id', scope: 'repo' })
    }
  })
})

describe('bodyHasPlaceholderRefreshToken', () => {
  // Only such a refresh is ours to spend the real token for; any other
  // grant on the endpoint travels as itself.
  it('recognizes the placeholder refresh token and nothing else', () => {
    const json = (body: unknown): Buffer => Buffer.from(JSON.stringify(body))
    expect(bodyHasPlaceholderRefreshToken(json({ refresh_token: PH_REFRESH }), 'application/json')).toBe(true)
    expect(bodyHasPlaceholderRefreshToken(Buffer.from(`refresh_token=${PH_REFRESH}`), 'application/x-www-form-urlencoded'))
      .toBe(true)
    expect(bodyHasPlaceholderRefreshToken(json({ refresh_token: 'someone-elses' }), 'application/json')).toBe(false)
    expect(bodyHasPlaceholderRefreshToken(json({ grant_type: 'authorization_code', code: 'c' }), 'application/json'))
      .toBe(false)
    expect(bodyHasPlaceholderRefreshToken(Buffer.alloc(0), 'application/json')).toBe(false)
  })
})
