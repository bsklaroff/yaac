import {
  isPlaceholderClaudeBundle,
  isPlaceholderCodexBundle,
} from '@yaac/shared/tool-auth'
import { getToolCredential, listToolCredentials } from '#db'
import { runtimeGitCredentials } from '#domain/projects'
import { workspaceDriver } from '#drivers/driver'
import { serverLog } from '#log'
import { claudeBundleIsNewer, codexBundleIsNewer } from './credential-sync'
import { credentialOwnerKey, ownerOfCredentialKey, saveClaudeOAuthBundle, saveCodexOAuthBundle } from './store'
import type { CredentialBundle } from '#drivers/contract'
import type { RefreshedToolCredentials } from '@yaac/shared/types'

/**
 * Two-way sync between the users' credential stores and the runtime that
 * injects from them.
 *
 * Down: every writer of the host store (login, clear, git credential
 * changes, a plan-usage refresh that rotated a token) calls
 * `pushCredentialsToRuntime`, which sends every user's set. The store is the
 * authority; nothing re-reads it on a schedule.
 *
 * Up: a runtime that mediates egress captures token rotations from a
 * workspace's refresh; `adoptRefreshedToolCredentials` stores them if newer,
 * then pushes so the runtime sees its capture echoed back.
 */

/** One push of every user's credentials, each under the user's owner key.
 *  Logs and returns any failure. */
async function pushOnce(): Promise<Error | undefined> {
  try {
    const [tools, git] = await Promise.all([listToolCredentials(), runtimeGitCredentials()])
    const bundles: Record<string, CredentialBundle> = {}
    for (const owner of new Set([...Object.keys(tools), ...Object.keys(git)])) {
      bundles[credentialOwnerKey(owner)] = {
        ...tools[owner] ?? { claude: null, codex: null, opencode: null, pi: null },
        ...git[owner] ?? { git: [], ssh: [] },
      }
    }
    await workspaceDriver().syncCredentials(bundles)
    return undefined
  } catch (err) {
    serverLog(`[server] credential push to the runtime failed: ${String(err)}`)
    return err instanceof Error ? err : new Error(String(err))
  }
}

// One push at a time, so overlapping writers can't deliver stale reads out
// of order. Requests during a push are served by one more push, which reads
// the store after all of them.
let inflight: Promise<Error | undefined> | null = null
let rerun = false

/** Send the runtime the whole credential set. Never rejects; resolves, once
 *  a push that read the store after this call finishes, to that push's
 *  failure, for callers that must report it. */
export function pushCredentialsToRuntime(): Promise<Error | undefined> {
  if (inflight) {
    rerun = true
    return inflight
  }
  inflight = (async () => {
    try {
      let failure: Error | undefined
      do {
        rerun = false
        failure = await pushOnce()
      } while (rerun)
      return failure
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/**
 * Store credentials the runtime captured, where newer. A placeholder is
 * never adopted; an api-key or signed-out store is not overwritten; and a
 * compare-and-set skips the write if the store changed meanwhile (that
 * writer stored something at least as fresh). Each owner key's captures
 * go to that user's store, and those a proxy older than owner keys left
 * under `''` to the built-in user's (docs/legacy-compat-shims.md).
 */
export async function adoptRefreshedToolCredentials(
  refreshed: Record<string, RefreshedToolCredentials>,
): Promise<void> {
  let adopted = false
  for (const [key, { claude, codex }] of Object.entries(refreshed)) {
    const owner = ownerOfCredentialKey(key)
    if (claude && !isPlaceholderClaudeBundle(claude)) {
      const stored = await getToolCredential(owner, 'claude')
      if (stored?.kind === 'oauth' && claudeBundleIsNewer(claude, stored.claudeAiOauth)) {
        const now = await getToolCredential(owner, 'claude')
        if (now?.kind === 'oauth' && now.claudeAiOauth.accessToken === stored.claudeAiOauth.accessToken) {
          await saveClaudeOAuthBundle(owner, claude)
          serverLog('[server] adopted a Claude OAuth rotation the egress proxy captured')
          adopted = true
        }
      }
    }
    if (codex && !isPlaceholderCodexBundle(codex)) {
      const stored = await getToolCredential(owner, 'codex')
      if (stored?.kind === 'oauth' && codexBundleIsNewer(codex, stored.codexOauth)) {
        const now = await getToolCredential(owner, 'codex')
        if (now?.kind === 'oauth' && now.codexOauth.accessToken === stored.codexOauth.accessToken) {
          await saveCodexOAuthBundle(owner, codex)
          serverLog('[server] adopted a Codex OAuth rotation the egress proxy captured')
          adopted = true
        }
      }
    }
  }
  if (adopted) await pushCredentialsToRuntime()
}
