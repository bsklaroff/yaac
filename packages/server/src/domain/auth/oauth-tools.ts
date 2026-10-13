import {
  dropProjectClaudeKeychainItem,
  isPlaceholderClaudeBundle,
  isPlaceholderCodexBundle,
  readProjectClaudeBundle,
  readProjectCodexBundle,
  writeProjectClaudeCredentials,
  writeProjectClaudePlaceholder,
  writeProjectCodexAuth,
  writeProjectCodexPlaceholder,
} from '@yaac/shared/tool-auth'
import { getToolCredential } from '#db'
import { refreshClaudeOAuthBundle } from './claude-oauth'
import { refreshCodexOAuthBundle } from './codex-oauth'
import { saveClaudeOAuthBundle, saveCodexOAuthBundle } from './store'
import type { ClaudeOAuthBundle, CodexOAuthBundle } from '@yaac/shared/types'

/**
 * The two tools that sign in with a rotating OAuth bundle, Claude and Codex,
 * as one table, so each credential path (harvest, push, fan-out, the
 * proxy's captures, the plan-usage refresh) is written once for both.
 */
export interface OAuthTool<B extends { accessToken: string }> {
  tool: 'claude' | 'codex'
  /** The user's stored bundle; null for api-key auth or signed out. */
  stored(owner: string): Promise<B | null>
  save(owner: string, bundle: B): Promise<void>
  /** Whether `candidate` supersedes `current`. An identical access token
   *  never does, so repeated sweeps don't rewrite files. */
  isNewer(candidate: B, current: B): boolean
  /** Whether a bundle is a proxy sentinel rather than a real credential. */
  isPlaceholder(bundle: B): boolean
  /** One refresh grant upstream; null on any failure. */
  refresh(bundle: B): Promise<B | null>
  /** The bundle in a project's tool home, or null. */
  readProject(projectId: string): Promise<B | null>
  /** Write the real bundle into a project's tool home. */
  writeProject(projectId: string, bundle: B): Promise<void>
  /** Write the sentinel version, which the egress proxy swaps. */
  writeProjectPlaceholder(projectId: string, bundle: B): Promise<void>
}

export const CLAUDE: OAuthTool<ClaudeOAuthBundle> = {
  tool: 'claude',
  stored: async (owner) => {
    const f = await getToolCredential(owner, 'claude')
    return f?.kind === 'oauth' ? f.claudeAiOauth : null
  },
  save: saveClaudeOAuthBundle,
  // The later expiry wins.
  isNewer: (candidate, current) =>
    candidate.accessToken !== current.accessToken && candidate.expiresAt > current.expiresAt,
  isPlaceholder: isPlaceholderClaudeBundle,
  refresh: refreshClaudeOAuthBundle,
  readProject: readProjectClaudeBundle,
  // claude prefers the macOS Keychain item to the file, so a stale item
  // would shadow the new file. It is dropped only after the file is
  // written, so the project never has neither.
  writeProject: async (projectId, bundle) => {
    await writeProjectClaudeCredentials(projectId, bundle)
    dropProjectClaudeKeychainItem(projectId)
  },
  writeProjectPlaceholder: writeProjectClaudePlaceholder,
}

export const CODEX: OAuthTool<CodexOAuthBundle> = {
  tool: 'codex',
  stored: async (owner) => {
    const f = await getToolCredential(owner, 'codex')
    return f?.kind === 'oauth' ? f.codexOauth : null
  },
  save: saveCodexOAuthBundle,
  // `lastRefresh` (stamped by codex on every refresh) first, then expiry
  // (from the access token's JWT) for ties or an unparseable stamp.
  // `readProjectCodexBundle` ranks a file without `last_refresh` at the
  // epoch, so a missing stamp never looks newest.
  isNewer: (candidate, current) => {
    if (candidate.accessToken === current.accessToken) return false
    const a = Date.parse(candidate.lastRefresh)
    const b = Date.parse(current.lastRefresh)
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a > b
    return candidate.expiresAt > current.expiresAt
  },
  isPlaceholder: isPlaceholderCodexBundle,
  refresh: refreshCodexOAuthBundle,
  readProject: readProjectCodexBundle,
  writeProject: writeProjectCodexAuth,
  writeProjectPlaceholder: writeProjectCodexPlaceholder,
}

/**
 * Both tools, for code that runs over each. Typed over either bundle, which
 * the method signatures allow; each entry is only ever handed its own
 * tool's bundles.
 */
export const OAUTH_TOOLS: ReadonlyArray<OAuthTool<ClaudeOAuthBundle | CodexOAuthBundle>> = [CLAUDE, CODEX]

/**
 * Store the newest of `candidates` as `owner`'s bundle, if any supersedes
 * the stored one, and say whether it did. Placeholders are never adopted,
 * and an api-key or signed-out store is never overwritten (a leftover
 * project file must not sign a signed-out user back in).
 *
 * `candidates` is read after the store, and the write is a compare-and-set
 * against that first read: if another writer changed the store meanwhile,
 * it stored something at least as fresh, so the write is skipped and the
 * next sweep re-reads.
 */
export async function adoptNewest<B extends { accessToken: string }>(
  t: OAuthTool<B>,
  owner: string,
  candidates: () => Promise<Array<B | null>>,
): Promise<boolean> {
  const base = await t.stored(owner)
  if (!base) return false
  let best = base
  for (const c of await candidates()) {
    if (c && !t.isPlaceholder(c) && t.isNewer(c, best)) best = c
  }
  if (best === base || (await t.stored(owner))?.accessToken !== base.accessToken) return false
  await t.save(owner, best)
  return true
}
