import crypto from 'node:crypto'
import { kubectlApply, kubectlGetJson, kubectlWithRetry } from '#drivers/k8s/substrate'

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
export const REGISTRY_GRANT_SECRET = 'yaac-registry-grant-key'

/**
 * The key's namespace, holding nothing else. NOT the registry's (`yaac`):
 * that is also the default install namespace, where the egress proxy's
 * Role reads every Secret — and the proxy, which parses untrusted traffic,
 * must not be one compromise away from registry-admin. Only cluster-wide
 * readers reach this one: the server's ClusterRole and the host's
 * kubeconfig.
 */
export const REGISTRY_GRANT_NAMESPACE = 'yaac-registry-keys'
const SECRET_KEY_FIELD = 'key.pem'

/** Username every grant is presented under; the gate ignores it. */
export const REGISTRY_GRANT_USER = 'yaac'

/** `*` is every repository, for the trusted writers (install, the e2e setup). */
export type RegistryGrantScope = '*' | string[]

let keyPromise: Promise<crypto.KeyObject> | null = null

/**
 * The cluster's grant key, created on first use. Read through the apiserver
 * wherever the caller runs — the host CLI through its kubeconfig, the
 * in-cluster server through its cluster-wide ServiceAccount — so nothing
 * mounts or copies it.
 *
 * `create`, never `apply`: two first callers racing must converge on ONE
 * key, so the loser of the create reads the winner's back.
 */
async function registryGrantKey(): Promise<crypto.KeyObject> {
  keyPromise ??= loadOrCreateKey().catch((err: unknown) => {
    keyPromise = null
    throw err
  })
  return keyPromise
}

async function readKey(): Promise<crypto.KeyObject | null> {
  const secret = await kubectlGetJson<{ data?: Record<string, string> }>([
    'get', 'secret', REGISTRY_GRANT_SECRET, '-n', REGISTRY_GRANT_NAMESPACE,
  ])
  const pem = secret?.data?.[SECRET_KEY_FIELD]
  return pem ? crypto.createPrivateKey(Buffer.from(pem, 'base64').toString('utf8')) : null
}

async function loadOrCreateKey(): Promise<crypto.KeyObject> {
  const existing = await readKey()
  if (existing) return existing
  await kubectlApply({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: REGISTRY_GRANT_NAMESPACE } })
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
    await kubectlWithRetry(['create', '-f', '-'], { input: JSON.stringify(manifest) })
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
 * A containers-auth.json (`--authfile`) holding one grant for `host` —
 * never argv, where any local user's `ps` reads it. What a builder pod is
 * handed, and what a host push runs with: podman sends it on every request
 * to the registry, and the gate honors it on writes within `scope` alone.
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
