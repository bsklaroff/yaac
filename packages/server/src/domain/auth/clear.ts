import {
  cleanupProjectClaudePlaceholders,
  cleanupProjectCodexPlaceholders,
  removeToolAuth,
} from '@yaac/shared/tool-auth'

export type ClearAuthTarget = 'all' | 'claude' | 'codex' | 'opencode' | 'pi'

/**
 * Remove the stored tool credentials for `target` (`all` or one tool),
 * including claude's and codex's per-project placeholder files. opencode and
 * pi have no placeholder files. Git credentials are deleted separately
 * (`DELETE /auth/git/credentials/:id`).
 */
export async function clearAuth(target: ClearAuthTarget): Promise<void> {
  if (target === 'all') {
    await removeToolAuth('claude')
    await removeToolAuth('codex')
    await removeToolAuth('opencode')
    await removeToolAuth('pi')
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
  // opencode or pi: no placeholders to clean.
  await removeToolAuth(target)
}
