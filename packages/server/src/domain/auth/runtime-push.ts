import {
  isPlaceholderClaudeBundle,
  isPlaceholderCodexBundle,
  loadClaudeCredentialsFile,
  loadCodexCredentialsFile,
  loadToolCredentialBundle,
  saveClaudeOAuthBundle,
  saveCodexOAuthBundle,
} from '@yaac/shared/tool-auth'
import { runtimeGitCredentials } from '#domain/projects'
import { workspaceDriver } from '#drivers/driver'
import { serverLog } from '#log'
import { claudeBundleIsNewer, codexBundleIsNewer } from './credential-sync'
import type { RefreshedToolCredentials } from '@yaac/shared/types'

/**
 * Two-way sync between the host credential store and the runtime that
 * injects from it.
 *
 * Down: every writer of the host store (login, clear, git credential
 * changes, a plan-usage refresh that rotated a token) calls
 * `pushCredentialsToRuntime`, which sends the whole set. The store is the
 * authority; nothing re-reads it on a schedule.
 *
 * Up: a runtime that mediates egress captures token rotations from a
 * workspace's refresh; `adoptRefreshedToolCredentials` stores them if newer,
 * then pushes so the runtime sees its capture echoed back.
 */

/** One push. Logs and returns any failure. */
async function pushOnce(): Promise<Error | undefined> {
  try {
    const [tools, git] = await Promise.all([
      loadToolCredentialBundle(),
      runtimeGitCredentials(),
    ])
    await workspaceDriver().syncCredentials({ ...tools, ...git })
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
 * writer stored something at least as fresh).
 */
export async function adoptRefreshedToolCredentials(
  refreshed: RefreshedToolCredentials,
): Promise<void> {
  let adopted = false
  if (refreshed.claude && !isPlaceholderClaudeBundle(refreshed.claude)) {
    const stored = await loadClaudeCredentialsFile()
    if (stored?.kind === 'oauth' && claudeBundleIsNewer(refreshed.claude, stored.claudeAiOauth)) {
      const now = await loadClaudeCredentialsFile()
      if (now?.kind === 'oauth' && now.claudeAiOauth.accessToken === stored.claudeAiOauth.accessToken) {
        await saveClaudeOAuthBundle(refreshed.claude)
        serverLog('[server] adopted a Claude OAuth rotation the egress proxy captured')
        adopted = true
      }
    }
  }
  if (refreshed.codex && !isPlaceholderCodexBundle(refreshed.codex)) {
    const stored = await loadCodexCredentialsFile()
    if (stored?.kind === 'oauth' && codexBundleIsNewer(refreshed.codex, stored.codexOauth)) {
      const now = await loadCodexCredentialsFile()
      if (now?.kind === 'oauth' && now.codexOauth.accessToken === stored.codexOauth.accessToken) {
        await saveCodexOAuthBundle(refreshed.codex)
        serverLog('[server] adopted a Codex OAuth rotation the egress proxy captured')
        adopted = true
      }
    }
  }
  if (adopted) await pushCredentialsToRuntime()
}
