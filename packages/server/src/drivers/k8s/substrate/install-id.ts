/**
 * Which k8s install this process acts for. Kept apart from the API client,
 * so the test setup can read it without loading `@kubernetes/client-node`.
 */
import { env } from '@yaac/shared/env'

/** What an install from before install ids still carries; see `bindInstall`. */
export interface LegacyKeys {
  /** The data-dir hash its older objects are labelled with. */
  hash?: string
  /** Its names and node path still carry the hash. */
  names?: boolean
}

let bound: { id: string; legacy: LegacyKeys } | null = null

/**
 * Bind this process to an install: `yaac cluster …` binds the one its data
 * dir records. Wins over `YAAC_INSTALL_ID`, so the id a test worker sets
 * for its file never overrides a recorded one.
 */
export function bindInstall(id: string, legacy: LegacyKeys = {}): void {
  bound = { id, legacy }
}

/**
 * The install this process acts for (`install.json`'s `installId`): what
 * every yaac object's `yaac.install-id` label carries, and what keys the
 * install's names and node path. The bound id, else `YAAC_INSTALL_ID` (the
 * server pod's). Throws without either: k8s code running for no install is
 * a bug, and the containerless driver never asks.
 */
export function installId(): string {
  const id = bound?.id ?? env.installId
  if (id === undefined) throw new Error('no k8s install id is bound to this process (YAAC_INSTALL_ID is unset)')
  return id
}

/**
 * Legacy: the data-dir hash an install from before install ids still has
 * objects labelled with (docs/legacy-compat-shims.md).
 */
export function legacyDataDirHash(): string | undefined {
  return bound ? bound.legacy.hash : env.legacyDataDirHash
}

/**
 * Legacy: the hash the install's names and node path still carry, while
 * objects named after it remain (a kind cluster created before install
 * ids, a byo install not yet switched); else undefined.
 */
export function legacyNameKey(): string | undefined {
  const names = bound ? bound.legacy.names === true : env.legacyNames
  return names ? legacyDataDirHash() : undefined
}

/** What the install's names and node path carry. */
export function installNameKey(): string {
  return legacyNameKey() ?? installId()
}
