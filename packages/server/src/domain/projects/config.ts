import fs from 'node:fs/promises'
import path from 'node:path'
import { AGENT_TOOLS } from '@yaac/shared/types'
import type { YaacConfig, InitCommandSpec } from '@yaac/shared/types'
import { projectConfigDir } from '@yaac/shared/project-paths'

const KNOWN_KEYS = new Set(['cacheVolumes', 'initCommands', 'portForward', 'hideInitPane', 'addAllowedUrls', 'setAllowedUrls', 'ephemeralModulesPaths', 'nestedContainers', 'referenceBranch'])

/**
 * Keys yaac used to honor, mapped to what to tell the author now. A
 * retired key is not an unknown key: the generic "unknown field" warning
 * reads like a typo, and would leave someone whose worktrees silently
 * stopped getting a feature with nothing to search for.
 */
const ENV_SETTINGS_HINT =
  'Set it under Settings → Project Config → Environment (or `yaac config edit` no '
  + 'longer carries it), where the value is stored with the server instead of '
  + "being read from the server host's own environment."

const RETIRED_KEYS: Record<string, (obj: Record<string, unknown>) => string> = {
  // The three env keys named variables whose VALUES the server read out of
  // its own process environment. That only ever worked for someone with a
  // shell on the server's machine, and not even then under `k8s`, where the
  // server is a pod holding only what its Deployment states. The startup
  // importer moves what it can find into rows; this says where the rest
  // went, for a config someone edits afterwards.
  env: () => 'yaac-config.json: "env" is no longer supported — a project\'s '
    + `environment variables are stored with the project now. ${ENV_SETTINGS_HINT}`,
  envPassthrough: () => 'yaac-config.json: "envPassthrough" is no longer supported — '
    + "a worktree's environment no longer comes from the server host's shell. "
    + `${ENV_SETTINGS_HINT}`,
  envSecretProxy: () => 'yaac-config.json: "envSecretProxy" is no longer supported — '
    + 'proxied secrets are stored with the project, encrypted, and their injection '
    + `rules with them. ${ENV_SETTINGS_HINT}`,
  // No replacement, deliberately: the key named a path on the server's
  // filesystem, which a client on another machine can neither browse nor
  // create. `cacheVolumes` covers the case it was mostly used for.
  bindMounts: () => 'yaac-config.json: "bindMounts" is no longer supported — a host '
    + 'path is not something a client of a remote server can name. Use '
    + '"cacheVolumes" for a directory that should persist across worktrees, or '
    + 'bake the contents into the project image (Settings → Docker).',
  virtualCluster: (obj) => {
    const head = 'yaac-config.json: "virtualCluster" is no longer supported — '
      + 'per-worktree virtual clusters were removed. '
    // Only claim the implication where it actually fired. Saying it for
    // `virtualCluster: false`, or where an explicit `nestedContainers`
    // already won, would describe the one thing the parser did NOT do.
    return obj.virtualCluster === true && obj.nestedContainers === undefined
      ? head + 'It still implies "nestedContainers": true, as it always did; '
        + 'set that explicitly and delete this key.'
      : head + 'Delete the key — "nestedContainers" is what gives a worktree '
        + 'its own container engine.'
  },
}

/** Default when `ephemeralModulesPaths` is unset — redirect the root
 *  node_modules only. Set to `[]` in yaac-config.json to opt out. */
export const DEFAULT_EPHEMERAL_MODULES_PATHS: readonly string[] = ['node_modules']

/**
 * Return the effective ephemeral-modules list:
 *   unset → ["node_modules"]
 *   []    → []   (feature disabled)
 *   [...] → as given
 */
export function resolveEphemeralModulesPaths(config: YaacConfig | null): string[] {
  if (!config || config.ephemeralModulesPaths === undefined) {
    return [...DEFAULT_EPHEMERAL_MODULES_PATHS]
  }
  return [...config.ephemeralModulesPaths]
}

/**
 * Derive the per-path subdirectory name under `modules/<worktreeId>/`.
 * Root "node_modules" → "root" (keeps the backing dir cleanly named
 * and avoids node_modules-inside-node_modules on disk). Nested paths
 * collapse slashes to underscores, e.g. "packages/web/node_modules" →
 * "packages_web_node_modules".
 */
export function ephemeralModulesSlotKey(relPath: string): string {
  if (relPath === 'node_modules') return 'root'
  return relPath.replace(/\//g, '_')
}

/** tmux window names tagged 'reserved' across every supported agent tool —
 *  we reject these so an `initCommands` entry can never clobber the agent
 *  pane on a worktree whose tool is set to that name. */
const RESERVED_INIT_WINDOW_NAMES: ReadonlySet<string> = new Set(
  [...AGENT_TOOLS, 'init', 'yaac'],
)

const INIT_WINDOW_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Parse the `initCommands` field. Two shapes are accepted but never mixed:
 *   - string[]              → collapses into a single `init` tmux window
 *   - InitCommandSpec[]     → one tmux window per entry (parallel execution)
 *
 * A mixed array is rejected so each worktree has a predictable window layout.
 */
export function parseInitCommands(raw: unknown): string[] | InitCommandSpec[] {
  if (!Array.isArray(raw)) {
    throw new Error('yaac-config.json: initCommands must be an array')
  }
  if (raw.length === 0) return []

  const allStrings = raw.every((v) => typeof v === 'string')
  const allObjects = raw.every((v) => isPlainObject(v))
  if (!allStrings && !allObjects) {
    throw new Error(
      'yaac-config.json: initCommands must be either a string array or an '
      + 'array of {name, commands} objects — the two forms cannot be mixed',
    )
  }

  if (allStrings) return raw

  const specs: InitCommandSpec[] = []
  const seen = new Set<string>()
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i]
    if (typeof entry.name !== 'string' || entry.name.length === 0) {
      throw new Error(`yaac-config.json: initCommands[${i}].name must be a non-empty string`)
    }
    if (!INIT_WINDOW_NAME_PATTERN.test(entry.name)) {
      throw new Error(
        `yaac-config.json: initCommands[${i}].name "${entry.name}" must match `
        + `${INIT_WINDOW_NAME_PATTERN.source} (kebab/snake, no shell or tmux target chars)`,
      )
    }
    if (RESERVED_INIT_WINDOW_NAMES.has(entry.name)) {
      throw new Error(
        `yaac-config.json: initCommands[${i}].name "${entry.name}" is reserved`,
      )
    }
    if (seen.has(entry.name)) {
      throw new Error(`yaac-config.json: initCommands[${i}].name "${entry.name}" is duplicated`)
    }
    seen.add(entry.name)
    if (
      !Array.isArray(entry.commands)
      || entry.commands.length === 0
      || !entry.commands.every((c) => typeof c === 'string' && c.length > 0)
    ) {
      throw new Error(
        `yaac-config.json: initCommands[${i}].commands must be a non-empty array of non-empty strings`,
      )
    }
    if (entry.hidePane !== undefined && typeof entry.hidePane !== 'boolean') {
      throw new Error(`yaac-config.json: initCommands[${i}].hidePane must be a boolean`)
    }
    const spec: InitCommandSpec = {
      name: entry.name,
      commands: entry.commands as string[],
    }
    if (entry.hidePane !== undefined) spec.hidePane = entry.hidePane
    specs.push(spec)
  }
  return specs
}

/**
 * Parse the `referenceBranch` field: the name of a branch on `origin`,
 * written without the `origin/` prefix. Only cheap shape checks live here —
 * existence on the remote is validated where the value is used (worktree
 * create) or set (the reference-branch route), since the parser has no
 * repo access.
 */
export function parseReferenceBranch(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('yaac-config.json: referenceBranch must be a non-empty string')
  }
  if (raw.startsWith('origin/')) {
    throw new Error(
      `yaac-config.json: referenceBranch "${raw}" must be a bare branch name — `
      + 'drop the "origin/" prefix (it would resolve to origin/origin/...)',
    )
  }
  if (/\s/.test(raw)) {
    throw new Error('yaac-config.json: referenceBranch must not contain whitespace')
  }
  if (raw.startsWith('-') || raw.includes('..')) {
    throw new Error(`yaac-config.json: referenceBranch "${raw}" is not a valid branch name`)
  }
  return raw
}

export function parseProjectConfig(raw: string): YaacConfig {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('yaac-config.json must be a JSON object')
  }

  const obj = parsed as Record<string, unknown>

  for (const key of Object.keys(obj)) {
    const retired = RETIRED_KEYS[key]
    if (retired !== undefined) {
      console.warn(retired(obj))
    } else if (!KNOWN_KEYS.has(key)) {
      console.warn(`yaac-config.json: unknown field "${key}"`)
    }
  }

  const config: YaacConfig = {}

  if (obj.cacheVolumes !== undefined) {
    if (typeof obj.cacheVolumes !== 'object' || obj.cacheVolumes === null || Array.isArray(obj.cacheVolumes)) {
      throw new Error('yaac-config.json: cacheVolumes must be an object')
    }
    const volumes = obj.cacheVolumes as Record<string, unknown>
    for (const [key, val] of Object.entries(volumes)) {
      if (typeof val !== 'string') {
        throw new Error(`yaac-config.json: cacheVolumes.${key} must be a string (absolute container path)`)
      }
      if (!val.startsWith('/')) {
        throw new Error(`yaac-config.json: cacheVolumes.${key} must be an absolute path`)
      }
    }
    config.cacheVolumes = volumes as Record<string, string>
  }

  if (obj.initCommands !== undefined) {
    config.initCommands = parseInitCommands(obj.initCommands)
  }

  if (obj.hideInitPane !== undefined) {
    if (typeof obj.hideInitPane !== 'boolean') {
      throw new Error('yaac-config.json: hideInitPane must be a boolean')
    }
    config.hideInitPane = obj.hideInitPane
  }

  if (obj.portForward !== undefined) {
    if (!Array.isArray(obj.portForward)) {
      throw new Error('yaac-config.json: portForward must be an array of {containerPort, hostPortStart} objects')
    }
    config.portForward = []
    for (let i = 0; i < obj.portForward.length; i++) {
      const entry = obj.portForward[i] as Record<string, unknown>
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new Error(`yaac-config.json: portForward[${i}] must be an object with containerPort and hostPortStart`)
      }
      if (typeof entry.containerPort !== 'number' || !Number.isInteger(entry.containerPort) || entry.containerPort < 1 || entry.containerPort > 65535) {
        throw new Error(`yaac-config.json: portForward[${i}].containerPort must be an integer between 1 and 65535`)
      }
      if (typeof entry.hostPortStart !== 'number' || !Number.isInteger(entry.hostPortStart) || entry.hostPortStart < 1 || entry.hostPortStart > 65535) {
        throw new Error(`yaac-config.json: portForward[${i}].hostPortStart must be an integer between 1 and 65535`)
      }
      config.portForward.push({ containerPort: entry.containerPort, hostPortStart: entry.hostPortStart })
    }
  }

  if (obj.addAllowedUrls !== undefined) {
    if (!Array.isArray(obj.addAllowedUrls) || !obj.addAllowedUrls.every((v) => typeof v === 'string')) {
      throw new Error('yaac-config.json: addAllowedUrls must be a string array')
    }
    config.addAllowedUrls = obj.addAllowedUrls
  }

  if (obj.setAllowedUrls !== undefined) {
    if (!Array.isArray(obj.setAllowedUrls) || !obj.setAllowedUrls.every((v) => typeof v === 'string')) {
      throw new Error('yaac-config.json: setAllowedUrls must be a string array')
    }
    config.setAllowedUrls = obj.setAllowedUrls
  }

  if (config.addAllowedUrls && config.setAllowedUrls) {
    throw new Error('yaac-config.json: addAllowedUrls and setAllowedUrls are mutually exclusive')
  }

  if (obj.nestedContainers !== undefined) {
    if (typeof obj.nestedContainers !== 'boolean') {
      throw new Error('yaac-config.json: nestedContainers must be a boolean')
    }
    config.nestedContainers = obj.nestedContainers
  }

  // The retired `virtualCluster` always implied `nestedContainers`, and the
  // in-pod engine it implied still exists. Honoring the implication is what
  // keeps an unedited config from silently losing its engine — a loss that
  // would surface much later, as `docker: not found` inside the worktree,
  // far from the config that caused it (docs/legacy-compat-shims.md). An
  // explicit `nestedContainers: false` still wins: it is the newer key and
  // the author said it outright.
  if (obj.virtualCluster === true && obj.nestedContainers === undefined) {
    config.nestedContainers = true
  }

  if (obj.ephemeralModulesPaths !== undefined) {
    if (!Array.isArray(obj.ephemeralModulesPaths) || !obj.ephemeralModulesPaths.every((v) => typeof v === 'string')) {
      throw new Error('yaac-config.json: ephemeralModulesPaths must be a string array')
    }
    const normalized: string[] = []
    for (let i = 0; i < obj.ephemeralModulesPaths.length; i++) {
      const raw = obj.ephemeralModulesPaths[i]
      if (raw.startsWith('/')) {
        throw new Error(`yaac-config.json: ephemeralModulesPaths[${i}] must be relative to /workspace (no leading slash)`)
      }
      const trimmed = raw.replace(/^\/+|\/+$/g, '')
      if (trimmed.length === 0) {
        throw new Error(`yaac-config.json: ephemeralModulesPaths[${i}] must not be empty`)
      }
      if (trimmed.split('/').some((seg) => seg === '..' || seg === '.')) {
        throw new Error(`yaac-config.json: ephemeralModulesPaths[${i}] must not contain "." or ".." segments`)
      }
      normalized.push(trimmed)
    }
    config.ephemeralModulesPaths = normalized
  }

  if (obj.referenceBranch !== undefined) {
    config.referenceBranch = parseReferenceBranch(obj.referenceBranch)
  }

  return config
}

export async function loadProjectConfig(repoPath: string): Promise<YaacConfig | null> {
  const configPath = path.join(repoPath, 'yaac-config.json')
  let raw: string
  try {
    raw = await fs.readFile(configPath, 'utf8')
  } catch {
    return null
  }
  return parseProjectConfig(raw)
}

export async function resolveProjectConfig(projectSlug: string): Promise<YaacConfig | null> {
  return loadProjectConfig(projectConfigDir(projectSlug))
}
