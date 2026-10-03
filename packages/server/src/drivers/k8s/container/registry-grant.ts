import crypto from 'node:crypto'
import { applyObject, createObject, readObject } from '#drivers/k8s/substrate'

/**
 * Write grants for the main registry (docs/trust-split-builds.md, "The
 * write gate"). Reads are anonymous; every write must carry a grant — a
 * statement signed by the install's grant key naming the repositories it
 * may write and when it expires. The gate in front of the registry holds
 * only the public key, so compromising it mints nothing.
 *
 * Wire format, as a Basic credential (user `yaac`):
 *
 *     password = <payload> "." base64url(signature)
 *     payload  = "v1|" <expiry, unix seconds> "|" <scope>
 *     scope    = "*" | <repo> ("," <repo>)*
 *
 * The signature is RSASSA-PKCS1-v1_5 over SHA-256 of the payload bytes,
 * which is what Envoy's Lua `verifySignature` checks against an RSA key.
 * The scope is an explicit repo list rather than a project id so the one
 * policy decision — which repos a build may write — is made here, where the
 * image prefix is known, and the gate does exact string membership.
 */

/** Secret holding the grant key: one per cluster. */
const REGISTRY_GRANT_SECRET = 'yaac-registry-grant-key'

/**
 * A namespace for the key alone. Not `yaac`, where the egress proxy (which
 * parses untrusted traffic) can read every Secret. Only the server's
 * ClusterRole and the host's kubeconfig can read it.
 */
export const REGISTRY_GRANT_NAMESPACE = 'yaac-registry-keys'
const SECRET_KEY_FIELD = 'key.pem'

/** Username every grant is presented under; the gate ignores it. */
const REGISTRY_GRANT_USER = 'yaac'

/** `*` is every repository, for the trusted writers (install, the e2e setup). */
type RegistryGrantScope = '*' | string[]

let keyPromise: Promise<crypto.KeyObject> | null = null

/**
 * The cluster's grant key, created on first use and read via the apiserver.
 * `create`, not `apply`, so racing first callers converge on one key.
 */
async function registryGrantKey(): Promise<crypto.KeyObject> {
  keyPromise ??= loadOrCreateKey().catch((err: unknown) => {
    keyPromise = null
    throw err
  })
  return keyPromise
}

async function readKey(): Promise<crypto.KeyObject | null> {
  const secret = await readObject<{ data?: Record<string, string> }>({
    apiVersion: 'v1', kind: 'Secret', name: REGISTRY_GRANT_SECRET, namespace: REGISTRY_GRANT_NAMESPACE,
  })
  const pem = secret?.data?.[SECRET_KEY_FIELD]
  return pem ? crypto.createPrivateKey(Buffer.from(pem, 'base64').toString('utf8')) : null
}

async function loadOrCreateKey(): Promise<crypto.KeyObject> {
  const existing = await readKey()
  if (existing) return existing
  await applyObject({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: REGISTRY_GRANT_NAMESPACE } })
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const manifest = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: REGISTRY_GRANT_SECRET, namespace: REGISTRY_GRANT_NAMESPACE },
    type: 'Opaque',
    data: { [SECRET_KEY_FIELD]: Buffer.from(pem).toString('base64') },
  }
  try {
    await createObject(manifest)
    return privateKey
  } catch (err) {
    const raced = await readKey().catch(() => null)
    if (raced) return raced
    throw err
  }
}

/** Test hook: forget the memoized key. */
export function _resetRegistryGrantKeyForTests(): void {
  keyPromise = null
}

/** A grant's Basic password, signed with `key`. */
export function mintRegistryGrant(
  key: crypto.KeyObject,
  scope: RegistryGrantScope,
  expiresAtSec: number,
): string {
  const payload = `v1|${String(expiresAtSec)}|${scope === '*' ? '*' : scope.join(',')}`
  const signature = crypto.sign('sha256', Buffer.from(payload), key)
  return `${payload}.${signature.toString('base64url')}`
}

/** A grant from the cluster's key, valid for `ttlSeconds` from now. */
export async function registryGrant(scope: RegistryGrantScope, ttlSeconds: number): Promise<string> {
  return mintRegistryGrant(
    await registryGrantKey(),
    scope,
    Math.floor(Date.now() / 1000) + ttlSeconds,
  )
}

/**
 * A containers-auth.json (`--authfile`) holding one grant for `host`, for
 * builder pods and host pushes. A file, not argv, which `ps` would expose.
 */
export async function registryAuthFile(
  host: string,
  scope: RegistryGrantScope,
  ttlSeconds: number,
): Promise<string> {
  const password = await registryGrant(scope, ttlSeconds)
  const auth = Buffer.from(`${REGISTRY_GRANT_USER}:${password}`).toString('base64')
  return JSON.stringify({ auths: { [host]: { auth } } })
}

/** The grant key's public half, SubjectPublicKeyInfo DER — what the gate verifies with. */
export async function registryGrantPublicKey(): Promise<Buffer> {
  return crypto.createPublicKey(await registryGrantKey()).export({ type: 'spki', format: 'der' })
}
