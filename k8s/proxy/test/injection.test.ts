import { describe, it, expect } from 'vitest'
import type http from 'node:http'
import { ProxyObjects } from 'yaac-proxy-sidecar/object-watch'
import { LABEL_WORKSPACE_ID, type ProxyRegistration } from 'yaac-proxy-sidecar/objects'
import {
  PLACEHOLDER_ACCESS_TOKEN as PH_ACCESS,
  PLACEHOLDER_API_KEY as PH_KEY,
  PLACEHOLDER_GH_TOKEN as PH_GH,
  PLACEHOLDER_OPENCODE_API_KEY as PH_OC,
  PLACEHOLDER_PI_API_KEY as PH_PI,
  PLACEHOLDER_REFRESH_TOKEN as PH_REFRESH,
  applyBodyInjections,
  applyInjections,
  bodyHasPlaceholderRefreshToken,
  buildDynamicRules,
  hostNeedsDynamicMitm,
} from 'yaac-proxy-sidecar/injection'

/**
 * The credential swaps, driven through the proxy's real object view: each
 * case loads a credentials Secret and registrations as the informers would,
 * then checks the headers a request would leave with.
 */

const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64')

async function load(
  files: Record<string, unknown>,
  registrations: Record<string, Partial<ProxyRegistration>> = {},
): Promise<ProxyObjects> {
  const objects = new ProxyObjects({ loadSshKeys: () => Promise.resolve(), log: () => {} })
  await objects.applyCredentials({
    metadata: { name: 'yaac-proxy-credentials' },
    data: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, b64(v)])),
  })
  for (const [workspaceId, reg] of Object.entries(registrations)) {
    objects.applyRegistration({
      metadata: { name: `yaac-proxy-reg-${workspaceId}`, labels: { [LABEL_WORKSPACE_ID]: workspaceId } },
      data: { 'registration.json': JSON.stringify({
        rules: [], allowedHosts: ['*'], tool: 'claude', projectId: 'demo', ...reg,
      }) },
    })
  }
  return objects
}

/** The headers a request from `workspaceId` to `host` leaves with. */
function send(
  objects: ProxyObjects,
  host: string,
  headers: http.IncomingHttpHeaders,
  workspaceId = 'ws',
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = { ...headers }
  applyInjections(out, '/v1/messages', buildDynamicRules(objects, workspaceId, host, headers))
  return out
}

const claudeOauth = (accessToken: string, expiresAt = 1) => ({
  kind: 'oauth',
  claudeAiOauth: { accessToken, refreshToken: `${accessToken}-r`, expiresAt, scopes: [] },
})

describe('buildDynamicRules', () => {
  it('swaps a claude api key or oauth token only for its own placeholder', async () => {
    const apiKey = await load({ 'claude.json': { kind: 'api-key', apiKey: 'sk-ant-real' } }, { ws: {} })
    expect(send(apiKey, 'api.anthropic.com', { 'x-api-key': PH_KEY })['x-api-key']).toBe('sk-ant-real')
    // A key the user supplied, or the wrong placeholder, travels as itself.
    expect(send(apiKey, 'api.anthropic.com', { 'x-api-key': 'sk-user' })['x-api-key']).toBe('sk-user')
    expect(send(apiKey, 'api.anthropic.com', { authorization: `Bearer ${PH_ACCESS}` }).authorization)
      .toBe(`Bearer ${PH_ACCESS}`)
    // The connectors' host takes only the claude.ai bearer, never a key.
    expect(send(apiKey, 'mcp-proxy.anthropic.com', { 'x-api-key': PH_KEY })['x-api-key']).toBe(PH_KEY)

    const oauth = await load({ 'claude.json': claudeOauth('real-access') }, { ws: {} })
    for (const host of ['api.anthropic.com', 'mcp-proxy.anthropic.com']) {
      expect(send(oauth, host, { authorization: `Bearer ${PH_ACCESS}` }).authorization).toBe('Bearer real-access')
    }
    expect(send(oauth, 'api.anthropic.com', { authorization: PH_ACCESS }).authorization).toBe(PH_ACCESS)
    expect(send(oauth, 'api.anthropic.com', { 'x-api-key': PH_KEY })['x-api-key']).toBe(PH_KEY)

    // A rotation the proxy captured is served until the pushed file catches up.
    oauth.capture({ claude: { accessToken: 'rotated', refreshToken: 'r2', expiresAt: 2, scopes: [] } })
    expect(send(oauth, 'api.anthropic.com', { authorization: `Bearer ${PH_ACCESS}` }).authorization)
      .toBe('Bearer rotated')
  })

  it('swaps a codex key or oauth token on both of its inference hosts', async () => {
    const apiKey = await load({ 'codex.json': { kind: 'api-key', apiKey: 'sk-oai' } }, { ws: {} })
    const oauth = await load({ 'codex.json': { kind: 'oauth', codexOauth: {
      accessToken: 'real-access', refreshToken: 'r', idTokenRawJwt: 'id', expiresAt: 1, lastRefresh: '2026-01-01T00:00:00Z',
    } } }, { ws: {} })
    for (const host of ['api.openai.com', 'chatgpt.com']) {
      expect(send(apiKey, host, { authorization: `Bearer ${PH_KEY}` }).authorization).toBe('Bearer sk-oai')
      expect(send(apiKey, host, { authorization: `Bearer ${PH_ACCESS}` }).authorization).toBe(`Bearer ${PH_ACCESS}`)
      expect(send(oauth, host, { authorization: `Bearer ${PH_ACCESS}` }).authorization).toBe('Bearer real-access')
      expect(send(oauth, host, { authorization: 'Bearer sk-user' }).authorization).toBe('Bearer sk-user')
    }
    // Nothing is configured, so nothing is swapped.
    const none = await load({}, { ws: {} })
    expect(send(none, 'api.openai.com', { authorization: `Bearer ${PH_KEY}` }).authorization).toBe(`Bearer ${PH_KEY}`)
  })

  it('sends a project git token only to its remote host, and to gh on api.github.com', async () => {
    const objects = await load(
      { 'git-tokens.json': [{ token: 'ghp_real', projects: ['demo'] }] },
      {
        ws: { repoUrl: 'https://github.com/acme/repo.git' },
        other: { projectId: 'elsewhere', repoUrl: 'https://github.com/acme/repo.git' },
        gitlab: { repoUrl: 'https://gitlab.com/acme/repo.git' },
      },
    )
    const basic = `Basic ${Buffer.from('x-access-token:ghp_real').toString('base64')}`
    expect(send(objects, 'github.com', {}).authorization).toBe(basic)
    // gh keeps its own scheme.
    expect(send(objects, 'api.github.com', { authorization: `token ${PH_GH}` }).authorization).toBe('token ghp_real')
    expect(send(objects, 'api.github.com', { authorization: `Bearer ${PH_GH}` }).authorization).toBe('Bearer ghp_real')
    expect(send(objects, 'api.github.com', { authorization: 'token mine' }).authorization).toBe('token mine')
    expect(send(objects, 'api.github.com', {}).authorization).toBeUndefined()
    // Another project's workspace gets nothing; a remote elsewhere gets the
    // token on its own host only, and gh gets none.
    expect(send(objects, 'github.com', {}, 'other').authorization).toBeUndefined()
    expect(send(objects, 'gitlab.com', {}, 'gitlab').authorization).toBe(basic)
    expect(send(objects, 'github.com', {}, 'gitlab').authorization).toBeUndefined()
    expect(send(objects, 'api.github.com', { authorization: `token ${PH_GH}` }, 'gitlab').authorization)
      .toBe(`token ${PH_GH}`)
  })

  it('puts an opencode or pi key wherever its own placeholder rides, on the host the server named', async () => {
    const objects = await load(
      {
        'opencode.json': { kind: 'api-key', apiKey: 'sk-or-oc', apiHost: 'openrouter.ai' },
        'pi.json': { kind: 'api-key', apiKey: 'sk-or-pi', apiHost: 'openrouter.ai' },
      },
      { oc: { tool: 'opencode' }, pi: { tool: 'pi' } },
    )
    // Both tools on one host with different keys: the placeholder picks the
    // key, whichever tool the workspace was created for.
    for (const ws of ['oc', 'pi']) {
      expect(send(objects, 'openrouter.ai', { authorization: `Bearer ${PH_OC}` }, ws).authorization).toBe('Bearer sk-or-oc')
      expect(send(objects, 'openrouter.ai', { authorization: `Bearer ${PH_PI}` }, ws).authorization).toBe('Bearer sk-or-pi')
    }
    expect(send(objects, 'openrouter.ai', { authorization: PH_OC }, 'oc').authorization).toBe(PH_OC)
    expect(send(objects, 'groq.com', { authorization: `Bearer ${PH_OC}` }, 'oc').authorization).toBe(`Bearer ${PH_OC}`)
    // x-api-key wins when the placeholder is in both.
    const both = send(objects, 'openrouter.ai', { 'x-api-key': PH_PI, authorization: `Bearer ${PH_PI}` }, 'pi')
    expect(both['x-api-key']).toBe('sk-or-pi')
    expect(both.authorization).toBe(`Bearer ${PH_PI}`)
    // A workspace launched before the per-tool placeholders sends the shared
    // one; pi's swap is applied last, so it is the key that lands.
    expect(send(objects, 'openrouter.ai', { authorization: `Bearer ${PH_KEY}` }, 'pi').authorization).toBe('Bearer sk-or-pi')
  })

  it('gives claude\'s shared placeholder claude\'s key on a host pi also uses', async () => {
    const objects = await load(
      {
        'claude.json': { kind: 'api-key', apiKey: 'sk-ant-claude' },
        'pi.json': { kind: 'api-key', apiKey: 'sk-ant-pi', apiHost: 'api.anthropic.com' },
      },
      { pi: { tool: 'pi' } },
    )
    expect(send(objects, 'api.anthropic.com', { 'x-api-key': PH_KEY }, 'pi')['x-api-key']).toBe('sk-ant-claude')
    expect(send(objects, 'api.anthropic.com', { 'x-api-key': PH_PI }, 'pi')['x-api-key']).toBe('sk-ant-pi')
  })

  it('swaps nothing for a tool with no credential configured', async () => {
    const none = await load({}, { ws: {}, oc: { tool: 'opencode' }, pi: { tool: 'pi' } })
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
  it('opens the tool hosts always, a provider host only for its tool, and never port 22', async () => {
    const objects = await load(
      {
        'opencode.json': { kind: 'api-key', apiKey: 'sk-or', apiHost: 'openrouter.ai' },
        'pi.json': { kind: 'api-key', apiKey: 'sk-groq', apiHost: 'api.groq.com' },
        'git-tokens.json': [{ token: 'ghp', projects: ['demo'] }],
      },
      { oc: { tool: 'opencode', repoUrl: 'https://github.com/acme/r' }, pi: { tool: 'pi' }, cl: {} },
    )
    for (const host of ['api.anthropic.com', 'platform.claude.com', 'api.openai.com', 'auth.openai.com', 'chatgpt.com']) {
      expect(hostNeedsDynamicMitm(objects, 'cl', host, 443)).toBe(true)
    }
    expect(hostNeedsDynamicMitm(objects, 'oc', 'openrouter.ai', 443)).toBe(true)
    expect(hostNeedsDynamicMitm(objects, 'cl', 'openrouter.ai', 443)).toBe(false)
    expect(hostNeedsDynamicMitm(objects, 'pi', 'api.groq.com', 443)).toBe(true)
    for (const ws of ['oc', 'cl']) expect(hostNeedsDynamicMitm(objects, ws, 'api.groq.com', 443)).toBe(false)
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
