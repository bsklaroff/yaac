import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { AGENT_TOOLS } from '@yaac/shared/types'
import type { InitCommandSpec, YaacConfig } from '@yaac/shared/types'
import { projectConfigDir } from '@yaac/shared/project-paths'
import { isInfraPort } from '#lib/port-policy'

const CACHE_VOLUME_KEY_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/

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

const isPlainObject = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v)

const BOOLEAN = z.boolean({ error: 'must be a boolean' }).optional()
const PORT = z.number({ error: 'must be an integer between 1 and 65535' }).int().min(1).max(65535)

const initCommandSpecSchema = z.object({
  name: z.string({ error: 'must be a non-empty string' }).min(1)
    .regex(INIT_WINDOW_NAME_PATTERN, {
      error: (iss) => `"${String(iss.input)}" must match ${INIT_WINDOW_NAME_PATTERN.source} `
        + '(kebab/snake, no shell or tmux target chars)',
    })
    .refine((name) => !RESERVED_INIT_WINDOW_NAMES.has(name), { error: (iss) => `"${String(iss.input)}" is reserved` }),
  commands: z.custom<string[]>(
    (c) => Array.isArray(c) && c.length > 0 && c.every((cmd) => typeof cmd === 'string' && cmd.length > 0),
    { error: 'must be a non-empty array of non-empty strings' },
  ),
  hidePane: BOOLEAN,
})

const initCommandSpecsSchema = z.array(initCommandSpecSchema).superRefine((specs, ctx) => {
  const seen = new Set<string>()
  specs.forEach(({ name }, i) => {
    if (seen.has(name)) ctx.addIssue({ code: 'custom', path: [i, 'name'], message: `"${name}" is duplicated` })
    seen.add(name)
  })
})

/**
 * The `initCommands` field, in one of two shapes, never mixed so each
 * workspace has a predictable window layout:
 *   - string[]              → collapses into a single `init` tmux window
 *   - InitCommandSpec[]     → one tmux window per entry (parallel execution)
 */
const initCommandsSchema = z.array(z.unknown(), { error: 'must be an array' })
  .transform((raw, ctx): string[] | InitCommandSpec[] => {
    if (raw.every((v) => typeof v === 'string')) return raw
    if (!raw.every(isPlainObject)) {
      ctx.addIssue({
        code: 'custom',
        message: 'must be either a string array or an array of {name, commands} objects — the two forms cannot be mixed',
      })
      return z.NEVER
    }
    const specs = initCommandSpecsSchema.safeParse(raw)
    if (specs.success) return specs.data
    for (const issue of specs.error.issues) ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message })
    return z.NEVER
  })

/** One `ephemeralModulesPaths` entry, relative to /workspace, with any
 *  surrounding slashes stripped. */
const modulesPathSchema = z.string({ error: 'must be a string' })
  .refine((raw) => !raw.startsWith('/'), 'must be relative to /workspace (no leading slash)')
  .transform((raw) => raw.replace(/^\/+|\/+$/g, ''))
  .refine((p) => p.length > 0, 'must not be empty')
  .refine((p) => !p.split('/').some((seg) => seg === '..' || seg === '.'), 'must not contain "." or ".." segments')

const projectConfigSchema = z.object({
  cacheVolumes: z.record(z.string(), z.unknown(), { error: 'must be an object' }).superRefine((volumes, ctx) => {
    for (const [key, val] of Object.entries(volumes)) {
      // The key names a host dir under `cache-volumes/`, mounted read-write.
      // A single plain segment prevents `..` (mounting another server dir)
      // and `a/b` (a mount inside one the pod could swap for a link).
      if (!CACHE_VOLUME_KEY_RE.test(key)) {
        ctx.addIssue({
          code: 'custom',
          message: `key "${key}" must be 1-64 letters, digits, "_", "-" or "." and not start with "."`,
        })
      } else if (typeof val !== 'string') {
        ctx.addIssue({ code: 'custom', path: [key], message: 'must be a string (absolute container path)' })
      } else if (!val.startsWith('/') || val === '/' || path.posix.normalize(val) !== val) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'must be a normalized absolute path other than /' })
      }
    }
  }).transform((volumes) => volumes as Record<string, string>).optional(),
  initCommands: initCommandsSchema.optional(),
  hideInitPane: BOOLEAN,
  portForward: z.array(
    z.object({
      containerPort: PORT.refine((port) => !isInfraPort(port), {
        error: (iss) => `${String(iss.input)} is reserved for yaac's own in-workspace services (10250-10350)`,
      }),
      hostPortStart: PORT,
    }, { error: 'must be an object with containerPort and hostPortStart' }),
    { error: 'must be an array of {containerPort, hostPortStart} objects' },
  ).optional(),
  nestedContainers: BOOLEAN,
  npmCache: BOOLEAN,
  ephemeralModulesPaths: z.array(modulesPathSchema, { error: 'must be a string array' }).optional(),
})

/** Where an issue is, as a config key path: `initCommands[0].name`. */
function issuePath(at: PropertyKey[]): string {
  return at.map((k, i) => typeof k === 'number' ? `[${k}]` : `${i === 0 ? '' : '.'}${String(k)}`).join('')
}

/**
 * Parse a yaac-config.json. Unknown fields are warned about and dropped;
 * anything else invalid throws, naming the first bad field.
 */
export function parseProjectConfig(raw: string): YaacConfig {
  const parsed: unknown = JSON.parse(raw)
  if (!isPlainObject(parsed)) throw new Error('yaac-config.json must be a JSON object')
  for (const key of Object.keys(parsed as object)) {
    if (!Object.hasOwn(projectConfigSchema.shape, key)) console.warn(`yaac-config.json: unknown field "${key}"`)
  }
  const result = projectConfigSchema.safeParse(parsed)
  if (!result.success) {
    const [issue] = result.error.issues
    throw new Error(`yaac-config.json: ${issuePath(issue.path)} ${issue.message}`)
  }
  return result.data
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
