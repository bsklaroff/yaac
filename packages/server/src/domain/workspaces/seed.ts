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
 * Seed claude's global config so the first-run wizard (theme picker, login)
 * is skipped, merging into existing state so claude's own keys survive.
 *
 * `trustedDirs` must be the paths as the agent sees them (`/workspace` in a
 * pod, the real checkout under containerless). A wrong path fails silently:
 * the trust dialog just appears, with "No, exit" preselected. Under
 * containerless the map gains one entry per workspace, and concurrent
 * creates each add theirs, so the update holds the file's lock.
 */
export async function seedClaudeJson(
  claudeHome: ConfinedRoot,
  trustedDirs: readonly string[],
): Promise<void> {
  await claudeHome.locked('.claude.json', async () => {
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
  })
}

/**
 * Seed claude's `settings.json`, merging into existing settings:
 * - Skip the one-time bypass-mode warning; the permission mode was already
 *   chosen at create (docs/permission-modes.md).
 * - Set `cleanupPeriodDays` to 100 years so claude never deletes transcripts
 *   yaac manages (docs/workspace-storage.md). 0 would disable transcripts
 *   entirely.
 */
export async function seedClaudeSettings(claudeHome: ConfinedRoot): Promise<void> {
  await claudeHome.locked('settings.json', async () => {
    const settings = await readJson(claudeHome, 'settings.json')
    settings.skipDangerousModePermissionPrompt = true
    settings.cleanupPeriodDays = 36500
    await claudeHome.writeAtomic('settings.json', JSON.stringify(settings, null, 2) + '\n')
  })
}

/**
 * A JSON object from the claude home, or `{}` if missing, invalid, over
 * 1 MiB, or not a regular file (the write then replaces a planted link
 * rather than following it).
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
 * Create each ephemeral-modules dir in the checkout before launch (so a pod
 * does not create its mount point root-owned) and return them as the
 * workspace sees them, for `moduleDirs`.
 */
export async function prepareModuleDirs(
  workspaceDirPath: string,
  relPaths: string[],
): Promise<string[]> {
  // Confined to the checkout: a committed symlink must not turn this into a
  // mkdir elsewhere on the host. Links inside the checkout are followed.
  const checkout = await openRoot(workspaceDirPath, 'inside')
  for (const rel of relPaths) {
    await checkout.mkdirp(rel).catch((err: unknown) => {
      throw new Error(`ephemeralModulesPaths: "${rel}": ${err instanceof Error ? err.message : String(err)}`)
    })
  }
  return relPaths.map((rel) => `/workspace/${rel}`)
}
