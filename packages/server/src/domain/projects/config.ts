import fs from 'node:fs/promises'
import path from 'node:path'
import { AGENT_TOOLS } from '@yaac/shared/types'
import type { YaacConfig, InitCommandSpec } from '@yaac/shared/types'
import { projectConfigDir } from '@yaac/shared/project-paths'
import { worktreeDriver } from '#drivers/driver'
import { isInfraPort } from '#lib/port-policy'

const CACHE_VOLUME_KEY_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/

const KNOWN_KEYS = new Set(['cacheVolumes', 'initCommands', 'portForward', 'hideInitPane', 'addAllowedUrls', 'setAllowedUrls', 'ephemeralModulesPaths', 'nestedContainers', 'npmCache', 'referenceBranch'])

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
    if (!KNOWN_KEYS.has(key)) console.warn(`yaac-config.json: unknown field "${key}"`)
  }

  const config: YaacConfig = {}

  if (obj.cacheVolumes !== undefined) {
    if (typeof obj.cacheVolumes !== 'object' || obj.cacheVolumes === null || Array.isArray(obj.cacheVolumes)) {
      throw new Error('yaac-config.json: cacheVolumes must be an object')
    }
    const volumes = obj.cacheVolumes as Record<string, unknown>
    for (const [key, val] of Object.entries(volumes)) {
      // The key names a host dir under the project's `cache-volumes/`, which
      // the server `mkdir -p`s and mounts read-write: one naming a parent
      // (`..`) mounts some other server dir into the pod, and one naming a
      // subdir (`a/b`) puts a mount inside another the pod can swap for a
      // link. A single plain segment rules out both.
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

/**
 * Forget a finished image build and run it again now. `false` when the id
 * is unknown or its build is still running — there was nothing to retry.
 *
 * The one image-build verb that is a mediator's: the reads and the
 * dismissal are display values api asks the runtime for directly, but a
 * rebuild has to know what each owning project's config asks for, and the
 * runtime may not read config at all. The store says "no config" with
 * `null`, the contract with `undefined`; both mean all defaults. A
 * defaulted config would not fail loudly — it would rebuild a nested
 * project without its nestable layer and report success.
 */
export function retryImageBuild(id: string): boolean {
  return worktreeDriver().retryImageBuild(
    id,
    (slug) => resolveProjectConfig(slug).then((cfg) => cfg ?? undefined),
  )
}
