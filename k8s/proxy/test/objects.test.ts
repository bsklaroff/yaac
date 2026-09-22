import { describe, it, expect } from 'vitest'
import {
  LABEL_WORKTREE_ID,
  decodeCa,
  decodeCredentials,
  decodeProjectSecrets,
  decodeRefreshed,
  decodeRegistration,
  decodeState,
  encodeCa,
  encodeRefreshed,
  encodeState,
  matchPattern,
  parsePattern,
  type ClaudeOAuthBundle,
  type CodexOAuthBundle,
} from 'yaac-proxy-sidecar/objects'

/**
 * The codecs between an object's `data` and the proxy's views. A decoder
 * that goes wrong fails silently — the credential simply does not arrive —
 * so each shape is pinned here, with the same rejections the file readers
 * they replaced applied.
 */

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
const secretOf = (files: Record<string, unknown>): { data: Record<string, string> } => ({
  data: Object.fromEntries(Object.entries(files).map(([k, v]) =>
    [k, b64(typeof v === 'string' ? v : JSON.stringify(v))])),
})

const CLAUDE_BUNDLE: ClaudeOAuthBundle = {
  accessToken: 'claude-access', refreshToken: 'claude-refresh',
  expiresAt: 1_900_000_000_000, scopes: ['user:inference'], subscriptionType: 'max',
}
const CODEX_BUNDLE: CodexOAuthBundle = {
  accessToken: 'codex-access', refreshToken: 'codex-refresh', idTokenRawJwt: 'h.p.s',
  expiresAt: 1_900_000_000_000, lastRefresh: '2026-09-01T00:00:00.000Z', accountId: 'acct',
}

describe('decodeCredentials', () => {
  it('reads every file shape the host store writes', () => {
    const creds = decodeCredentials(secretOf({
      'claude.json': { kind: 'oauth', savedAt: 'x', claudeAiOauth: CLAUDE_BUNDLE },
      'codex.json': { kind: 'oauth', savedAt: 'x', codexOauth: CODEX_BUNDLE },
      'opencode.json': { kind: 'api-key', savedAt: 'x', apiKey: 'sk-or', provider: 'openrouter' },
      'pi.json': { kind: 'api-key', savedAt: 'x', apiKey: 'sk-ant', provider: 'anthropic' },
      'github.json': { tokens: [
        { kind: 'https', pattern: 'github.com/acme/*', token: 'ghp' },
        // An ssh entry in the same file is the server's business, not ours.
        { kind: 'ssh', pattern: 'github.com/acme/private' },
      ] },
      'ssh-keys.json': [{ pattern: 'github.com/*', host: 'github.com', privateKey: 'KEY', knownHostsEntry: 'github.com ssh-ed25519 AAA' }],
    }))
    expect(creds.claude).toEqual({ kind: 'oauth', bundle: CLAUDE_BUNDLE })
    expect(creds.codex).toEqual({ kind: 'oauth', bundle: CODEX_BUNDLE })
    expect(creds.opencode).toEqual({ kind: 'api-key', apiKey: 'sk-or', provider: 'openrouter' })
    expect(creds.pi).toEqual({ kind: 'api-key', apiKey: 'sk-ant', provider: 'anthropic' })
    expect(creds.git).toEqual([{ pattern: 'github.com/acme/*', token: 'ghp' }])
    expect(creds.ssh).toEqual([{ host: 'github.com', privateKey: 'KEY', knownHostsEntry: 'github.com ssh-ed25519 AAA' }])
  })

  it('reads api-key claude and codex, and an absent key as signed out', () => {
    const creds = decodeCredentials(secretOf({
      'claude.json': { kind: 'api-key', savedAt: 'x', apiKey: 'sk-ant-api' },
      'codex.json': { kind: 'api-key', savedAt: 'x', apiKey: 'sk-oai' },
    }))
    expect(creds.claude).toEqual({ kind: 'api-key', apiKey: 'sk-ant-api' })
    expect(creds.codex).toEqual({ kind: 'api-key', apiKey: 'sk-oai' })
    expect(creds.opencode).toBeNull()
    expect(creds.git).toEqual([])
    expect(creds.ssh).toEqual([])
    expect(decodeCredentials({})).toEqual({
      claude: null, codex: null, opencode: null, pi: null, git: [], ssh: [],
    })
  })

  it('rejects what the file readers rejected', () => {
    const creds = decodeCredentials(secretOf({
      // A codex bundle missing a field is not a bundle.
      'codex.json': { kind: 'oauth', codexOauth: { ...CODEX_BUNDLE, idTokenRawJwt: '' } },
      // An empty api key is no key.
      'claude.json': { kind: 'api-key', apiKey: '' },
      // An unknown (or prototype-chain) provider must not select a host.
      'opencode.json': { kind: 'api-key', apiKey: 'k', provider: 'constructor' },
      'pi.json': { kind: 'api-key', apiKey: 'k' },
      // A bare git pattern names no host; a tokenless entry injects nothing.
      'github.json': { tokens: [
        { pattern: 'acme/*', token: 'ghp' },
        { pattern: 'github.com/acme/*', token: '' },
        { pattern: 'github.com/acme/*', token: 'kept' },
      ] },
      // An ssh entry without its known_hosts line cannot be constrained.
      'ssh-keys.json': [{ host: 'h', privateKey: 'KEY', knownHostsEntry: '' }, 'junk'],
    }))
    expect(creds.codex).toBeNull()
    expect(creds.claude).toBeNull()
    expect(creds.opencode).toBeNull()
    expect(creds.pi).toBeNull()
    expect(creds.git).toEqual([{ pattern: 'github.com/acme/*', token: 'kept' }])
    expect(creds.ssh).toEqual([])
  })

  it('reads a malformed file as absent rather than throwing', () => {
    const creds = decodeCredentials({ data: { 'claude.json': b64('{not json'), 'github.json': b64('[]') } })
    expect(creds.claude).toBeNull()
    expect(creds.git).toEqual([])
  })
})

describe('decodeProjectSecrets', () => {
  it('reads the scoped refs and drops empty or non-string values', () => {
    expect(decodeProjectSecrets(secretOf({
      'values.json': { 'demo/KEY': 'v1', 'demo/EMPTY': '', 'demo/NUM': 3 },
    }))).toEqual({ 'demo/KEY': 'v1' })
    expect(decodeProjectSecrets({})).toEqual({})
  })
})

describe('decodeRegistration', () => {
  const cm = (registration: unknown, labels: Record<string, string> = { [LABEL_WORKTREE_ID]: 'w1' }) => ({
    metadata: { name: 'yaac-proxy-reg-w1', labels },
    data: { 'registration.json': JSON.stringify(registration) },
  })

  it('reads the payload and the worktree id off the label', () => {
    const decoded = decodeRegistration(cm({
      rules: [{ hostPattern: 'api.example.com', pathPattern: '/*', injections: [
        { action: 'set_header', name: 'x-api-key', secretRef: 'demo/KEY' },
      ] }],
      allowedHosts: ['api.example.com', 7],
      repoUrl: 'https://github.com/acme/repo',
      tool: 'claude',
      projectSlug: 'demo',
      upstreamRedirects: {
        'api.anthropic.com': { host: 'mock', port: 8080, tls: false },
        'bad': { host: 'mock' },
      },
    }))
    expect(decoded?.worktreeId).toBe('w1')
    expect(decoded?.registration).toEqual({
      rules: [{ hostPattern: 'api.example.com', pathPattern: '/*', injections: [
        { action: 'set_header', name: 'x-api-key', secretRef: 'demo/KEY' },
      ] }],
      allowedHosts: ['api.example.com'],
      repoUrl: 'https://github.com/acme/repo',
      tool: 'claude',
      projectSlug: 'demo',
      upstreamRedirects: { 'api.anthropic.com': { host: 'mock', port: 8080, tls: false } },
    })
  })

  it('drops a registration without a tool, a project, its lists, or its label', () => {
    const base = { rules: [], allowedHosts: [], tool: 'claude', projectSlug: 'demo' }
    expect(decodeRegistration(cm({ ...base, tool: '' }))).toBeNull()
    expect(decodeRegistration(cm({ ...base, projectSlug: undefined }))).toBeNull()
    expect(decodeRegistration(cm({ ...base, rules: 'x' }))).toBeNull()
    expect(decodeRegistration(cm({ ...base, allowedHosts: undefined }))).toBeNull()
    expect(decodeRegistration(cm(base, {}))).toBeNull()
    expect(decodeRegistration({ metadata: { labels: { [LABEL_WORKTREE_ID]: 'w1' } }, data: {} })).toBeNull()
    // An empty repoUrl reads as none (an https credential needs a remote).
    expect(decodeRegistration(cm({ ...base, repoUrl: '' }))?.registration.repoUrl).toBeUndefined()
  })
})

describe('encodeRefreshed', () => {
  it('round-trips through decodeRefreshed in the credentials-file shape', () => {
    const data = encodeRefreshed({ claude: CLAUDE_BUNDLE, codex: CODEX_BUNDLE })
    expect(Object.keys(data).sort()).toEqual(['claude.json', 'codex.json'])
    // The server's own loader reads this shape, so adopting is a plain save.
    const claudeFile = JSON.parse(Buffer.from(data['claude.json'], 'base64').toString('utf8')) as Record<string, unknown>
    expect(claudeFile.kind).toBe('oauth')
    expect(claudeFile.claudeAiOauth).toEqual(CLAUDE_BUNDLE)
    expect(decodeRefreshed({ data })).toEqual({ claude: CLAUDE_BUNDLE, codex: CODEX_BUNDLE })
  })

  it('encodes only the slot given, so a merge patch leaves the other alone', () => {
    expect(Object.keys(encodeRefreshed({ codex: CODEX_BUNDLE }))).toEqual(['codex.json'])
    expect(decodeRefreshed({})).toEqual({})
  })
})

describe('encodeCa', () => {
  it('round-trips the key and cert through decodeCa, bundle beside them', () => {
    const data = encodeCa({ keyPem: 'KEY', certPem: 'CERT', bundlePem: 'ROOTS+CERT' })
    expect(Buffer.from(data['ca-bundle.pem'], 'base64').toString('utf8')).toBe('ROOTS+CERT')
    expect(decodeCa({ data })).toEqual({ keyPem: 'KEY', certPem: 'CERT' })
    // Half a CA is no CA: never serve a cert whose key is gone.
    expect(decodeCa({ data: { 'ca.pem': data['ca.pem'] } })).toBeNull()
    expect(decodeCa({})).toBeNull()
  })
})

describe('encodeState', () => {
  it('round-trips through decodeState as plain ConfigMap text', () => {
    const state = {
      blockedHosts: { w1: ['evil.example.com'] },
      gitAuthFailures: { demo: [{ host: 'github.com', status: 401, atMs: 5 }] },
    }
    const data = encodeState(state)
    expect(JSON.parse(data['blocked-hosts.json'])).toEqual(state.blockedHosts)
    expect(decodeState({ data })).toEqual(state)
  })

  it('drops malformed entries as the file readers did', () => {
    expect(decodeState({ data: {
      'blocked-hosts.json': JSON.stringify({ w1: ['ok', 3], w2: 'x', w3: [] }),
      'git-auth-failures.json': JSON.stringify({
        demo: [{ host: 'h', status: 401, atMs: 1 }, { host: 'h2' }], other: [],
      }),
    } })).toEqual({
      blockedHosts: { w1: ['ok'] },
      gitAuthFailures: { demo: [{ host: 'h', status: 401, atMs: 1 }] },
    })
    expect(decodeState({ data: { 'blocked-hosts.json': '{oops' } })).toEqual({ blockedHosts: {}, gitAuthFailures: {} })
  })
})

describe('parsePattern', () => {
  it('parses the three shapes and rejects the rest', () => {
    expect(parsePattern('github.com/*')).toEqual({ host: 'github.com', kind: 'any', path: '' })
    expect(parsePattern('github.com/acme/repo')).toEqual({ host: 'github.com', kind: 'exact', path: 'acme/repo' })
    expect(parsePattern('github.com/acme/*')).toEqual({ host: 'github.com', kind: 'prefix', path: 'acme' })
    expect(parsePattern('acme/*')).toBeNull()
    expect(parsePattern('*.github.com/x')).toBeNull()
    expect(parsePattern('github.com/a b')).toBeNull()
  })
})

describe('matchPattern', () => {
  it('matches on host and path shape', () => {
    expect(matchPattern('github.com/*', 'github.com', 'anything/at/all')).toBe(true)
    expect(matchPattern('github.com/acme/*', 'github.com', 'acme')).toBe(true)
    expect(matchPattern('github.com/acme/*', 'github.com', 'acme/repo')).toBe(true)
    expect(matchPattern('github.com/acme/*', 'github.com', 'acmeco/repo')).toBe(false)
    expect(matchPattern('github.com/acme/repo', 'github.com', 'acme/repo')).toBe(true)
    expect(matchPattern('github.com/acme/repo', 'gitlab.com', 'acme/repo')).toBe(false)
  })
})
