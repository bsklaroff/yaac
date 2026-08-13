import { serverLog } from '#log'
import type { SshCredentialEntry } from '#drivers/contract'

/**
 * The credentials the egress path needs to ask for, rather than read.
 *
 * SSH identities are user-entered credential material, so the store that
 * holds them lives above the runtime — but the three places that want them
 * are all on the runtime's own schedule, not a caller's. The proxy client
 * re-syncs as part of ATTACHING to a (re)started proxy pod, because agent
 * identities are memory-only by design and every pod replacement loses
 * them; the `proxy-reconnect` reconcile step heals a replacement the attach
 * missed; and the credential routes re-sync after a change. None of those
 * has a caller that could pass the entries in, and the first has no caller
 * at all.
 *
 * So the composition root hands the reader in once (`main` for the server,
 * the api project's cluster setup for tests) and every path calls it. The
 * import arrow still points down — this module names only the entry type,
 * which is contract vocabulary — and it is the same dependency inversion
 * `setWorktreeDriver` itself is.
 */
export interface ProxyCredentialSources {
  /** Every configured SSH remote, with its key path already expanded. */
  listSshEntries: () => Promise<SshCredentialEntry[]>
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
