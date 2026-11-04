/**
 * The project settings a workspace launches with besides its checkout
 * (`ProjectConfig`, docs/project-config.md): forwarded ports, cache
 * volumes, nested containers and the npm cache. Each is a column of the
 * project's row, set on a route of its own.
 */
import path from 'node:path'
import { z } from 'zod'
import { ServerError } from '@yaac/shared/errors'
import type { ProjectConfig } from '@yaac/shared/types'
import { getProjectRow, setProjectConfig } from '#db'
import { authorizeProject, type Actor } from '#domain/access'
import { isInfraPort } from '#lib/port-policy'
import { assertProjectExists } from './detail'

const CACHE_VOLUME_KEY_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/

const PORT = z.number({ error: 'must be an integer between 1 and 65535' }).int().min(1).max(65535)

/** A path relative to the checkout (/workspace), with any surrounding
 *  slashes stripped: a scratch dir (`./scratch-dirs`), or a kept ignored
 *  path (`./kept-paths`). */
export const checkoutPathSchema = z.string({ error: 'must be a string' })
  .refine((raw) => !raw.startsWith('/'), 'must be relative to /workspace (no leading slash)')
  .transform((raw) => raw.replace(/^\/+|\/+$/g, ''))
  .refine((p) => p.length > 0, 'must not be empty')
  .refine((p) => !p.split('/').some((seg) => seg === '..' || seg === '.'), 'must not contain "." or ".." segments')

/** A project's forwarded ports. A container port listed twice keeps its
 *  first entry. */
export const portForwardsSchema = z.array(
  z.object({
    containerPort: PORT.refine((port) => !isInfraPort(port), {
      error: (iss) => `${String(iss.input)} is reserved for yaac's own in-workspace services (10250-10350)`,
    }),
    hostPortStart: PORT,
  }, { error: 'must be an object with containerPort and hostPortStart' }),
  { error: 'must be an array of {containerPort, hostPortStart} objects' },
).transform((ports) => ports.filter((p, i) => ports.findIndex((q) => q.containerPort === p.containerPort) === i))

/** A project's cache volumes: name to absolute mount path. */
export const cacheVolumesSchema = z.record(z.string(), z.unknown(), { error: 'must be an object' }).superRefine((volumes, ctx) => {
  for (const [key, val] of Object.entries(volumes)) {
    // The key names a host dir under `cache-volumes/`, mounted read-write.
    // A single plain segment prevents `..` (mounting another server dir)
    // and `a/b` (a mount inside one the pod could swap for a link).
    if (!CACHE_VOLUME_KEY_RE.test(key)) {
      ctx.addIssue({
        code: 'custom',
        message: `name "${key}" must be 1-64 letters, digits, "_", "-" or "." and not start with "."`,
      })
    } else if (typeof val !== 'string') {
      ctx.addIssue({ code: 'custom', path: [key], message: 'must be a string (absolute container path)' })
    } else if (!val.startsWith('/') || val === '/' || path.posix.normalize(val) !== val) {
      ctx.addIssue({ code: 'custom', path: [key], message: 'must be a normalized absolute path other than /' })
    }
  }
}).transform((volumes) => volumes as Record<string, string>)

/** The project's settings, or undefined when there is no such project. */
export async function resolveProjectConfig(projectId: string): Promise<ProjectConfig | undefined> {
  const row = await getProjectRow(projectId)
  if (row === undefined) return undefined
  const { portForwards, cacheVolumes, nestedContainers, npmCache } = row
  return { portForwards, cacheVolumes, nestedContainers, npmCache }
}

/** Replace the settings `set` names, already validated, and answer them all
 *  as stored. They apply to workspaces created afterwards. */
export async function updateProjectConfig(
  principal: Actor,
  projectId: string,
  set: Partial<ProjectConfig>,
): Promise<ProjectConfig> {
  await assertProjectExists(projectId)
  await authorizeProject(principal, projectId)
  const stored = await setProjectConfig(projectId, set)
  if (!stored) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  return stored
}

/** Add a forward of `containerPort` at the same host port, unless the
 *  project forwards it already (the webapp's "forward this port" with
 *  `persist: true`). */
export async function addPortForward(principal: Actor, projectId: string, containerPort: number): Promise<ProjectConfig> {
  const current = await resolveProjectConfig(projectId)
  if (!current) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  if (current.portForwards.some((p) => p.containerPort === containerPort)) return current
  const portForwards = [...current.portForwards, { containerPort, hostPortStart: containerPort }]
  return updateProjectConfig(principal, projectId, { portForwards })
}
