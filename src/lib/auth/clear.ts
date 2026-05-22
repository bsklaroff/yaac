import { saveCredentials } from '@/lib/project/credentials'
import {
  cleanupProjectClaudePlaceholders,
  cleanupProjectCodexPlaceholders,
  removeToolAuth,
} from '@/lib/project/tool-auth'
import { DaemonError } from '@/daemon/errors'

export type ClearAuthTarget = 'all' | 'claude' | 'codex' | 'opencode'

/**
 * Remove the stored credentials identified by `target`. `all` wipes
 * every git credential plus every tool bundle; individual tool values
 * only touch that tool's bundle + its per-project placeholders.
 *
 * Per-pattern git credential removal goes through the dedicated
 * `DELETE /auth/git/credentials/:pattern` route so this helper doesn't
 * need to care about partial git clears.
 *
 * opencode has no per-project placeholder files to clean up
 * (api-key auth flows through env var + proxy MITM, not a placeholder
 * bundle on disk inside the container).
 */
export async function clearAuth(target: ClearAuthTarget): Promise<void> {
  if (target === 'all') {
    await saveCredentials({ tokens: [] })
    await removeToolAuth('claude')
    await removeToolAuth('codex')
    await removeToolAuth('opencode')
    await cleanupProjectClaudePlaceholders()
    await cleanupProjectCodexPlaceholders()
    return
  }
  if (target === 'claude') {
    await removeToolAuth('claude')
    await cleanupProjectClaudePlaceholders()
    return
  }
  if (target === 'codex') {
    await removeToolAuth('codex')
    await cleanupProjectCodexPlaceholders()
    return
  }
  if (target === 'opencode') {
    await removeToolAuth('opencode')
    return
  }
  throw new DaemonError('VALIDATION', `Unknown clear target "${String(target)}".`)
}
