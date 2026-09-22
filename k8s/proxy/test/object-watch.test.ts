import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { spawn as nodeSpawn } from 'node:child_process'
import { ProxyObjects } from 'yaac-proxy-sidecar/object-watch'
import { LABEL_WORKTREE_ID, type SshKeyEntry, type WorktreeRegistration } from 'yaac-proxy-sidecar/objects'
import { createAgentKeyLoader } from 'yaac-proxy-sidecar/agent-keys'
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

const claudeBundle = (accessToken: string, expiresAt: number) => ({
  accessToken, refreshToken: `${accessToken}-refresh`, expiresAt, scopes: [] as string[],
})

/** A fake `spawn` for ssh-add: records argv and stdin, exits 0. */
function fakeSshAdd(): { spawn: typeof nodeSpawn; calls: Array<{ args: string[]; stdin: string }> } {
  const calls: Array<{ args: string[]; stdin: string }> = []
  const spawn = vi.fn((_cmd: string, args: string[]) => {
    const call = { args, stdin: '' }
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
    const loads: SshKeyEntry[][] = []
    const objects = new ProxyObjects({ loadSshKeys: (e) => { loads.push(e); return Promise.resolve() }, log: () => {} })
    expect(objects.credentials.claude).toBeNull()

    await objects.applyCredentials(credentialsSecret({
      'claude.json': { kind: 'api-key', apiKey: 'sk-ant' },
      'ssh-keys.json': [{ host: 'github.com', privateKey: 'K', knownHostsEntry: 'github.com ssh-ed25519 A' }],
    }))
    expect(objects.credentials.claude).toEqual({ kind: 'api-key', apiKey: 'sk-ant' })
    expect(loads).toEqual([[{ host: 'github.com', privateKey: 'K', knownHostsEntry: 'github.com ssh-ed25519 A' }]])

    // A token-only change leaves the agent alone: a reload empties it
    // under whatever ssh operation is in flight, so it runs only when the
    // key set itself moved.
    await objects.applyCredentials(credentialsSecret({
      'claude.json': { kind: 'api-key', apiKey: 'sk-ant-rotated' },
      'ssh-keys.json': [{ host: 'github.com', privateKey: 'K', knownHostsEntry: 'github.com ssh-ed25519 A' }],
    }))
    expect(objects.credentials.claude).toEqual({ kind: 'api-key', apiKey: 'sk-ant-rotated' })
    expect(loads).toHaveLength(1)

    // Replace semantics: a Secret rewritten without claude.json signs
    // claude out, and an emptied key list empties the agent.
    await objects.applyCredentials(credentialsSecret({ 'codex.json': { kind: 'api-key', apiKey: 'sk-oai' } }))
    expect(objects.credentials.claude).toBeNull()
    expect(objects.credentials.codex).toEqual({ kind: 'api-key', apiKey: 'sk-oai' })
    expect(loads[1]).toEqual([])

    // The object going away is the same as an empty one.
    await objects.applyCredentials(credentialsSecret({}), true)
    expect(objects.credentials.codex).toBeNull()
    expect(loads).toHaveLength(2)
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
  it('clears the agent, then adds each key constrained to its host', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-agent-keys-'))
    const knownHostsFile = path.join(dir, '.ssh', 'known_hosts')
    const { spawn, calls } = fakeSshAdd()
    const loader = createAgentKeyLoader({ agentSock: '/tmp/agent.sock', knownHostsFile, spawn, log: () => {} })

    await loader.reload([
      { host: 'a.example', privateKey: 'KEY-A', knownHostsEntry: 'a.example ssh-ed25519 AAA' },
      { host: 'b.example', privateKey: 'KEY-B', knownHostsEntry: 'b.example ssh-ed25519 BBB' },
    ])
    expect(calls.map((c) => c.args)).toEqual([
      ['-D'],
      ['-H', knownHostsFile, '-h', 'a.example', '-'],
      ['-H', knownHostsFile, '-h', 'b.example', '-'],
    ])
    expect(calls[1].stdin).toBe('KEY-A')
    // The file ssh-add is pointed at holds every host's line by the end.
    expect(fs.readFileSync(knownHostsFile, 'utf8')).toBe('a.example ssh-ed25519 AAA\nb.example ssh-ed25519 BBB\n')

    // An empty set empties the agent.
    await loader.reload([])
    expect(calls.at(-1)?.args).toEqual(['-D'])
    expect(fs.readFileSync(knownHostsFile, 'utf8')).toBe('')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
