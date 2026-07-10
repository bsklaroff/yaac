import fs from 'node:fs/promises'
import path from 'node:path'
import { AGENT_TOOLS } from '@yaac/shared/types'
import type { YaacConfig, InitCommandSpec } from '@yaac/shared/types'
import { projectConfigDir } from '@yaac/shared/project-paths'

const KNOWN_KEYS = new Set(['envPassthrough', 'env', 'envSecretProxy', 'cacheVolumes', 'initCommands', 'portForward', 'bindMounts', 'hideInitPane', 'addAllowedUrls', 'setAllowedUrls', 'ephemeralModulesPaths', 'nestedContainers', 'virtualCluster'])

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
 * Derive the per-path subdirectory name under `modules/<sessionId>/`.
 * Root "node_modules" → "root" (keeps the symlink target cleanly named
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
 *  pane on a session whose tool is set to that name. */
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
 * A mixed array is rejected so each session has a predictable window layout.
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

/** Expand `$VAR` and `${VAR}` references in a string using `process.env`. */
export function expandEnvVars(s: string): string {
  return s.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, plain) => {
    const name = (braced ?? plain) as string
    // eslint-disable-next-line no-process-env -- user-driven $VAR expansion; name comes from the config string, not a fixed yaac var
    const value = process.env[name]
    if (value === undefined) {
      throw new Error(`environment variable "${name}" is not set`)
    }
    return value
  })
}

export function parseProjectConfig(raw: string): YaacConfig {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('yaac-config.json must be a JSON object')
  }

  const obj = parsed as Record<string, unknown>

  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.has(key)) {
      console.warn(`yaac-config.json: unknown field "${key}"`)
    }
  }

  const config: YaacConfig = {}

  if (obj.envPassthrough !== undefined) {
    if (!Array.isArray(obj.envPassthrough) || !obj.envPassthrough.every((v) => typeof v === 'string')) {
      throw new Error('yaac-config.json: envPassthrough must be a string array')
    }
    config.envPassthrough = obj.envPassthrough
  }

  if (obj.env !== undefined) {
    if (typeof obj.env !== 'object' || obj.env === null || Array.isArray(obj.env)) {
      throw new Error('yaac-config.json: env must be an object of string values')
    }
    const envObj = obj.env as Record<string, unknown>
    for (const [key, val] of Object.entries(envObj)) {
      if (typeof val !== 'string') {
        throw new Error(`yaac-config.json: env.${key} must be a string`)
      }
    }
    config.env = envObj as Record<string, string>
  }

  if (obj.envSecretProxy !== undefined) {
    if (typeof obj.envSecretProxy !== 'object' || obj.envSecretProxy === null || Array.isArray(obj.envSecretProxy)) {
      throw new Error('yaac-config.json: envSecretProxy must be an object')
    }
    const proxy = obj.envSecretProxy as Record<string, unknown>
    for (const [key, val] of Object.entries(proxy)) {
      if (typeof val !== 'object' || val === null || Array.isArray(val)) {
        throw new Error(`yaac-config.json: envSecretProxy.${key} must be an object with hosts, and either header or bodyParam`)
      }
      const rule = val as Record<string, unknown>
      if (!Array.isArray(rule.hosts) || !rule.hosts.every((v) => typeof v === 'string') || rule.hosts.length === 0) {
        throw new Error(`yaac-config.json: envSecretProxy.${key}.hosts must be a non-empty string array`)
      }
      if (rule.path !== undefined && typeof rule.path !== 'string') {
        throw new Error(`yaac-config.json: envSecretProxy.${key}.path must be a string`)
      }
      if (rule.header !== undefined && typeof rule.header !== 'string') {
        throw new Error(`yaac-config.json: envSecretProxy.${key}.header must be a string`)
      }
      if (rule.prefix !== undefined && typeof rule.prefix !== 'string') {
        throw new Error(`yaac-config.json: envSecretProxy.${key}.prefix must be a string`)
      }
      if (rule.bodyParam !== undefined && typeof rule.bodyParam !== 'string') {
        throw new Error(`yaac-config.json: envSecretProxy.${key}.bodyParam must be a string`)
      }
      if (rule.header && rule.bodyParam) {
        throw new Error(`yaac-config.json: envSecretProxy.${key} cannot have both header and bodyParam`)
      }
    }
    config.envSecretProxy = proxy as YaacConfig['envSecretProxy']
  }

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

  if (obj.bindMounts !== undefined) {
    if (!Array.isArray(obj.bindMounts)) {
      throw new Error('yaac-config.json: bindMounts must be an array of {hostPath, containerPath, mode} objects')
    }
    config.bindMounts = []
    for (let i = 0; i < obj.bindMounts.length; i++) {
      const entry = obj.bindMounts[i] as Record<string, unknown>
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new Error(`yaac-config.json: bindMounts[${i}] must be an object with hostPath and containerPath`)
      }
      if (typeof entry.hostPath !== 'string' || entry.hostPath.length === 0) {
        throw new Error(`yaac-config.json: bindMounts[${i}].hostPath must be an absolute path`)
      }
      let resolvedHostPath: string
      try {
        resolvedHostPath = expandEnvVars(entry.hostPath)
      } catch (err) {
        throw new Error(`yaac-config.json: bindMounts[${i}].hostPath: ${(err as Error).message}`)
      }
      if (!resolvedHostPath.startsWith('/')) {
        throw new Error(`yaac-config.json: bindMounts[${i}].hostPath must be an absolute path (after expanding env vars: "${resolvedHostPath}")`)
      }
      if (typeof entry.containerPath !== 'string' || !entry.containerPath.startsWith('/')) {
        throw new Error(`yaac-config.json: bindMounts[${i}].containerPath must be an absolute path`)
      }
      if (entry.mode !== 'ro' && entry.mode !== 'rw') {
        throw new Error(`yaac-config.json: bindMounts[${i}].mode must be "ro" or "rw"`)
      }
      config.bindMounts.push({
        hostPath: resolvedHostPath,
        containerPath: entry.containerPath,
        mode: entry.mode,
      })
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

  if (obj.virtualCluster !== undefined) {
    if (typeof obj.virtualCluster !== 'boolean') {
      throw new Error('yaac-config.json: virtualCluster must be a boolean')
    }
    config.virtualCluster = obj.virtualCluster
  }

  // virtualCluster implies nestedContainers: the in-pod podman is the
  // session's only build engine, so a vcluster session without it could
  // never build images for its own pods. An explicit opt-out alongside
  // virtualCluster is a contradiction — reject it rather than silently
  // picking a side.
  if (config.virtualCluster) {
    if (obj.nestedContainers === false) {
      throw new Error(
        'yaac-config.json: virtualCluster requires nestedContainers — '
        + 'remove "nestedContainers": false or disable virtualCluster',
      )
    }
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
