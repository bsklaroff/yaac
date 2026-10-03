import crypto from 'node:crypto'
import { describe, it, expect, beforeEach } from 'vitest'

import { fakeCluster } from '@yaac/test-utils/k8s-stub'

const SECRET = { name: 'yaac-registry-grant-key', namespace: 'yaac-registry-keys' }

/** Put the cluster's grant key Secret in place. */
function seedKey(pem: string): void {
  fakeCluster.seed({
    apiVersion: 'v1', kind: 'Secret', metadata: SECRET,
    data: { 'key.pem': Buffer.from(pem).toString('base64') },
  })
}

/** The PEM the cluster's grant key Secret holds. */
function storedPem(): string {
  const secret = fakeCluster.get<{ data: Record<string, string> }>('Secret', SECRET.name, SECRET.namespace)
  return Buffer.from(secret?.data['key.pem'] ?? '', 'base64').toString('utf8')
}

const verbs = (): string[] => fakeCluster.calls.map((c) => `${c.verb} ${c.kind}`)

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
  _resetRegistryGrantKeyForTests()
})

describe('registryAuthFile', () => {
  it('grants exactly the named repos until the ttl, signed by the cluster key', async () => {
    seedKey(newPem())
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
    expect(fakeCluster.calls).toEqual([
      { verb: 'read', apiVersion: 'v1', kind: 'Secret', ...SECRET },
    ])

    // A grant from any other key does not verify.
    const foreign = crypto.createPublicKey(newPem()).export({ type: 'spki', format: 'der' })
    expect(verify(passwordOf(authFile), foreign)).toBeNull()
  })

  it('creates the cluster key on first use, and adopts a racing creator\'s', async () => {
    const authFile = await registryAuthFile(HOST, ['yaac-user-p1'], 60)
    // The namespace is ensured before the Secret is created into it.
    expect(verbs()).toEqual(['read Secret', 'apply Namespace', 'create Secret'])
    const created = crypto.createPublicKey(storedPem()).export({ type: 'spki', format: 'der' })
    expect(verify(passwordOf(authFile), created)?.scope).toBe('yaac-user-p1')

    // Racing first callers converge on one key: the loser adopts the
    // winner's.
    fakeCluster.reset()
    const racedPem = newPem()
    fakeCluster.intercept((c) => { if (c.verb === 'create') seedKey(racedPem) })
    _resetRegistryGrantKeyForTests()
    const raced = await registryAuthFile(HOST, ['yaac-user-p1'], 60)
    const winner = crypto.createPublicKey(racedPem).export({ type: 'spki', format: 'der' })
    expect(verify(passwordOf(raced), winner)).not.toBeNull()
  })
})

describe('registryGrantPublicKey', () => {
  it('is the SPKI DER public half of the cluster key, and never the private half', async () => {
    const pem = newPem()
    seedKey(pem)
    const der = await registryGrantPublicKey()
    expect(der.equals(crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' }))).toBe(true)
    expect(der.toString('latin1')).not.toContain('PRIVATE')
    expect(crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }).asymmetricKeyType).toBe('rsa')
  })

  it('fails on a corrupt Secret rather than minting a second key, and retries next call', async () => {
    seedKey('not a pem')
    await expect(registryGrantPublicKey()).rejects.toThrow()
    expect(verbs()).toEqual(['read Secret'])

    seedKey(newPem())
    await expect(registryGrantPublicKey()).resolves.toBeInstanceOf(Buffer)
  })
})
