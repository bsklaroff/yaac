import type { CloudProvider } from '@yaac/shared/types'

/**
 * One cloud's server half (docs/cloud-identity.md): finding the server's
 * own identity there and minting tokens for it or for an identity it may
 * switch to. The proxy half, which answers a workspace's metadata
 * requests, lives in k8s/proxy/cloud-metadata.ts.
 */
export interface CloudIdentityProvider {
  name: CloudProvider
  /** The server's own identity on this cloud, or null when it is not
   *  running there (or has no identity). Never throws. */
  detect(): Promise<HostIdentity | null>
  /** Why `id` cannot name an identity on this cloud, or null when it can. */
  validateId(id: string): string | null
  /** A token for `id`, the host's own identity or one to switch to. Throws
   *  with a reason the user can act on. */
  obtain(id: string, host: HostIdentity): Promise<ObtainedToken>
}

/** The server's own identity, and the cloud project it runs in. */
export interface HostIdentity {
  identity: string
  project: { id: string; number: string }
}

export interface ObtainedToken {
  accessToken: string
  /** Epoch ms. */
  expiresAt: number
}
