import fs from 'node:fs/promises'
import path from 'node:path'
import { ephemeralModulesSlotKey } from '#features/projects'

// Keep in lockstep with the @anthropic-ai/claude-code dependency: if it
// ships a newer onboarding flow, a stale value lets the first-run wizard
// reappear. `lastOnboardingVersion` must be >= the running CLI version.
const CLAUDE_ONBOARDING_VERSION = '2.1.111'

interface ClaudeJsonState {
  hasCompletedOnboarding?: boolean
  lastOnboardingVersion?: string
  customApiKeyResponses?: { approved?: string[]; rejected?: string[] }
  projects?: Record<string, { hasTrustDialogAccepted?: boolean } | undefined>
  [key: string]: unknown
}

/**
 * Ensure `~/.claude.json` exists (it is hostPath-mounted as a file) and seed
 * claude-code's onboarding state so its first-run wizard (theme picker, then
 * the login screen) is skipped. Merges into any existing state so
 * claude-code's own keys (oauthAccount, migrations, …) survive. The agent
 * runs in /workspace; /repo is the git worktree root.
 */
export async function seedClaudeJson(claudeJsonPath: string): Promise<void> {
  let state: ClaudeJsonState = {}
  try {
    state = JSON.parse(await fs.readFile(claudeJsonPath, 'utf8')) as ClaudeJsonState
  } catch {
    // missing or invalid — start fresh
  }
  state.hasCompletedOnboarding = true
  state.lastOnboardingVersion = CLAUDE_ONBOARDING_VERSION
  const approved = new Set([...(state.customApiKeyResponses?.approved ?? []), 'yaac-ph-api-key'])
  state.customApiKeyResponses = { approved: [...approved], rejected: state.customApiKeyResponses?.rejected ?? [] }
  const projects = { ...state.projects }
  for (const dir of ['/workspace', '/repo']) {
    projects[dir] = { ...projects[dir], hasTrustDialogAccepted: true }
  }
  state.projects = projects
  await fs.writeFile(claudeJsonPath, JSON.stringify(state, null, 2) + '\n')
}

/**
 * Seed `~/.claude/settings.json` so claude-code skips the one-time
 * "Bypass Permissions mode" warning. yaac runs the agent with permission
 * bypass inside a sandboxed pod — exactly the case the warning says
 * is safe — so showing it on every session is pure friction. Merges into
 * any existing settings (e.g. the theme claude-code writes itself).
 *
 * Also raises `cleanupPeriodDays` from claude-code's 30-day default to
 * 100 years: session transcripts live in the project's hostPath-mounted
 * `.claude` dir and yaac owns their lifecycle, so claude-code must never
 * garbage-collect them on startup. (0 would disable transcript
 * persistence entirely, not cleanup — hence a large finite value.)
 * codex and opencode need no equivalent: neither expires sessions.
 */
export async function seedClaudeSettings(settingsPath: string): Promise<void> {
  let settings: Record<string, unknown> = {}
  try {
    settings = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as Record<string, unknown>
  } catch {
    // missing or invalid — start fresh
  }
  settings.skipDangerousModePermissionPrompt = true
  settings.cleanupPeriodDays = 36500
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n')
}

export interface EphemeralMount {
  /** Relative path under /workspace (e.g. "node_modules"). */
  rel: string
  /** Host backing dir — the hostPath mount source. */
  hostBacking: string
  /** Absolute in-container path — the mount target. */
  containerPath: string
}

/**
 * Resolve per-session ephemeral-module mount descriptors and ensure
 * each backing directory exists on the host before the Job is created.
 *
 * Each `rel` becomes a hostPath mount from
 * `<cachedPackages>/modules/<sessionId>/<slotKey>` on host to
 * `/workspace/<rel>` inside the container. Keeping the backing dirs
 * under the same `.cached-packages` mount as the pnpm store preserves
 * hardlink affinity (same superblock → `link(2)` does not hit EXDEV),
 * and nothing lands on the host worktree.
 */
export async function prepareEphemeralMounts(
  cachedPackages: string,
  sessionId: string,
  relPaths: string[],
): Promise<EphemeralMount[]> {
  const mounts: EphemeralMount[] = []
  for (const rel of relPaths) {
    const slot = ephemeralModulesSlotKey(rel)
    const hostBacking = path.join(cachedPackages, 'modules', sessionId, slot)
    await fs.mkdir(hostBacking, { recursive: true })
    mounts.push({
      rel,
      hostBacking,
      containerPath: `/workspace/${rel}`,
    })
  }
  return mounts
}
