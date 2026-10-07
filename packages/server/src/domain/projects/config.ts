import fs from 'node:fs/promises'
import path from 'node:path'
import { AGENT_TOOLS } from '@yaac/shared/types'
import type { YaacConfig, InitCommandSpec } from '@yaac/shared/types'
import { projectConfigDir } from '@yaac/shared/project-paths'
import { isInfraPort } from '#lib/port-policy'

const CACHE_VOLUME_KEY_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/

const KNOWN_KEYS = new Set(['cacheVolumes', 'initCommands', 'portForward', 'hideInitPane', 'addAllowedUrls', 'setAllowedUrls', 'ephemeralModulesPaths', 'nestedContainers', 'npmCache'])

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

/** tmux window names an `initCommands` entry may not use, so it can't
 *  clobber an agent or yaac window. */
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
 * A mixed array is rejected so each workspace has a predictable window layout.
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

export function parseProjectConfig(raw: string): YaacConfig {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('yaac-config.json must be a JSON object')
  }

  const obj = parsed as Record<string, unknown>

  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.has(key)) console.warn(`yaac-config.json: unknown field "${key}"`)
  }

  const config: YaacConfig = {}

  if (obj.cacheVolumes !== undefined) {
    if (typeof obj.cacheVolumes !== 'object' || obj.cacheVolumes === null || Array.isArray(obj.cacheVolumes)) {
      throw new Error('yaac-config.json: cacheVolumes must be an object')
    }
    const volumes = obj.cacheVolumes as Record<string, unknown>
    for (const [key, val] of Object.entries(volumes)) {
      // The key names a host dir under `cache-volumes/`, mounted read-write.
      // A single plain segment prevents `..` (mounting another server dir)
      // and `a/b` (a mount inside one the pod could swap for a link).
      if (!CACHE_VOLUME_KEY_RE.test(key)) {
        throw new Error(
          `yaac-config.json: cacheVolumes key "${key}" must be 1-64 letters, digits, "_", "-" or "." `
          + 'and not start with "."',
        )
      }
      if (typeof val !== 'string') {
        throw new Error(`yaac-config.json: cacheVolumes.${key} must be a string (absolute container path)`)
      }
      if (!val.startsWith('/') || val === '/' || path.posix.normalize(val) !== val) {
        throw new Error(`yaac-config.json: cacheVolumes.${key} must be a normalized absolute path other than /`)
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
      if (isInfraPort(entry.containerPort)) {
        throw new Error(
          `yaac-config.json: portForward[${i}].containerPort ${entry.containerPort} is reserved for yaac's own `
          + 'in-workspace services (10250-10350)',
        )
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

  if (obj.npmCache !== undefined) {
    if (typeof obj.npmCache !== 'boolean') {
      throw new Error('yaac-config.json: npmCache must be a boolean')
    }
    config.npmCache = obj.npmCache
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

export async function resolveProjectConfig(projectId: string): Promise<YaacConfig | null> {
  return loadProjectConfig(projectConfigDir(projectId))
}
