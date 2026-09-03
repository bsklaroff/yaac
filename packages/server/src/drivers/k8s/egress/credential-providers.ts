import { serverLog } from '#log'
import type { SshCredentialEntry } from '#drivers/contract'

/**
 * The credentials the egress path needs to ask for, rather than read.
 *
 * SSH identities and proxied secret values are user-entered credential
 * material, so the store that holds them lives above the runtime — but the
 * places that want them are all on the runtime's own schedule, not a
 * caller's. The proxy client
 * re-syncs as part of ATTACHING to a (re)started proxy pod, because agent
 * identities are memory-only by design and every pod replacement loses
 * them; the `proxy-reconnect` reconcile step heals a replacement the attach
 * missed; and the credential routes re-sync after a change. None of those
 * has a caller that could pass the entries in, and the first has no caller
 * at all.
 *
 * So the composition root hands the reader in once (`main` for the server,
 * the api project's cluster install for tests) and every path calls it. The
 * import arrow still points down — this module names only the entry type,
 * which is contract vocabulary — and it is the same dependency inversion
 * `setWorktreeDriver` itself is.
 */
export interface ProxyCredentialSources {
  /** Every configured SSH remote, with its key material. */
  listSshEntries: () => Promise<SshCredentialEntry[]>
  /**
   * Proxied secret values, for restoring a replaced proxy pod. Same shape of
   * answer as the ssh entries: `[]` means this install proxies none.
   *
   * `projectSlug` narrows it to one project, which an edit-time sync passes
   * — every value has to be DECRYPTED to be read, so asking for all of them
   * to use one project's is work with nothing behind it.
   */
  listProxySecrets: (projectSlug?: string) => Promise<Array<{
    projectSlug: string
    secrets: Record<string, string>
  }>>
  /**
   * Whether any project overlay still carries a retired `envSecretProxy`
   * key — i.e. whether the legacy import still has work to do.
   *
   * The runtime asks because it owns the moment the old secrets file can be
   * deleted, and must not delete it while a config that has not been
   * imported yet is the only place those names are written down. An overlay
   * too broken to parse is skipped by the importer, so "no start has
   * imported it" and "no start ever will" are not the same thing.
   */
  legacySecretImportPending: () => Promise<boolean>
}

let sources: ProxyCredentialSources | undefined

/** Register the readers. Called once at composition time. */
export function configureProxyCredentials(next: ProxyCredentialSources): void {
  sources = next
}

/** Forget them. For tests, which install their own per file. */
export function resetProxyCredentials(): void {
  sources = undefined
}

/**
 * The configured SSH entries, or `undefined` when nothing is registered to
 * answer.
 *
 * The two are deliberately distinguishable, and callers must treat them
 * differently. `[]` is an answer: this install has no SSH remotes, so an
 * agent holding no identities is correct and one holding stale identities
 * should be cleared. `undefined` is the ABSENCE of an answer — an entrypoint
 * that composed a runtime without wiring this — and a caller must then
 * change nothing at all. Collapsing them is what makes an unwired process
 * destructive rather than degraded: a sync that clears first and reloads
 * from `[]` wipes the identities a live proxy was using.
 *
 * Unwired never throws, so composing without this stays a legal choice for
 * an entrypoint that reaches no proxy (the api test project does). E2e
 * exercises the real wiring through the composition root, so a regression
 * there is loud where it can be seen.
 */
export async function proxySshEntries(): Promise<SshCredentialEntry[] | undefined> {
  if (!sources) {
    serverLog('[server] proxy ssh-agent: no credential source registered; leaving keys untouched')
    return undefined
  }
  return sources.listSshEntries()
}

/**
 * Every project's secret values, or `undefined` when nothing is registered
 * to answer — read exactly like {@link proxySshEntries}, and for the same
 * reason: an unwired entrypoint must leave a live proxy's secrets alone
 * rather than conclude there are none.
 */
export async function proxySecretValues(projectSlug?: string): Promise<Array<{
  projectSlug: string
  secrets: Record<string, string>
}> | undefined> {
  if (!sources) {
    serverLog('[server] proxy secrets: no source registered; leaving values untouched')
    return undefined
  }
  return sources.listProxySecrets(projectSlug)
}

/**
 * Whether the legacy env import still has anything to move. `false` when
 * nothing is registered to answer: an unwired entrypoint deletes nothing
 * either way, since {@link proxySecretValues} already returned undefined.
 */
export async function legacySecretImportPending(): Promise<boolean> {
  return sources ? sources.legacySecretImportPending() : false
}
