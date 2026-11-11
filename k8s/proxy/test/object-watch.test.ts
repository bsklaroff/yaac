import { describe, it, expect } from 'vitest'
import { ProxyObjects } from 'yaac-proxy-sidecar/object-watch'
import { LABEL_WORKSPACE_ID, type SshCredentialEntry, type ProxyRegistration } from 'yaac-proxy-sidecar/objects'

/**
 * The proxy's live view of its input objects, driven with raw add / update
 * / delete events as the informers would.
 */

const b64 = (v: unknown): string => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64')

/** The credentials Secret holding each owner's files (owner `o` unless
 *  given). */
function credentialsSecret(
  files: Record<string, unknown>,
  ...more: Array<[string, Record<string, unknown>]>
): { metadata: { name: string }; data: Record<string, string> } {
  return {
    metadata: { name: 'yaac-proxy-credentials' },
    data: Object.fromEntries([['o', files] as const, ...more].flatMap(([owner, f]) =>
      Object.entries(f).map(([k, v]) => [`${owner}.${k}`, b64(v)]))),
  }
}

function secretsObject(name: string, values: Record<string, string>): { metadata: { name: string }; data: Record<string, string> } {
  return { metadata: { name }, data: { 'values.json': b64(values) } }
}

function registrationObject(workspaceId: string, reg: Partial<ProxyRegistration> = {}) {
  return {
    metadata: { name: `yaac-proxy-reg-${workspaceId}`, labels: { [LABEL_WORKSPACE_ID]: workspaceId } },
    data: { 'registration.json': JSON.stringify({
      rules: [], allowedHosts: ['api.example.com'], projectId: 'demo', owner: 'o', ...reg,
    }) },
  }
}

const PUBLIC_KEY = `ssh-ed25519 ${Buffer.from('blob').toString('base64')} yaac`
const grant = (projectId: string, host = 'github.com') => ({
  projectId, repoId: `repo-${projectId}`, host, path: 'acme/repo', readOnly: false, ghToken: true,
  knownHostsEntry: `${host} ssh-ed25519 ${Buffer.from(`hostkey-${host}`).toString('base64')}`,
})
const sshKey = (...grants: SshCredentialEntry['grants']): SshCredentialEntry =>
  ({ privateKey: 'K', publicKey: PUBLIC_KEY, grants })

const claudeBundle = (accessToken: string, expiresAt: number) => ({
  accessToken, refreshToken: `${accessToken}-refresh`, expiresAt, scopes: [] as string[],
})

describe('ProxyObjects', () => {
  it('replaces the whole credential set on each update', () => {
    const objects = new ProxyObjects({ log: () => {} })
    expect(objects.credentials('o').claude).toBeNull()

    objects.applyCredentials(credentialsSecret({
      'claude.json': { kind: 'api-key', apiKey: 'sk-ant' },
      'ssh-keys.json': [sshKey(grant('demo'))],
    }))
    expect(objects.credentials('o').claude).toEqual({ kind: 'api-key', apiKey: 'sk-ant' })
    expect(objects.credentials('o').ssh).toEqual([sshKey(grant('demo'))])

    // A grant changed in the Secret is the grant the next request reads.
    objects.applyCredentials(credentialsSecret({
      'claude.json': { kind: 'api-key', apiKey: 'sk-ant-rotated' },
      'ssh-keys.json': [sshKey(grant('other'), { ...grant('demo'), readOnly: true })],
    }))
    expect(objects.credentials('o').claude).toEqual({ kind: 'api-key', apiKey: 'sk-ant-rotated' })
    expect(objects.credentials('o').ssh[0].grants.map((g) => [g.projectId, g.readOnly]))
      .toEqual([['other', false], ['demo', true]])

    // Replace semantics: a Secret rewritten without claude.json signs
    // claude out, and one without the key takes it away.
    objects.applyCredentials(credentialsSecret({ 'codex.json': { kind: 'api-key', apiKey: 'sk-oai' } }))
    expect(objects.credentials('o').claude).toBeNull()
    expect(objects.credentials('o').ssh).toEqual([])
    expect(objects.credentials('o').codex).toEqual({ kind: 'api-key', apiKey: 'sk-oai' })

    // The object going away is the same as an empty one.
    objects.applyCredentials(credentialsSecret({}), true)
    expect(objects.credentials('o').codex).toBeNull()
  })

  it('takes credentials only from the one object that is the credentials Secret, on every verb', () => {
    // A labelled object with the wrong name neither fills nor blanks the set.
    const objects = new ProxyObjects({ log: () => {} })
    const stray = {
      metadata: { name: 'something-else' },
      data: credentialsSecret({ 'claude.json': { kind: 'api-key', apiKey: 'sk-ant-stray' } }).data,
    }
    objects.applyCredentials(stray)
    expect(objects.credentials('o').claude).toBeNull()

    objects.applyCredentials(credentialsSecret({ 'claude.json': { kind: 'api-key', apiKey: 'sk-ant' } }))
    objects.capture('o', { claude: claudeBundle('captured', 9) })
    objects.applyCredentials(stray, true)
    expect(objects.credentials('o').claude).toEqual({ kind: 'api-key', apiKey: 'sk-ant' })
    expect(objects.claudeOAuthBundle('o')).toEqual(claudeBundle('captured', 9))
  })

  it('serves a captured rotation until the pushed bundle catches up', () => {
    const objects = new ProxyObjects({ log: () => {} })
    const pushed = claudeBundle('a1', 1_000)
    objects.applyCredentials(credentialsSecret({ 'claude.json': { kind: 'oauth', claudeAiOauth: pushed } }))
    expect(objects.claudeOAuthBundle('o')).toEqual(pushed)

    // A workspace refreshed: the capture is newer, so it is what gets served.
    const rotated = claudeBundle('a2', 2_000)
    objects.capture('o', { claude: rotated })
    expect(objects.claudeOAuthBundle('o')).toEqual(rotated)

    // The server pushes something older still (a stale write in flight):
    // the capture stays.
    objects.applyCredentials(credentialsSecret({ 'claude.json': { kind: 'oauth', claudeAiOauth: pushed } }))
    expect(objects.claudeOAuthBundle('o')).toEqual(rotated)

    // Once the server echoes it back, the capture is dropped.
    objects.applyCredentials(credentialsSecret({ 'claude.json': { kind: 'oauth', claudeAiOauth: rotated } }))
    expect(objects.claudeOAuthBundle('o')).toEqual(rotated)
    const newer = claudeBundle('a3', 3_000)
    objects.applyCredentials(credentialsSecret({ 'claude.json': { kind: 'oauth', claudeAiOauth: newer } }))
    expect(objects.claudeOAuthBundle('o')).toEqual(newer)

    // A sign-out drops the capture too: nothing must sign the user back in.
    objects.capture('o', { claude: claudeBundle('a4', 4_000) })
    objects.applyCredentials(credentialsSecret({}), true)
    expect(objects.claudeOAuthBundle('o')).toBeNull()
  })

  it('keeps two owners apart: credentials, captured rotations and the owner a workspace spends', () => {
    const objects = new ProxyObjects({ log: () => {} })
    const alice = claudeBundle('alice', 1_000)
    const bob = claudeBundle('bob', 1_000)
    const secret = (aliceClaude: ReturnType<typeof claudeBundle>) => credentialsSecret(
      { 'claude.json': { kind: 'oauth', claudeAiOauth: aliceClaude }, 'ssh-keys.json': [sshKey(grant('a'))] },
      ['bob', { 'claude.json': { kind: 'oauth', claudeAiOauth: bob }, 'ssh-keys.json': [sshKey(grant('b', 'gitlab.com'))] }],
    )
    objects.applyCredentials(secret(alice))
    objects.applyRegistration(registrationObject('wa', { owner: 'o' }))
    objects.applyRegistration(registrationObject('wb', { owner: 'bob' }))
    expect(objects.ownerOf('wa')).toBe('o')
    expect(objects.ownerOf('wb')).toBe('bob')
    expect(objects.ownerOf('unregistered')).toBeUndefined()
    // An owner the Secret does not name has nothing to spend.
    expect(objects.credentials('carol')).toEqual(objects.credentials(undefined))
    expect(objects.credentials('carol').claude).toBeNull()

    // A rotation captured in one owner's workspace is served to that owner
    // only, and dropped once that owner's push echoes it back.
    const rotated = claudeBundle('alice-2', 2_000)
    objects.capture('o', { claude: rotated })
    expect(objects.claudeOAuthBundle('o')).toEqual(rotated)
    expect(objects.claudeOAuthBundle('bob')).toEqual(bob)
    objects.applyCredentials(secret(rotated))
    expect(objects.claudeOAuthBundle('o')).toEqual(rotated)
    objects.capture('bob', { claude: claudeBundle('bob-2', 2_000) })
    objects.applyCredentials(secret(rotated))
    expect(objects.claudeOAuthBundle('bob')).toEqual(claudeBundle('bob-2', 2_000))
  })

  it('keeps each project’s secret values under its own object', () => {
    const objects = new ProxyObjects({ log: () => {} })
    objects.applyProjectSecrets(secretsObject('yaac-proxy-secrets-demo', { 'demo/A': '1', 'demo/B': '2' }))
    objects.applyProjectSecrets(secretsObject('yaac-proxy-secrets-other', { 'other/A': '9' }))
    expect(objects.secret('demo/A')).toBe('1')
    expect(objects.secret('other/A')).toBe('9')

    // An update replaces that project's refs: a dropped value is forgotten.
    objects.applyProjectSecrets(secretsObject('yaac-proxy-secrets-demo', { 'demo/A': '1b' }))
    expect(objects.secret('demo/A')).toBe('1b')
    expect(objects.secret('demo/B')).toBeUndefined()
    expect(objects.secret('other/A')).toBe('9')

    // A delete forgets exactly that project's refs.
    objects.applyProjectSecrets(secretsObject('yaac-proxy-secrets-demo', {}), true)
    expect(objects.secret('demo/A')).toBeUndefined()
    expect(objects.secret('other/A')).toBe('9')
  })

  it('registers, updates and deregisters exactly the workspace an object names', () => {
    const seen: Array<[string, ProxyRegistration | null]> = []
    const objects = new ProxyObjects({
      onRegistration: (id, reg) => seen.push([id, reg]),
      log: () => {},
    })
    objects.applyRegistration(registrationObject('w1'))
    objects.applyRegistration(registrationObject('w2', { allowedHosts: ['*'] }))
    expect(objects.registeredWorkspaceIds().sort()).toEqual(['w1', 'w2'])
    expect(objects.registration('w2')?.allowedHosts).toEqual(['*'])

    // An allowlist widening arrives as an update of the same object.
    objects.applyRegistration(registrationObject('w1', { allowedHosts: ['api.example.com', 'new.example.com'] }))
    expect(objects.registration('w1')?.allowedHosts).toEqual(['api.example.com', 'new.example.com'])
    expect(seen.at(-1)?.[0]).toBe('w1')

    // A delete removes that workspace and nothing else — even when the
    // delete event carries no data.
    objects.applyRegistration({ metadata: { name: 'yaac-proxy-reg-w1' } }, true)
    expect(objects.registration('w1')).toBeUndefined()
    expect(objects.registration('w2')).toBeDefined()
    expect(seen.at(-1)).toEqual(['w1', null])

    // A malformed registration is dropped, and fails that workspace closed.
    objects.applyRegistration({
      metadata: { name: 'yaac-proxy-reg-w3', labels: { [LABEL_WORKSPACE_ID]: 'w3' } },
      data: { 'registration.json': '{"rules":[]}' },
    })
    expect(objects.registration('w3')).toBeUndefined()
  })

  it('is not ready before every initial list has landed', () => {
    const objects = new ProxyObjects({ log: () => {} })
    expect(objects.ready()).toBe(false)
    objects.markSeeded('credentials')
    objects.markSeeded('secrets')
    expect(objects.ready()).toBe(false)
    objects.markSeeded('registration')
    expect(objects.ready()).toBe(true)
  })
})
