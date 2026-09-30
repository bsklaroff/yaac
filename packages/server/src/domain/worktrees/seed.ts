import { AGENT_CLIS } from '@yaac/shared/types'
import { openRoot, type ConfinedRoot } from '#lib/confined-fs'

// `lastOnboardingVersion` must be >= the running CLI's version, or a newer
// onboarding flow lets the first-run wizard reappear — so it is the pinned one.
const CLAUDE_ONBOARDING_VERSION = AGENT_CLIS.claude.version

interface ClaudeJsonState {
  hasCompletedOnboarding?: boolean
  lastOnboardingVersion?: string
  customApiKeyResponses?: { approved?: string[]; rejected?: string[] }
  projects?: Record<string, { hasTrustDialogAccepted?: boolean } | undefined>
  [key: string]: unknown
}

/**
 * Ensure claude's global config exists and seed
 * claude-code's onboarding state so its first-run wizard (theme picker, then
 * the login screen) is skipped. Merges into any existing state so
 * claude-code's own keys (oauthAccount, migrations, …) survive.
 *
 * `trustedDirs` are the roots the agent will open, **as the agent sees
 * them** — which is the whole reason they are a parameter. Under a pod that
 * is the mount layout (`/workspace`, which is also the git root: every
 * checkout is a clone of its own); under containerless nothing is mounted
 * anywhere and the agent runs in the real host checkout, so that constant
 * would name a directory that does not exist. Getting it wrong is silent in the worst way: claude
 * keys this map by directory, so an unmatched entry simply sits in the file
 * looking correct while the trust dialog opens on first launch anyway.
 *
 * The map accumulates across a project's worktrees under containerless,
 * where every worktree is its own path. That is claude's own behavior for a
 * user who works in more than one checkout, and the file is merged rather
 * than rewritten, so it costs an entry per worktree and nothing else.
 */
export async function seedClaudeJson(
  claudeHome: ConfinedRoot,
  trustedDirs: readonly string[],
): Promise<void> {
  const state = await readJson(claudeHome, '.claude.json') as ClaudeJsonState
  state.hasCompletedOnboarding = true
  state.lastOnboardingVersion = CLAUDE_ONBOARDING_VERSION
  const approved = new Set([...(state.customApiKeyResponses?.approved ?? []), 'yaac-ph-api-key'])
  state.customApiKeyResponses = { approved: [...approved], rejected: state.customApiKeyResponses?.rejected ?? [] }
  const projects = { ...state.projects }
  for (const dir of trustedDirs) {
    projects[dir] = { ...projects[dir], hasTrustDialogAccepted: true }
  }
  state.projects = projects
  await claudeHome.writeAtomic('.claude.json', JSON.stringify(state, null, 2) + '\n')
}

/**
 * Seed `~/.claude/settings.json` so claude-code skips the one-time
 * "Bypass Permissions mode" warning.
 *
 * The warning asks a question yaac has already answered, on either
 * substrate: a posture is resolved per create from what the request named,
 * else the project's last choice, else the driver's default, and recorded on
 * the worktree row (docs/permission-modes.md). Under `k8s` that default is
 * bypass, because the container is the containment and a second layer of
 * prompting inside it only costs interruptions. Under `containerless` it is
 * `accept-edits`, and bypass is reached only by asking for it — which is a
 * deliberate choice about the user's own machine, made before the worktree
 * existed. Re-confirming it inside every worktree is friction either way.
 * Merges into any existing settings (e.g. the theme claude-code writes
 * itself).
 *
 * Also raises `cleanupPeriodDays` from claude-code's 30-day default to
 * 100 years: a worktree's transcripts live in its history
 * (docs/worktree-storage.md) and yaac owns their lifecycle — they go with
 * the worktree — so claude-code must never garbage-collect them on startup. (0 would disable transcript persistence entirely, not cleanup —
 * hence a large finite value.) codex and opencode need no equivalent:
 * neither expires worktrees.
 */
export async function seedClaudeSettings(claudeHome: ConfinedRoot): Promise<void> {
  const settings = await readJson(claudeHome, 'settings.json')
  settings.skipDangerousModePermissionPrompt = true
  settings.cleanupPeriodDays = 36500
  await claudeHome.writeAtomic('settings.json', JSON.stringify(settings, null, 2) + '\n')
}

/**
 * A JSON object from the claude home, or `{}` when there is none — missing,
 * invalid, over 1 MiB, or anything but a regular file (a planted link or
 * FIFO reads as missing, and the write then replaces it, never its target).
 */
async function readJson(claudeHome: ConfinedRoot, rel: string): Promise<Record<string, unknown>> {
  try {
    const raw = await claudeHome.readFile(rel, { maxBytes: 1024 * 1024 })
    const parsed: unknown = raw === null ? null : JSON.parse(raw.toString('utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

/**
 * Create each ephemeral-modules dir in the checkout before the workspace is
 * launched, and answer with the dirs as the workspace sees them — its
 * `moduleDirs`, which the runtime backs however it backs them (a pod gives
 * each its own pod-local volume; a host process leaves it in the checkout).
 *
 * The checkout is the global one, so under a pod each dir is a mount target
 * on the worktree, and pre-creating it here is what keeps the pod's runtime
 * from creating it root-owned 0700 instead. It exists before the checkout
 * runs, which `createCheckout` is built to accept.
 */
export async function prepareModuleDirs(
  worktreeDirPath: string,
  relPaths: string[],
): Promise<string[]> {
  // On a restart the checkout is full of agent-authored content, so a
  // committed `frontends -> /anywhere` would otherwise turn a plain-looking
  // `"frontends/node_modules"` into a host-side mkdir at
  // `/anywhere/node_modules`. A link that stays inside the checkout is
  // followed — the pod resolves it the same way.
  const checkout = await openRoot(worktreeDirPath, 'inside')
  for (const rel of relPaths) {
    await checkout.mkdirp(rel).catch((err: unknown) => {
      throw new Error(`ephemeralModulesPaths: "${rel}": ${err instanceof Error ? err.message : String(err)}`)
    })
  }
  return relPaths.map((rel) => `/workspace/${rel}`)
}
