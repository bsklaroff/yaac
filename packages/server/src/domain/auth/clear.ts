import {
  cleanupProjectClaudePlaceholders,
  cleanupProjectCodexPlaceholders,
  removeToolAuth,
} from '@yaac/shared/tool-auth'

export type ClearAuthTarget = 'all' | 'claude' | 'codex' | 'opencode' | 'pi'

/**
 * Remove the stored tool credentials identified by `target`. `all` wipes
 * every tool bundle; individual tool values only touch that tool's bundle
 * + its per-project placeholders. Git credentials are not tool sign-ins:
 * each is deleted on its own, once no project uses it
 * (`DELETE /auth/git/credentials/:id`).
 *
 * opencode and pi have no per-project placeholder files to clean up
 * (api-key auth flows through env var + proxy MITM, not a placeholder
 * bundle on disk inside the container).
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
  // Whatever is left is opencode or pi — the union has no other member, and
  // neither leaves a placeholder behind, so the bundle is the whole clear.
  await removeToolAuth(target)
}
