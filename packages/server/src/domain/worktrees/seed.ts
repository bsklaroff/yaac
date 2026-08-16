import fs from 'node:fs/promises'
import path from 'node:path'
import { ephemeralModulesSlotKey } from '#domain/projects'

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
 * Move a pre-existing `<project>/claude.json` to the path claude reads now.
 *
 * LEGACY COMPAT (docs/legacy-compat-shims.md). Worktrees used to run with no
 * `CLAUDE_CONFIG_DIR`, which put claude's global config beside the home dir
 * rather than inside it, so yaac kept it as a sibling of the claude home and
 * mounted it at `~/.claude.json`. Naming the config dir moved the file into
 * the home, and the old one is where an install that predates the change
 * still keeps its state — claude's `oauthAccount`, its own migration
 * bookkeeping, the approved-API-key list, the accepted trust roots.
 *
 * Only when the new path has nothing: the destination is authoritative the
 * moment it exists, so a re-run can never walk a newer file backwards. The
 * old file is left where it is rather than unlinked, so a downgrade still
 * finds it; nothing reads it after this, and it is small.
 */
export async function adoptLegacyClaudeJson(
  legacyPath: string,
  currentPath: string,
): Promise<void> {
  try {
    await fs.access(currentPath)
    return
  } catch {
    // Nothing there yet — the old file, if any, is still the state of record.
  }
  try {
    await fs.copyFile(legacyPath, currentPath)
  } catch {
    // No legacy file (the common case, and every fresh install): the seed
    // below writes the new one from scratch.
  }
}

/**
 * Ensure claude's global config exists and seed
 * claude-code's onboarding state so its first-run wizard (theme picker, then
 * the login screen) is skipped. Merges into any existing state so
 * claude-code's own keys (oauthAccount, migrations, …) survive.
 *
 * `trustedDirs` are the roots the agent will open, **as the agent sees
 * them** — which is the whole reason they are a parameter. Under a pod that
 * is the mount layout (`/workspace`, and `/repo` for the git worktree
 * root); under containerless nothing is mounted anywhere and the agent runs
 * in the real host checkout, so those two constants would name directories
 * that do not exist. Getting it wrong is silent in the worst way: claude
 * keys this map by directory, so an unmatched entry simply sits in the file
 * looking correct while the trust dialog opens on first launch anyway.
 *
 * The map accumulates across a project's worktrees under containerless,
 * where every worktree is its own path. That is claude's own behavior for a
 * user who works in more than one checkout, and the file is merged rather
 * than rewritten, so it costs an entry per worktree and nothing else.
 */
export async function seedClaudeJson(
  claudeJsonPath: string,
  trustedDirs: readonly string[],
): Promise<void> {
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
  for (const dir of trustedDirs) {
    projects[dir] = { ...projects[dir], hasTrustDialogAccepted: true }
  }
  state.projects = projects
  await fs.writeFile(claudeJsonPath, JSON.stringify(state, null, 2) + '\n')
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
 * 100 years: a worktree's transcripts live in the project's claude dir —
 * a mount under `k8s`, a symlink into it under `containerless` — and yaac
 * owns their lifecycle, so claude-code must never garbage-collect them on
 * startup. (0 would disable transcript persistence entirely, not cleanup —
 * hence a large finite value.) codex and opencode need no equivalent:
 * neither expires worktrees.
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
 * `mkdir -p` a mount target inside the worktree without following a link
 * out of it. On a restart the worktree is already full of agent-authored
 * content, so a committed `frontends -> /anywhere` would otherwise turn a
 * plain-looking `"frontends/node_modules"` into a host-side mkdir at
 * `/anywhere/node_modules`. A link that stays inside the worktree (a repo
 * pointing one of its own dirs at another) is left alone — the pod resolves
 * it the same way.
 */
async function mkdirMountTarget(worktreeDirPath: string, rel: string): Promise<void> {
  const root = await fs.realpath(worktreeDirPath)
  let dir = root
  for (const segment of rel.split('/')) {
    dir = path.join(dir, segment)
    try {
      await fs.mkdir(dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    const resolved = await fs.realpath(dir)
    if (resolved !== dir && !resolved.startsWith(root + path.sep)) {
      throw new Error(
        `ephemeralModulesPaths: "${rel}" leaves the worktree through a symlink at "${segment}"`,
      )
    }
    dir = resolved
  }
}

/**
 * Resolve per-worktree ephemeral-module mount descriptors and ensure both
 * ends of each mount exist on the host before the Job is created.
 *
 * Each `rel` becomes a hostPath mount from
 * `<cachedPackages>/modules/<worktreeId>/<slotKey>` on host to
 * `/workspace/<rel>` inside the container. Keeping the backing dirs
 * under the same `.cached-packages` mount as the pnpm store preserves
 * hardlink affinity (same superblock → `link(2)` does not hit EXDEV).
 *
 * The mount *target* is nested inside /workspace, which is a bind of the
 * host worktree dir — so unlike the backing dirs, it is a directory on the
 * worktree, and pre-creating it here is what keeps the pod's runtime from
 * creating it root-owned 0700 instead. It exists before the checkout runs,
 * which `addWorktree` is built to accept.
 */
export async function prepareEphemeralMounts(
  cachedPackages: string,
  worktreeId: string,
  worktreeDirPath: string,
  relPaths: string[],
): Promise<EphemeralMount[]> {
  const mounts: EphemeralMount[] = []
  for (const rel of relPaths) {
    const slot = ephemeralModulesSlotKey(rel)
    const hostBacking = path.join(cachedPackages, 'modules', worktreeId, slot)
    await fs.mkdir(hostBacking, { recursive: true })
    await mkdirMountTarget(worktreeDirPath, rel)
    mounts.push({
      rel,
      hostBacking,
      containerPath: `/workspace/${rel}`,
    })
  }
  return mounts
}
