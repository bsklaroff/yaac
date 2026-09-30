import crypto from 'node:crypto'
import { describe, it, expect, vi, beforeEach } from 'vitest'

type ExecResult = { stdout: string; stderr: string }
type ExecCallback = (err: unknown, res?: ExecResult) => void

/** The cluster's Secret store, as `kubectl get` / `kubectl create` see it. */
let secretPem: string | null = null
/** A key another client creates between our read and our create. */
let racedPem: string | null = null
const kubectlCalls: string[][] = []

function notFound(): Error {
  return Object.assign(new Error('kubectl failed'), {
    stderr: 'Error from server (NotFound): secrets "yaac-registry-grant-key" not found',
  })
}

function secretJson(pem: string): string {
  return JSON.stringify({ data: { 'key.pem': Buffer.from(pem).toString('base64') } })
}

// Every read and write of the key is a kubectl child process.
vi.mock('node:child_process', () => ({
  exec: vi.fn(),
  execFile: (file: string, args: string[], opts: unknown, cb?: ExecCallback) => {
    const done = (typeof opts === 'function' ? opts : cb) as ExecCallback
    kubectlCalls.push(args)
    let input = ''
    const answer = (): void => {
      if (args[0] === 'apply') {
        done(null, { stdout: '', stderr: '' })
        return
      }
      if (args[0] === 'get') {
        if (secretPem) done(null, { stdout: secretJson(secretPem), stderr: '' })
        else done(notFound())
        return
      }
      if (racedPem) {
        secretPem = racedPem
        done(Object.assign(new Error('exists'), { stderr: 'Error from server (AlreadyExists)' }))
        return
      }
      const manifest = JSON.parse(input) as { data: Record<string, string> }
      secretPem = Buffer.from(manifest.data['key.pem'], 'base64').toString('utf8')
      done(null, { stdout: '', stderr: '' })
    }
    if (args[0] === 'get') process.nextTick(answer)
    return {
      stdin: {
        on: vi.fn(),
        end: (data: string) => {
          input = data
          process.nextTick(answer)
        },
      },
    }
  },
  spawn: vi.fn(),
}))

vi.mock('#log', () => ({ serverLog: vi.fn(), pipeToServerLog: vi.fn() }))

import { registryAuthFile, registryGrantPublicKey } from '#drivers/k8s/container'
import { _resetRegistryGrantKeyForTests } from '#drivers/k8s/container/registry-grant'

const HOST = 'yaac-registry.yaac.svc.cluster.local:5000'

function newPem(): string {
  return crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    .export({ type: 'pkcs8', format: 'pem' }).toString()
}

/** The Basic password an authfile carries for `HOST`. */
function passwordOf(authFile: string): string {
  const { auths } = JSON.parse(authFile) as { auths: Record<string, { auth: string }> }
  const [user, ...rest] = Buffer.from(auths[HOST].auth, 'base64').toString().split(':')
  expect(user).toBe('yaac')
  return rest.join(':')
}

/** Verify a grant the way the registry's gate does. */
function verify(password: string, publicKeyDer: Buffer): { expiry: number; scope: string } | null {
  const dot = password.lastIndexOf('.')
  const payload = password.slice(0, dot)
  const key = crypto.createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' })
  const ok = crypto.verify('sha256', Buffer.from(payload), key, Buffer.from(password.slice(dot + 1), 'base64url'))
  const m = /^v1\|(\d+)\|(.+)$/.exec(payload)
  return ok && m ? { expiry: Number(m[1]), scope: m[2] } : null
}

beforeEach(() => {
  secretPem = null
  racedPem = null
  kubectlCalls.length = 0
  _resetRegistryGrantKeyForTests()
})

describe('registryAuthFile', () => {
  it('grants exactly the named repos until the ttl, signed by the cluster key', async () => {
    secretPem = newPem()
    const before = Math.floor(Date.now() / 1000)
    const authFile = await registryAuthFile(HOST, ['yaac-proj-p1', 'yaac-buildcache-p1'], 600)

    const grant = verify(passwordOf(authFile), await registryGrantPublicKey())
    expect(grant?.scope).toBe('yaac-proj-p1,yaac-buildcache-p1')
    // The trusted writers' grant covers every repo.
    const admin = await registryAuthFile(HOST, '*', 600)
    expect(verify(passwordOf(admin), await registryGrantPublicKey())?.scope).toBe('*')
    expect(grant?.expiry).toBeGreaterThanOrEqual(before + 600)
    expect(grant?.expiry).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 600)
    // Read once, from its own namespace: the egress proxy can read the
    // install namespace's Secrets.
    expect(kubectlCalls).toEqual([
      ['get', 'secret', 'yaac-registry-grant-key', '-n', 'yaac-registry-keys', '-o', 'json'],
    ])

    // A grant from any other key does not verify.
    const foreign = crypto.createPublicKey(newPem()).export({ type: 'spki', format: 'der' })
    expect(verify(passwordOf(authFile), foreign)).toBeNull()
  })

  it('creates the cluster key on first use, and adopts a racing creator\'s', async () => {
    const authFile = await registryAuthFile(HOST, ['yaac-user-p1'], 60)
    // The namespace is ensured before the Secret is created into it.
    expect(kubectlCalls.map((a) => a[0])).toEqual(['get', 'apply', 'create'])
    const created = crypto.createPublicKey(secretPem!).export({ type: 'spki', format: 'der' })
    expect(verify(passwordOf(authFile), created)?.scope).toBe('yaac-user-p1')

    // Racing first callers converge on one key: the loser adopts the
    // winner's.
    secretPem = null
    racedPem = newPem()
    _resetRegistryGrantKeyForTests()
    const raced = await registryAuthFile(HOST, ['yaac-user-p1'], 60)
    const winner = crypto.createPublicKey(racedPem).export({ type: 'spki', format: 'der' })
    expect(verify(passwordOf(raced), winner)).not.toBeNull()
  })
})

describe('registryGrantPublicKey', () => {
  it('is the SPKI DER public half of the cluster key, and never the private half', async () => {
    secretPem = newPem()
    const der = await registryGrantPublicKey()
    expect(der.equals(crypto.createPublicKey(secretPem).export({ type: 'spki', format: 'der' }))).toBe(true)
    expect(der.toString('latin1')).not.toContain('PRIVATE')
    expect(crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }).asymmetricKeyType).toBe('rsa')
  })

  it('fails on a corrupt Secret rather than minting a second key, and retries next call', async () => {
    secretPem = 'not a pem'
    await expect(registryGrantPublicKey()).rejects.toThrow()
    expect(kubectlCalls.map((a) => a[0])).toEqual(['get'])

    secretPem = newPem()
    await expect(registryGrantPublicKey()).resolves.toBeInstanceOf(Buffer)
  })
})
