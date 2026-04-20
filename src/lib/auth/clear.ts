import { saveCredentials } from '@/lib/project/credentials'
import {
  cleanupProjectClaudePlaceholders,
  cleanupProjectCodexPlaceholders,
  removeToolAuth,
} from '@/lib/project/tool-auth'
import { DaemonError } from '@/lib/daemon/errors'

export type ClearAuthTarget = 'all' | 'claude' | 'codex'

/**
 * Remove the stored credentials identified by `target`. `all` wipes
 * every GitHub token plus both tool bundles; individual tool values
 * only touch that tool's bundle + its per-project placeholders.
 *
 * GitHub token removal by pattern goes through the dedicated
 * `DELETE /auth/github/tokens/:pattern` route so this helper doesn't
 * need to care about partial-github clears.
 */
export async function clearAuth(target: ClearAuthTarget): Promise<void> {
  if (target === 'all') {
    await saveCredentials({ tokens: [] })
    await removeToolAuth('claude')
    await removeToolAuth('codex')
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
  throw new DaemonError('VALIDATION', `Unknown clear target "${String(target)}".`)
}
