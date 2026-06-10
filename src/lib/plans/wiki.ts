import fs from 'node:fs/promises'
import path from 'node:path'
import simpleGit from 'simple-git'
import {
  cloneRepo,
  ensureKnownHostsFileForCredential,
  fetchOrigin,
  getDefaultBranch,
  gitEnvForCredential,
  injectTokenIntoUrl,
  torEnv,
} from '@/lib/git'
import { resolveCredentialForUrl } from '@/lib/project/credentials'
import { repoDir, plansMirrorDir, sessionPlansDir } from '@/lib/project/paths'
import type { ResolvedGitCredential } from '@/lib/project/credentials'

/**
 * Derive the GitHub wiki remote (`<repo>.wiki.git`) from a project's
 * origin URL. Handles both HTTPS and scp-style SSH remotes; returns null
 * for URLs that already point at a wiki or that don't look like a git
 * remote at all.
 */
export function deriveWikiUrl(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim().replace(/\/+$/, '')
  if (trimmed.length === 0) return null
  if (/\.wiki(\.git)?$/.test(trimmed)) return null
  const base = trimmed.replace(/\.git$/, '')
  // Both https://host/owner/repo and git@host:owner/repo need a non-empty
  // repo segment after stripping .git.
  if (/[:/]$/.test(base)) return null
  if (/^https?:\/\//.test(base) && !/^https?:\/\/[^/]+\/[^/]/.test(base)) return null
  return `${base}.wiki.git`
}

/**
 * Wiki page filename validation. GitHub wiki page names are nearly
 * unrestricted (`hi!-c:.md` is real), so only reject what matters for
 * safety: path separators (no escaping the clone directory — `..` alone
 * can't match `*.md` without one), and the dot/underscore prefixes the
 * doc listing skips (dotfiles, wiki _Sidebar/_Footer pages).
 */
export function isValidDocPath(docPath: string): boolean {
  return /^[^/\\]+\.md$/.test(docPath)
    && !docPath.startsWith('.')
    && !docPath.startsWith('_')
    && docPath.length <= 255
}

/** Slugify a plan topic into a wiki page filename. */
export function docFileNameForTopic(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${slug || 'plan'}.md`
}

async function dirExists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false)
}

async function resolveWiki(slug: string): Promise<{
  wikiUrl: string
  credential: ResolvedGitCredential | null
}> {
  const remoteUrl = (await simpleGit(repoDir(slug)).remote(['get-url', 'origin']))?.trim()
  if (!remoteUrl) throw new Error('could not determine remote URL for this project')
  const wikiUrl = deriveWikiUrl(remoteUrl)
  if (!wikiUrl) throw new Error(`could not derive a wiki URL from "${remoteUrl}"`)
  // Local-path remotes (tests, e2e fixtures) aren't parseable as git
  // remotes — plain unauthenticated git ops are correct for those.
  let credential: ResolvedGitCredential | null = null
  try {
    credential = await resolveCredentialForUrl(wikiUrl)
  } catch { /* unparseable remote → no credential */ }
  return { wikiUrl, credential }
}

/**
 * Probe whether the project's wiki repo exists and is reachable. An empty
 * GitHub wiki has no git repo at all (the first page must be created in
 * the web UI), so a failed ls-remote means "Plan mode unavailable".
 */
async function probeWikiRemote(
  wikiUrl: string,
  credential: ResolvedGitCredential | null,
): Promise<boolean> {
  const url = credential?.kind === 'https'
    ? injectTokenIntoUrl(wikiUrl, credential.token)
    : wikiUrl
  // SSH wiki probing would need the agent/key env; HTTPS covers GitHub
  // (wiki repos accept token auth even when the project remote is SSH).
  try {
    const git = simpleGit()
    const env = torEnv()
    await (env ? git.env(env) : git).listRemote([url, 'HEAD'])
    return true
  } catch {
    return false
  }
}

export interface WikiStatus {
  available: boolean
  wikiUrl?: string
  /** Human-readable reason when unavailable. */
  reason?: string
}

// ls-remote round-trips to GitHub; cache per project for a short window so
// the webapp's polling doesn't hammer the network.
const wikiStatusCache = new Map<string, { status: WikiStatus; at: number }>()
const WIKI_STATUS_TTL_MS = 60_000

/** Test hook: drop the per-project wiki status cache. */
export function clearWikiStatusCache(): void {
  wikiStatusCache.clear()
}

export async function getWikiStatus(slug: string): Promise<WikiStatus> {
  const cached = wikiStatusCache.get(slug)
  if (cached && Date.now() - cached.at < WIKI_STATUS_TTL_MS) return cached.status

  let status: WikiStatus
  try {
    const { wikiUrl, credential } = await resolveWiki(slug)
    // An already-cloned mirror proves the wiki existed; skip the network
    // probe so Plan mode keeps working offline.
    if (await dirExists(path.join(plansMirrorDir(slug), '.git'))) {
      status = { available: true, wikiUrl }
    } else if (await probeWikiRemote(wikiUrl, credential)) {
      status = { available: true, wikiUrl }
    } else {
      status = {
        available: false,
        wikiUrl,
        reason: 'No wiki repo found. Create the first wiki page on GitHub to enable Plan mode.',
      }
    }
  } catch (err) {
    status = { available: false, reason: err instanceof Error ? err.message : String(err) }
  }
  wikiStatusCache.set(slug, { status, at: Date.now() })
  return status
}

// Serialize mirror git operations per project — concurrent pulls (or a
// pull racing the promote commit) would corrupt the working tree.
const mirrorLocks = new Map<string, Promise<unknown>>()

export async function withMirrorLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const prev = mirrorLocks.get(slug) ?? Promise.resolve()
  const next = prev.catch(() => undefined).then(fn)
  mirrorLocks.set(slug, next)
  return next
}

// Last successful mirror pull per project, for poll throttling.
const mirrorPulledAt = new Map<string, number>()

/**
 * Ensure the daemon's read-only wiki mirror exists and is current: clone
 * on first use, then fetch + hard-reset to the remote default branch
 * (the mirror is never a source of truth, so a reset can't lose work —
 * promote commits push before returning). `maxAgeMs` skips the network
 * round-trip when the last pull is recent enough (the webapp polls the
 * doc list every few seconds).
 */
export async function ensurePlansMirror(slug: string, maxAgeMs = 0): Promise<string> {
  const { wikiUrl, credential } = await resolveWiki(slug)
  const mirror = plansMirrorDir(slug)
  return withMirrorLock(slug, async () => {
    if (!await dirExists(path.join(mirror, '.git'))) {
      await fs.rm(mirror, { recursive: true, force: true })
      await cloneRepo(wikiUrl, mirror, credential)
      mirrorPulledAt.set(slug, Date.now())
      return mirror
    }
    const last = mirrorPulledAt.get(slug) ?? 0
    if (maxAgeMs > 0 && Date.now() - last < maxAgeMs) return mirror
    await fetchOrigin(mirror, credential)
    const branch = await getDefaultBranch(mirror)
    await simpleGit(mirror).raw(['reset', '--hard', `origin/${branch}`])
    mirrorPulledAt.set(slug, Date.now())
    return mirror
  })
}

/**
 * Create the per-session wiki clone that gets bind-mounted at /plans.
 * Clones locally from the mirror (instant, no network) and points origin
 * back at the real wiki so the in-container agent's push goes to GitHub.
 */
export async function clonePlansForSession(slug: string, sessionId: string): Promise<string> {
  const { wikiUrl } = await resolveWiki(slug)
  await ensurePlansMirror(slug)
  const dest = sessionPlansDir(slug, sessionId)
  if (await dirExists(path.join(dest, '.git'))) return dest
  await fs.rm(dest, { recursive: true, force: true })
  await fs.mkdir(path.dirname(dest), { recursive: true })
  await simpleGit().clone(plansMirrorDir(slug), dest)
  await simpleGit(dest).remote(['set-url', 'origin', wikiUrl])
  return dest
}

/**
 * Commit a frontmatter change in the mirror and push it to the wiki.
 * The daemon stays out of doc-content syncing (that's the agents' job),
 * but phase transitions are discrete daemon-initiated metadata edits, so
 * they happen here where the UI can rely on them landing atomically.
 */
export async function commitAndPushMirror(
  slug: string,
  filePath: string,
  message: string,
  author: { name: string; email: string },
): Promise<void> {
  const { wikiUrl, credential } = await resolveWiki(slug)
  await withMirrorLock(slug, async () => {
    const mirror = plansMirrorDir(slug)
    const git = simpleGit(mirror)
    await git.raw(['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, 'commit', '-m', message, '--', filePath])
    const branch = await getDefaultBranch(mirror)
    const pushUrl = credential?.kind === 'https'
      ? injectTokenIntoUrl(wikiUrl, credential.token)
      : wikiUrl
    const knownHosts = await ensureKnownHostsFileForCredential(credential)
    const env = gitEnvForCredential(credential, knownHosts)
    await (env ? git.env(env) : git).raw(['push', pushUrl, `HEAD:${branch}`])
  })
}
