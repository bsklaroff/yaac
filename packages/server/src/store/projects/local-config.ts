import fs from 'node:fs/promises'
import path from 'node:path'
import { projectConfigDir, projectDir } from '@yaac/shared/project-paths'
import { parseProjectConfig, resolveProjectConfig } from './config'
import { ServerError } from '@yaac/shared/errors'
import type { YaacConfig } from '@yaac/shared/types'

async function ensureProjectExists(slug: string): Promise<void> {
  try {
    await fs.access(path.join(projectDir(slug), 'project.json'))
  } catch {
    throw new ServerError('NOT_FOUND', `project ${slug} not found`)
  }
}

/**
 * Write (or replace) the per-project config/yaac-config.json. Validates
 * the incoming config with the same parser used at load time so malformed
 * input fails at the edge.
 */
export async function writeProjectConfig(slug: string, rawConfig: unknown): Promise<YaacConfig> {
  await ensureProjectExists(slug)

  let config: YaacConfig
  try {
    config = parseProjectConfig(JSON.stringify(rawConfig))
  } catch (err) {
    throw new ServerError('VALIDATION', err instanceof Error ? err.message : String(err))
  }

  const dir = projectConfigDir(slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'yaac-config.json'),
    JSON.stringify(config, null, 2) + '\n',
  )
  return config
}

/**
 * Append a host to a config's egress allowlist, returning a new config. Adds to
 * setAllowedUrls when the project pins an exact list (preserving that full
 * override); otherwise to addAllowedUrls. De-duplicates, so re-adding the same
 * host is a no-op. Pure.
 */
export function withAllowedHost(config: YaacConfig, host: string): YaacConfig {
  const key = config.setAllowedUrls ? 'setAllowedUrls' : 'addAllowedUrls'
  const list = config[key] ?? []
  return list.includes(host) ? config : { ...config, [key]: [...list, host] }
}

/**
 * Persist a new allowed host into a project's stored config overlay so every
 * future worktree of the project inherits it. Read-modify-write of
 * config/yaac-config.json, re-validated by writeProjectConfig (which also
 * re-runs the same parse the read did, so a stored-and-reloaded overlay
 * round-trips unchanged).
 */
export async function addAllowedHostToProjectConfig(slug: string, host: string): Promise<YaacConfig> {
  let overlay: YaacConfig | null
  try {
    overlay = await resolveProjectConfig(slug)
  } catch (err) {
    throw new ServerError('VALIDATION', err instanceof Error ? err.message : String(err))
  }
  return writeProjectConfig(slug, withAllowedHost(overlay ?? {}, host))
}

/**
 * Append a container port to a config's `portForward` list, returning a new
 * config. The host port starts at the container port itself (the same default
 * a hand-written entry would usually pick). De-duplicates by containerPort,
 * so re-adding a forwarded port is a no-op. Pure.
 */
export function withPortForward(config: YaacConfig, containerPort: number): YaacConfig {
  const list = config.portForward ?? []
  if (list.some((p) => p.containerPort === containerPort)) return config
  return { ...config, portForward: [...list, { containerPort, hostPortStart: containerPort }] }
}

/**
 * Persist a new port forward into a project's stored config overlay so every
 * future worktree of the project inherits it — the `persist: true` half of the
 * webapp's "forward this port" action. Same read-modify-write as
 * addAllowedHostToProjectConfig.
 */
export async function addPortForwardToProjectConfig(
  slug: string,
  containerPort: number,
): Promise<YaacConfig> {
  let overlay: YaacConfig | null
  try {
    overlay = await resolveProjectConfig(slug)
  } catch (err) {
    throw new ServerError('VALIDATION', err instanceof Error ? err.message : String(err))
  }
  return writeProjectConfig(slug, withPortForward(overlay ?? {}, containerPort))
}

/**
 * Set (or clear, with null) a config's default reference branch, returning a
 * new config. Pure.
 */
export function withReferenceBranch(config: YaacConfig, branch: string | null): YaacConfig {
  if (branch === null) {
    const { referenceBranch: _dropped, ...rest } = config
    return rest
  }
  return { ...config, referenceBranch: branch }
}

/**
 * Persist the project's default reference branch into the stored config
 * overlay (the same read-modify-write as addAllowedHostToProjectConfig).
 * `null` clears the field, falling back to the remote default branch.
 * Branch-name shape is validated by writeProjectConfig's re-parse;
 * existence on origin is the caller's concern (the route checks it against
 * the local repo so a typo'd default fails at set time, not at the next
 * create).
 */
export async function setProjectReferenceBranch(slug: string, branch: string | null): Promise<YaacConfig> {
  let overlay: YaacConfig | null
  try {
    overlay = await resolveProjectConfig(slug)
  } catch (err) {
    throw new ServerError('VALIDATION', err instanceof Error ? err.message : String(err))
  }
  return writeProjectConfig(slug, withReferenceBranch(overlay ?? {}, branch))
}

/**
 * Read the per-project yaac-config.json as raw text ('' when absent),
 * without parsing. The editing flow needs the verbatim bytes so a
 * malformed file can be opened and repaired — the parsed read would
 * throw on exactly the files most in need of editing.
 */
export async function readProjectConfigRaw(slug: string): Promise<string> {
  await ensureProjectExists(slug)
  try {
    return await fs.readFile(path.join(projectConfigDir(slug), 'yaac-config.json'), 'utf8')
  } catch {
    return ''
  }
}

/**
 * Remove the per-project yaac-config.json. No-op if absent. Only the
 * config file — the config dir also holds the project's build dir
 * (Dockerfile.yaac + its build-context files), which clearing the JSON
 * overlay must not touch.
 */
export async function removeProjectConfig(slug: string): Promise<void> {
  await ensureProjectExists(slug)
  await fs.rm(path.join(projectConfigDir(slug), 'yaac-config.json'), { force: true })
}
