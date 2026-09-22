import {
  isPlaceholderClaudeBundle,
  isPlaceholderCodexBundle,
  loadClaudeCredentialsFile,
  loadCodexCredentialsFile,
  loadToolCredentialBundle,
  saveClaudeOAuthBundle,
  saveCodexOAuthBundle,
} from '@yaac/shared/tool-auth'
import { listSshEntries, loadCredentials } from '#domain/projects'
import { worktreeDriver } from '#drivers/driver'
import { serverLog } from '#log'
import { claudeBundleIsNewer, codexBundleIsNewer } from './credential-sync'
import type { RefreshedToolCredentials } from '@yaac/shared/types'

/**
 * The host store's two-way link with the runtime that injects from it.
 *
 * Down: every writer of the host store — a login, a clear, a git credential
 * added or removed, a plan-usage refresh that rotated a token — calls
 * `pushCredentialsToRuntime` afterwards, and the runtime is handed the whole
 * set. Wholesale because the set is one install-wide thing, and because
 * nothing re-reads it on a schedule of its own: the store is the authority,
 * and a runtime is told.
 *
 * Up: a runtime that mediates egress captures the rotation a worktree's
 * refresh produced, and `adoptRefreshedToolCredentials` is how that reaches
 * the store — the newest-wins compare every other writer uses, then a push
 * so the runtime sees its own capture echoed and stops preferring it.
 */

async function pushOnce(): Promise<void> {
  try {
    const [tools, git, ssh] = await Promise.all([
      loadToolCredentialBundle(),
      loadCredentials(),
      listSshEntries(),
    ])
    await worktreeDriver().syncCredentials({ ...tools, git: git.tokens, ssh })
  } catch (err) {
    serverLog(`[server] credential push to the runtime failed: ${String(err)}`)
  }
}

// Latest-wins coalescing: two overlapping writers would otherwise read
// the store and hand their reads over in either order, and the runtime
// could be left behind the store until the next write. One push runs at a
// time; a request that lands while one is running is served by exactly one
// more, which reads the store after every write that asked for it.
let inflight: Promise<void> | null = null
let rerun = false

/** Hand the runtime the whole credential set, swallowing a failure: the
 *  write that prompted this already succeeded, and the next push carries
 *  the same set. Resolves once a push that read the store after this call
 *  has completed. */
export function pushCredentialsToRuntime(): Promise<void> {
  if (inflight) {
    rerun = true
    return inflight
  }
  inflight = (async () => {
    try {
      do {
        rerun = false
        await pushOnce()
      } while (rerun)
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/**
 * Adopt what the runtime captured into the host store, where it is newer.
 *
 * The same rules as every other writer: a sentinel is never a credential,
 * an api-key or signed-out store has nothing a rotation could supersede
 * (and must not be signed back in by one), and a compare-and-set guards
 * the write — the store may have moved while this read it, and the writer
 * that moved it stored something at least as fresh.
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
