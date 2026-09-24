import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { spawn as nodeSpawn } from 'node:child_process'
import { ProxyObjects } from 'yaac-proxy-sidecar/object-watch'
import { LABEL_WORKTREE_ID, type SshCredentialEntry, type WorktreeRegistration } from 'yaac-proxy-sidecar/objects'
import { createAgentKeyLoader, type AgentIdentity } from 'yaac-proxy-sidecar/agent-keys'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The proxy's live view of its input objects, driven the way the informers
 * drive it (add / update / delete of raw objects), with the ssh-agent
 * reload faked at the process boundary — `ssh-add` itself.
 */

const b64 = (v: unknown): string => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64')

function credentialsSecret(files: Record<string, unknown>): { metadata: { name: string }; data: Record<string, string> } {
  return {
    metadata: { name: 'yaac-proxy-credentials' },
    data: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, b64(v)])),
  }
}

function secretsObject(name: string, values: Record<string, string>): { metadata: { name: string }; data: Record<string, string> } {
  return { metadata: { name }, data: { 'values.json': b64(values) } }
}

function registrationObject(worktreeId: string, reg: Partial<WorktreeRegistration> = {}) {
  return {
    metadata: { name: `yaac-proxy-reg-${worktreeId}`, labels: { [LABEL_WORKTREE_ID]: worktreeId } },
    data: { 'registration.json': JSON.stringify({
      rules: [], allowedHosts: ['api.example.com'], tool: 'claude', projectSlug: 'demo', ...reg,
    }) },
  }
}

const PUBLIC_KEY = `ssh-ed25519 ${Buffer.from('blob').toString('base64')} yaac`
const grant = (slug: string, host = 'github.com') =>
  ({ slug, host, knownHostsEntry: `${host} ssh-ed25519 H` })
const sshKey = (...projects: SshCredentialEntry['projects']): SshCredentialEntry =>
  ({ privateKey: 'K', publicKey: PUBLIC_KEY, projects })

const claudeBundle = (accessToken: string, expiresAt: number) => ({
  accessToken, refreshToken: `${accessToken}-refresh`, expiresAt, scopes: [] as string[],
})

/** A fake `spawn` for ssh-add: records argv, stdin and — since ssh-add
 *  reads it while it runs — the known_hosts file's contents; exits 0. */
function fakeSshAdd(knownHostsFile: string): {
  spawn: typeof nodeSpawn
  calls: Array<{ args: string[]; stdin: string; knownHosts: string }>
} {
  const calls: Array<{ args: string[]; stdin: string; knownHosts: string }> = []
  const spawn = vi.fn((_cmd: string, args: string[]) => {
    const knownHosts = fs.existsSync(knownHostsFile) ? fs.readFileSync(knownHostsFile, 'utf8') : ''
    const call = { args, stdin: '', knownHosts }
    calls.push(call)
    const child = new EventEmitter() as EventEmitter & {
      stdin: { end: (s: string) => void }
      stderr: EventEmitter
      stdout: EventEmitter
    }
    child.stdin = { end: (s: string) => { call.stdin = s } }
    child.stderr = new EventEmitter()
    child.stdout = new EventEmitter()
    setImmediate(() => child.emit('close', 0))
    return child
  }) as unknown as typeof nodeSpawn
  return { spawn, calls }
}

describe('ProxyObjects', () => {
  it('replaces the whole credential set on each update and reloads the agent', async () => {
    const loads: AgentIdentity[][] = []
    const objects = new ProxyObjects({ loadSshKeys: (e) => { loads.push(e); return Promise.resolve() }, log: () => {} })
    expect(objects.credentials.claude).toBeNull()

    await objects.applyCredentials(credentialsSecret({
      'claude.json': { kind: 'api-key', apiKey: 'sk-ant' },
      'ssh-keys.json': [sshKey(grant('demo'))],
    }))
    expect(objects.credentials.claude).toEqual({ kind: 'api-key', apiKey: 'sk-ant' })
    expect(loads).toEqual([[{ privateKey: 'K', hosts: ['github.com'], knownHosts: ['github.com ssh-ed25519 H'] }]])

    // A token-only change leaves the agent alone: a reload empties it
    // under whatever ssh operation is in flight, so it runs only when what
    // the agent holds moved.
    await objects.applyCredentials(credentialsSecret({
      'claude.json': { kind: 'api-key', apiKey: 'sk-ant-rotated' },
      'ssh-keys.json': [sshKey(grant('demo'))],
    }))
    expect(objects.credentials.claude).toEqual({ kind: 'api-key', apiKey: 'sk-ant-rotated' })
    expect(loads).toHaveLength(1)

    // So does assigning the key to another project on a host it already
    // serves: which worktrees may use it is the relay's live lookup, and
    // the decoded set carries the new assignment for it.
    await objects.applyCredentials(credentialsSecret({
      'ssh-keys.json': [sshKey(grant('other'), grant('demo'))],
    }))
    expect(loads).toHaveLength(1)
    expect(objects.credentials.ssh[0].projects.map((p) => p.slug)).toEqual(['other', 'demo'])

    // A new host is a new constraint, which only a reload can add…
    await objects.applyCredentials(credentialsSecret({
      'ssh-keys.json': [sshKey(grant('demo'), grant('gl', 'gitlab.com'))],
    }))
    expect(loads[1]).toEqual([{
      privateKey: 'K',
      hosts: ['github.com', 'gitlab.com'],
      knownHosts: ['github.com ssh-ed25519 H', 'gitlab.com ssh-ed25519 H'],
    }])
    // …and a key unassigned from every project leaves the agent.
    await objects.applyCredentials(credentialsSecret({ 'ssh-keys.json': [sshKey()] }))
    expect(loads[2]).toEqual([])

    // Replace semantics: a Secret rewritten without claude.json signs
    // claude out.
    await objects.applyCredentials(credentialsSecret({ 'codex.json': { kind: 'api-key', apiKey: 'sk-oai' } }))
    expect(objects.credentials.claude).toBeNull()
    expect(objects.credentials.codex).toEqual({ kind: 'api-key', apiKey: 'sk-oai' })

    // The object going away is the same as an empty one.
    await objects.applyCredentials(credentialsSecret({}), true)
    expect(objects.credentials.codex).toBeNull()
    expect(loads).toHaveLength(3)
  })

  it('takes credentials only from the one object that is the credentials Secret, on every verb', async () => {
    // The label is what the informer selects on; the name is the writer's
    // invariant, held on the reader too — a stray labelled object must
    // neither fill the set nor, when it goes, blank it.
    const objects = new ProxyObjects({ loadSshKeys: () => Promise.resolve(), log: () => {} })
    const stray = {
      metadata: { name: 'something-else' },
      data: credentialsSecret({ 'claude.json': { kind: 'api-key', apiKey: 'sk-ant-stray' } }).data,
    }
    await objects.applyCredentials(stray)
    expect(objects.credentials.claude).toBeNull()

    await objects.applyCredentials(credentialsSecret({ 'claude.json': { kind: 'api-key', apiKey: 'sk-ant' } }))
    objects.capture({ claude: claudeBundle('captured', 9) })
    await objects.applyCredentials(stray, true)
    expect(objects.credentials.claude).toEqual({ kind: 'api-key', apiKey: 'sk-ant' })
    expect(objects.claudeOAuthBundle()).toEqual(claudeBundle('captured', 9))
  })

  it('serves a captured rotation until the pushed bundle catches up', async () => {
    const objects = new ProxyObjects({ loadSshKeys: () => Promise.resolve(), log: () => {} })
    const pushed = claudeBundle('a1', 1_000)
    await objects.applyCredentials(credentialsSecret({ 'claude.json': { kind: 'oauth', claudeAiOauth: pushed } }))
    expect(objects.claudeOAuthBundle()).toEqual(pushed)

    // A worktree refreshed: the capture is newer, so it is what gets served.
    const rotated = claudeBundle('a2', 2_000)
    objects.capture({ claude: rotated })
    expect(objects.claudeOAuthBundle()).toEqual(rotated)

    // The server pushes something older still (a stale write in flight):
    // the capture stays.
    await objects.applyCredentials(credentialsSecret({ 'claude.json': { kind: 'oauth', claudeAiOauth: pushed } }))
    expect(objects.claudeOAuthBundle()).toEqual(rotated)

    // The server adopted it and echoed it back: the capture is dropped, and
    // from here the pushed bundle is the one that moves.
    await objects.applyCredentials(credentialsSecret({ 'claude.json': { kind: 'oauth', claudeAiOauth: rotated } }))
    expect(objects.claudeOAuthBundle()).toEqual(rotated)
    const newer = claudeBundle('a3', 3_000)
    await objects.applyCredentials(credentialsSecret({ 'claude.json': { kind: 'oauth', claudeAiOauth: newer } }))
    expect(objects.claudeOAuthBundle()).toEqual(newer)

    // A sign-out drops the capture too: nothing must sign the user back in.
    objects.capture({ claude: claudeBundle('a4', 4_000) })
    await objects.applyCredentials(credentialsSecret({}), true)
    expect(objects.claudeOAuthBundle()).toBeNull()
  })

  it('keeps each project’s secret values under its own object', () => {
    const objects = new ProxyObjects({ loadSshKeys: () => Promise.resolve(), log: () => {} })
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

  it('registers, updates and deregisters exactly the worktree an object names', () => {
    const seen: Array<[string, WorktreeRegistration | null]> = []
    const objects = new ProxyObjects({
      loadSshKeys: () => Promise.resolve(),
      onRegistration: (id, reg) => seen.push([id, reg]),
      log: () => {},
    })
    objects.applyRegistration(registrationObject('w1'))
    objects.applyRegistration(registrationObject('w2', { allowedHosts: ['*'] }))
    expect(objects.registeredWorktreeIds().sort()).toEqual(['w1', 'w2'])
    expect(objects.registration('w2')?.allowedHosts).toEqual(['*'])

    // An allowlist widening arrives as an update of the same object.
    objects.applyRegistration(registrationObject('w1', { allowedHosts: ['api.example.com', 'new.example.com'] }))
    expect(objects.registration('w1')?.allowedHosts).toEqual(['api.example.com', 'new.example.com'])
    expect(seen.at(-1)?.[0]).toBe('w1')

    // A delete removes that worktree and nothing else — even when the
    // delete event carries no data.
    objects.applyRegistration({ metadata: { name: 'yaac-proxy-reg-w1' } }, true)
    expect(objects.registration('w1')).toBeUndefined()
    expect(objects.registration('w2')).toBeDefined()
    expect(seen.at(-1)).toEqual(['w1', null])

    // A malformed registration is dropped, and fails that worktree closed.
    objects.applyRegistration({
      metadata: { name: 'yaac-proxy-reg-w3', labels: { [LABEL_WORKTREE_ID]: 'w3' } },
      data: { 'registration.json': '{"rules":[]}' },
    })
    expect(objects.registration('w3')).toBeUndefined()
  })

  it('is not ready before every initial list has landed', () => {
    const objects = new ProxyObjects({ loadSshKeys: () => Promise.resolve(), log: () => {} })
    expect(objects.ready()).toBe(false)
    objects.markSeeded('credentials')
    objects.markSeeded('secrets')
    expect(objects.ready()).toBe(false)
    objects.markSeeded('registration')
    expect(objects.ready()).toBe(true)
  })
})

describe('createAgentKeyLoader', () => {
  it('clears the agent, then adds each key once, constrained to every host it serves', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-agent-keys-'))
    const knownHostsFile = path.join(dir, '.ssh', 'known_hosts')
    const { spawn, calls } = fakeSshAdd(knownHostsFile)
    const loader = createAgentKeyLoader({ agentSock: '/tmp/agent.sock', knownHostsFile, spawn, log: () => {} })

    await loader.reload([
      { privateKey: 'KEY-A', hosts: ['a.example', 'b.example'], knownHosts: ['a.example ssh-ed25519 AAA', 'b.example ssh-ed25519 BBB'] },
      { privateKey: 'KEY-C', hosts: ['c.example'], knownHosts: ['c.example ssh-ed25519 CCC'] },
    ])
    expect(calls.map((c) => c.args)).toEqual([
      ['-D'],
      ['-H', knownHostsFile, '-h', 'a.example', '-h', 'b.example', '-'],
      ['-H', knownHostsFile, '-h', 'c.example', '-'],
    ])
    expect(calls.map((c) => c.stdin)).toEqual(['', 'KEY-A', 'KEY-C'])
    // Each add sees exactly its own key's host keys.
    expect(calls.map((c) => c.knownHosts)).toEqual(['', 'a.example ssh-ed25519 AAA\nb.example ssh-ed25519 BBB\n', 'c.example ssh-ed25519 CCC\n'])

    // An empty set empties the agent.
    await loader.reload([])
    expect(calls.at(-1)?.args).toEqual(['-D'])
    expect(fs.readFileSync(knownHostsFile, 'utf8')).toBe('')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
