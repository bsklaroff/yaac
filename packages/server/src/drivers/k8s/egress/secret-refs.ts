import fs from 'node:fs/promises'
import path from 'node:path'
import { credentialsDir } from '@yaac/shared/project-paths'
import { serverLog } from '#log'

/**
 * How a secret is NAMED to the proxy, and the one file that naming replaced.
 *
 * A leaf on purpose: both the client that pushes values and the module that
 * assembles a push need these, and putting them in either would make the two
 * import each other. That cycle happens to work — each uses the other's
 * bindings lazily — but it is the kind of thing that stops working for
 * reasons nobody can see, so it is avoided rather than relied on.
 */

/**
 * The key a rule's `secretRef` names, scoped to its project.
 *
 * Scoped because the proxy holds one map for the whole install: an unscoped
 * name would let a project's rule name — and have injected into a host of
 * its choosing — a secret belonging to a different project. The scope costs
 * nothing, since the proxy treats the ref as an opaque key.
 */
export function proxySecretRef(projectSlug: string, name: string): string {
  return `${projectSlug}/${name}`
}

/**
 * Remove the file an older proxy read secret values from, once one that does
 * not need it is answering (docs/legacy-compat-shims.md).
 *
 * The file is a plaintext copy of every secret this install ever proxied, in
 * a directory the proxy pod mounts, so it wants deleting — but not on the
 * server's say-so alone, and not on any schedule of its own.
 *
 * Two things have to be true, and each is checked by the caller that can:
 * a proxy which has just answered the `/secrets` routes is a NEW one, so
 * nothing is still reading the file; and no project overlay still carries an
 * `envSecretProxy` key, so nothing is still waiting to be imported OUT of it
 * — a config too broken to parse is skipped by the importer, and sweeping
 * then would take values no start had yet recovered.
 */
export async function sweepLegacyProxySecretsFile(): Promise<void> {
  const file = path.join(credentialsDir(), 'proxy-secrets.json')
  try {
    await fs.rm(file, { force: true })
  } catch (err) {
    serverLog(
      '[legacy] could not remove the old proxy-secrets file: '
      + (err instanceof Error ? err.message : String(err)),
    )
  }
}
