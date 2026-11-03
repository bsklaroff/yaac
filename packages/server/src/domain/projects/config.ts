import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { YaacConfig } from '@yaac/shared/types'
import { projectConfigDir } from '@yaac/shared/project-paths'
import { isInfraPort } from '#lib/port-policy'

const CACHE_VOLUME_KEY_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/

const isPlainObject = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v)

const BOOLEAN = z.boolean({ error: 'must be a boolean' }).optional()
const PORT = z.number({ error: 'must be an integer between 1 and 65535' }).int().min(1).max(65535)

/** A path relative to the checkout (/workspace), with any surrounding
 *  slashes stripped: a scratch dir (`./scratch-dirs`), or a kept ignored
 *  path (`./kept-paths`). */
export const checkoutPathSchema = z.string({ error: 'must be a string' })
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
})

/** Where an issue is, as a config key path: `portForward[0].containerPort`. */
function issuePath(at: PropertyKey[]): string {
  return at.map((k, i) => typeof k === 'number' ? `[${k}]` : `${i === 0 ? '' : '.'}${String(k)}`).join('')
}

/** Where a retired field went, for the error that refuses it
 *  (docs/legacy-compat-shims.md). */
const RETIRED_FIELDS: Record<string, string> = {
  ephemeralModulesPaths: 'is now the project\'s scratch directories, set under Settings → Project Config '
    + 'or with `yaac config scratch-dirs`',
  initCommands: 'is now the project\'s init steps, set under Settings → Project Config → Init steps '
    + 'or with `yaac config init-steps`',
  hideInitPane: 'is gone: every step\'s output is kept in its log, so a finished step\'s window stays',
}

/**
 * Parse a yaac-config.json. Anything invalid throws, naming the first bad
 * field; an unknown field is invalid, so a misspelt or retired key fails
 * loudly instead of being ignored.
 */
export function parseProjectConfig(raw: string): YaacConfig {
  const parsed: unknown = JSON.parse(raw)
  if (!isPlainObject(parsed)) throw new Error('yaac-config.json must be a JSON object')
  const unknown = Object.keys(parsed as object).find((key) => !Object.hasOwn(projectConfigSchema.shape, key))
  if (unknown !== undefined && Object.hasOwn(RETIRED_FIELDS, unknown)) {
    throw new Error(`yaac-config.json: "${unknown}" ${RETIRED_FIELDS[unknown]}; remove it from this file`)
  }
  if (unknown !== undefined) {
    throw new Error(`yaac-config.json: unknown field "${unknown}"; the fields are ${Object.keys(projectConfigSchema.shape).join(', ')}`)
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
