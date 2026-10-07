import { describe, it, expect } from 'vitest'
import {
  LABEL_WORKSPACE_ID,
  decodeCa,
  EMPTY_CREDENTIALS,
  decodeCredentials,
  decodeProjectSecrets,
  decodeRefreshed,
  decodeRegistration,
  decodeState,
  encodeCa,
  encodeRefreshed,
  encodeState,
  sshGrantsForProject,
  type ClaudeOAuthBundle,
  type CodexOAuthBundle,
  type ProxyCredentials,
} from 'yaac-proxy-sidecar/objects'

/**
 * The codecs between an object's `data` and the proxy's views. A broken
 * decoder fails silently (the credential never arrives), so each shape is
 * pinned here.
 */

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
const secretOf = (files: Record<string, unknown>): { data: Record<string, string> } => ({
  data: Object.fromEntries(Object.entries(files).map(([k, v]) =>
    [k, b64(typeof v === 'string' ? v : JSON.stringify(v))])),
})
/** The credentials Secret holding `files` for one owner. */
const ownerSecret = (files: Record<string, unknown>, owner = 'o'): { data: Record<string, string> } =>
  secretOf(Object.fromEntries(Object.entries(files).map(([k, v]) => [`${owner}.${k}`, v])))
/** Owner `o`'s decoded credentials. */
const decodeOwn = (secret: { data?: Record<string, string> }): ProxyCredentials =>
  decodeCredentials(secret).get('o') ?? EMPTY_CREDENTIALS

const CLAUDE_BUNDLE: ClaudeOAuthBundle = {
  accessToken: 'claude-access', refreshToken: 'claude-refresh',
  expiresAt: 1_900_000_000_000, scopes: ['user:inference'], subscriptionType: 'max',
}
const SSH_ENTRY = {
  privateKey: 'KEY',
  publicKey: `ssh-ed25519 ${Buffer.from('key-blob').toString('base64')} yaac key`,
  projects: [{ projectId: 'acme', host: 'github.com', knownHostsEntry: 'github.com ssh-ed25519 AAA' }],
}
const CODEX_BUNDLE: CodexOAuthBundle = {
  accessToken: 'codex-access', refreshToken: 'codex-refresh', idTokenRawJwt: 'h.p.s',
  expiresAt: 1_900_000_000_000, lastRefresh: '2026-09-01T00:00:00.000Z', accountId: 'acct',
}

describe('decodeCredentials', () => {
  it('reads every file shape the host store writes', () => {
    const creds = decodeOwn(ownerSecret({
      'claude.json': { kind: 'oauth', savedAt: 'x', claudeAiOauth: CLAUDE_BUNDLE },
      'codex.json': { kind: 'oauth', savedAt: 'x', codexOauth: CODEX_BUNDLE },
      'opencode.json': { kind: 'api-key', savedAt: 'x', apiKey: 'sk-or', provider: 'openrouter', apiHost: 'openrouter.ai' },
      'pi.json': { kind: 'api-key', savedAt: 'x', apiKey: 'sk-ant', provider: 'anthropic', apiHost: 'api.anthropic.com' },
      'git-tokens.json': [{ token: 'ghp', projects: ['acme', 'other'] }],
      'ssh-keys.json': [SSH_ENTRY],
    }))
    expect(creds.claude).toEqual({ kind: 'oauth', bundle: CLAUDE_BUNDLE })
    expect(creds.codex).toEqual({ kind: 'oauth', bundle: CODEX_BUNDLE })
    expect(creds.opencode).toEqual({ kind: 'api-key', apiKey: 'sk-or', apiHost: 'openrouter.ai' })
    expect(creds.pi).toEqual({ kind: 'api-key', apiKey: 'sk-ant', apiHost: 'api.anthropic.com' })
    expect(creds.git).toEqual([{ token: 'ghp', projects: ['acme', 'other'] }])
    expect(creds.ssh).toEqual([SSH_ENTRY])
  })

  it('reads api-key claude and codex, and an absent key as signed out', () => {
    const creds = decodeOwn(ownerSecret({
      'claude.json': { kind: 'api-key', savedAt: 'x', apiKey: 'sk-ant-api' },
      'codex.json': { kind: 'api-key', savedAt: 'x', apiKey: 'sk-oai' },
    }))
    expect(creds.claude).toEqual({ kind: 'api-key', apiKey: 'sk-ant-api' })
    expect(creds.codex).toEqual({ kind: 'api-key', apiKey: 'sk-oai' })
    expect(creds.opencode).toBeNull()
    expect(creds.git).toEqual([])
    expect(creds.ssh).toEqual([])
    expect(decodeCredentials({})).toEqual(new Map())
  })

  it('rejects what the file readers rejected', () => {
    const creds = decodeOwn(ownerSecret({
      // A codex bundle missing a field is not a bundle.
      'codex.json': { kind: 'oauth', codexOauth: { ...CODEX_BUNDLE, idTokenRawJwt: '' } },
      // An empty api key is no key.
      'claude.json': { kind: 'api-key', apiKey: '' },
      // A key with no host has nowhere it may go.
      'opencode.json': { kind: 'api-key', apiKey: 'k', provider: 'openrouter' },
      'pi.json': { kind: 'api-key', apiKey: 'k', apiHost: '' },
      // A tokenless entry injects nothing, and one naming no project list
      // is not scoped at all; a non-string in the list is dropped on its own.
      'git-tokens.json': [
        { token: '', projects: ['acme'] },
        { token: 'ghp' },
        { token: 'kept', projects: ['acme', 3, ''] },
        'junk',
      ],
      'ssh-keys.json': [
        // A public line with no blob could never be offered or signed with.
        { ...SSH_ENTRY, publicKey: 'ssh-ed25519' },
        { ...SSH_ENTRY, privateKey: '' },
        { ...SSH_ENTRY, projects: 'acme' },
        // A grant without its known_hosts line cannot be constrained; the
        // key stays, with the grants that can be.
        { ...SSH_ENTRY, projects: [{ projectId: 'acme', host: 'h', knownHostsEntry: '' }, ...SSH_ENTRY.projects] },
        'junk',
      ],
    }))
    expect(creds.codex).toBeNull()
    expect(creds.claude).toBeNull()
    expect(creds.opencode).toBeNull()
    expect(creds.pi).toBeNull()
    expect(creds.git).toEqual([{ token: 'kept', projects: ['acme'] }])
    expect(creds.ssh).toEqual([SSH_ENTRY])
  })

  it('reads a malformed file as absent rather than throwing', () => {
    const creds = decodeOwn({ data: {
      'o.claude.json': b64('{not json'), 'o.git-tokens.json': b64('{"tokens":[]}'), 'o.ssh-keys.json': b64('[oops'),
    } })
    expect(creds.claude).toBeNull()
    expect(creds.git).toEqual([])
    expect(creds.ssh).toEqual([])
  })

  it('keeps each owner\'s files apart and skips keys naming no owner', () => {
    const owners = decodeCredentials({ data: {
      ...ownerSecret({ 'claude.json': { kind: 'api-key', apiKey: 'sk-a' } }, 'alice').data,
      ...ownerSecret({ 'git-tokens.json': [{ token: 'ghp-b', projects: ['p'] }] }, 'bob').data,
      // The layout from before owner keys, and an owner no key may name.
      'claude.json': b64(JSON.stringify({ kind: 'api-key', apiKey: 'sk-legacy' })),
      ...ownerSecret({ 'claude.json': { kind: 'api-key', apiKey: 'sk-bad' } }, 'b@d').data,
    } })
    expect([...owners.keys()].sort()).toEqual(['alice', 'bob'])
    expect(owners.get('alice')).toEqual({ ...EMPTY_CREDENTIALS, claude: { kind: 'api-key', apiKey: 'sk-a' } })
    expect(owners.get('bob')).toEqual({ ...EMPTY_CREDENTIALS, git: [{ token: 'ghp-b', projects: ['p'] }] })
  })
})

describe('sshGrantsForProject', () => {
  it('maps each key a project is granted to the host keys of its grants there', () => {
    const blob = (s: string): string => Buffer.from(s).toString('base64')
    const grant = (projectId: string, host: string, knownHostsEntry = `${host} ssh-ed25519 ${blob(`hk-${host}`)}`) =>
      ({ projectId, host, knownHostsEntry })
    const ssh = [
      { privateKey: 'A', publicKey: `ssh-ed25519 ${blob('key-a')} yaac a`, projects: [
        grant('one', 'github.com'),
        // Several host keys for one host, a hashed host name, and a comment.
        grant('one', 'gitlab.com', `gitlab.com ssh-ed25519 ${blob('hk-1')}\n|1|salt|hash ecdsa-sha2-nistp256 ${blob('hk-2')} c`),
        grant('two', 'example.com'),
        // A host name that looks like a key type, and marker lines.
        grant('three', 'ssh-git.example.com'),
        grant('three', 'x.example.com', `@revoked x.example.com ssh-ed25519 ${blob('hk-revoked')}\n`
          + `@cert-authority *.example.com ssh-ed25519 ${blob('hk-ca')}`),
      ] },
      { privateKey: 'B', publicKey: `ssh-ed25519 ${blob('key-b')}`, projects: [grant('two', 'example.com')] },
      // Unassigned: in no project's set.
      { privateKey: 'C', publicKey: `ssh-ed25519 ${blob('key-c')}`, projects: [] },
    ]
    expect(sshGrantsForProject(ssh, 'one')).toEqual(new Map([
      [blob('key-a'), new Set([blob('hk-github.com'), blob('hk-1'), blob('hk-2')])],
    ]))
    expect(sshGrantsForProject(ssh, 'two')).toEqual(new Map([
      [blob('key-a'), new Set([blob('hk-example.com')])],
      [blob('key-b'), new Set([blob('hk-example.com')])],
    ]))
    expect(sshGrantsForProject(ssh, 'three')).toEqual(new Map([
      [blob('key-a'), new Set([blob('hk-ssh-git.example.com')])],
    ]))
    expect(sshGrantsForProject(ssh, 'none')).toEqual(new Map())
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
  const cm = (registration: unknown, labels: Record<string, string> = { [LABEL_WORKSPACE_ID]: 'w1' }) => ({
    metadata: { name: 'yaac-proxy-reg-w1', labels },
    data: { 'registration.json': JSON.stringify(registration) },
  })

  it('reads the payload and the workspace id off the label', () => {
    const decoded = decodeRegistration(cm({
      rules: [{ hostPattern: 'api.example.com', pathPattern: '/*', injections: [
        { action: 'set_header', name: 'x-api-key', secretRef: 'demo/KEY' },
      ] }],
      allowedHosts: ['api.example.com', 7],
      repoUrl: 'https://github.com/acme/repo',
      tool: 'claude',
      projectId: 'demo',
      owner: 'alice',
      upstreamRedirects: {
        'api.anthropic.com': { host: 'mock', port: 8080, tls: false },
        'bad': { host: 'mock' },
      },
    }))
    expect(decoded?.workspaceId).toBe('w1')
    expect(decoded?.registration).toEqual({
      rules: [{ hostPattern: 'api.example.com', pathPattern: '/*', injections: [
        { action: 'set_header', name: 'x-api-key', secretRef: 'demo/KEY' },
      ] }],
      allowedHosts: ['api.example.com'],
      repoUrl: 'https://github.com/acme/repo',
      tool: 'claude',
      projectId: 'demo',
      owner: 'alice',
      upstreamRedirects: { 'api.anthropic.com': { host: 'mock', port: 8080, tls: false } },
    })
  })

  it('drops a registration without a tool, a project, its lists, or its label', () => {
    const base = { rules: [], allowedHosts: [], tool: 'claude', projectId: 'demo' }
    expect(decodeRegistration(cm({ ...base, tool: '' }))).toBeNull()
    expect(decodeRegistration(cm({ ...base, projectId: undefined }))).toBeNull()
    expect(decodeRegistration(cm({ ...base, rules: 'x' }))).toBeNull()
    expect(decodeRegistration(cm({ ...base, allowedHosts: undefined }))).toBeNull()
    expect(decodeRegistration(cm(base, {}))).toBeNull()
    expect(decodeRegistration({ metadata: { labels: { [LABEL_WORKSPACE_ID]: 'w1' } }, data: {} })).toBeNull()
    // An empty repoUrl reads as none (an https credential needs a remote).
    expect(decodeRegistration(cm({ ...base, repoUrl: '' }))?.registration.repoUrl).toBeUndefined()
    // One written before owner keys is kept, owner unset; a malformed owner
    // (empty, dotted, or not a string) is not a legacy one and is dropped.
    expect(decodeRegistration(cm(base))?.registration.owner).toBeUndefined()
    for (const owner of ['', 'a.b', 7]) expect(decodeRegistration(cm({ ...base, owner }))).toBeNull()
  })
})

describe('encodeRefreshed', () => {
  it('round-trips through decodeRefreshed in the credentials-file shape', () => {
    const data = encodeRefreshed(new Map([['o', { claude: CLAUDE_BUNDLE, codex: CODEX_BUNDLE }]]))
    expect(Object.keys(data).sort()).toEqual(['o.claude.json', 'o.codex.json'])
    // The shape the server's loader reads.
    const claudeFile = JSON.parse(Buffer.from(data['o.claude.json'], 'base64').toString('utf8')) as Record<string, unknown>
    expect(claudeFile.kind).toBe('oauth')
    expect(claudeFile.claudeAiOauth).toEqual(CLAUDE_BUNDLE)
    expect(decodeRefreshed({ data })).toEqual(new Map([['o', { claude: CLAUDE_BUNDLE, codex: CODEX_BUNDLE }]]))
  })

  it('encodes only the slots given, so a merge patch leaves every other owner and tool alone', () => {
    const data = encodeRefreshed(new Map([['alice', { codex: CODEX_BUNDLE }], ['bob', { claude: CLAUDE_BUNDLE }]]))
    expect(Object.keys(data).sort()).toEqual(['alice.codex.json', 'bob.claude.json'])
    expect(decodeRefreshed({})).toEqual(new Map())
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
