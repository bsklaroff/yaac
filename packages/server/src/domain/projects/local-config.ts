import fs from 'node:fs/promises'
import path from 'node:path'
import { projectConfigDir } from '@yaac/shared/project-paths'
import { parseProjectConfig, resolveProjectConfig } from './config'
import { assertProjectExists } from './detail'
import { ServerError } from '@yaac/shared/errors'
import type { YaacConfig } from '@yaac/shared/types'
import { authorizeProject, type Actor } from '#domain/access'

/**
 * Write the per-project yaac-config.json, validated with the load-time
 * parser.
 */
export async function writeProjectConfig(principal: Actor, projectId: string, rawConfig: unknown): Promise<YaacConfig> {
  await assertProjectExists(projectId)
  await authorizeProject(principal, projectId)

  let config: YaacConfig
  try {
    config = parseProjectConfig(JSON.stringify(rawConfig))
  } catch (err) {
    throw new ServerError('VALIDATION', err instanceof Error ? err.message : String(err))
  }

  const dir = projectConfigDir(projectId)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'yaac-config.json'),
    JSON.stringify(config, null, 2) + '\n',
  )
  return config
}

/**
 * Return a config with `host` added to its egress allowlist: to
 * setAllowedUrls if the project pins an exact list, else to addAllowedUrls.
 * No-op if already present.
 */
export function withAllowedHost(config: YaacConfig, host: string): YaacConfig {
  const key = config.setAllowedUrls ? 'setAllowedUrls' : 'addAllowedUrls'
  const list = config[key] ?? []
  return list.includes(host) ? config : { ...config, [key]: [...list, host] }
}

/** Add an allowed host to a project's stored config, so future workspaces
 *  inherit it. */
export async function addAllowedHostToProjectConfig(
  principal: Actor,
  projectId: string,
  host: string,
): Promise<YaacConfig> {
  let overlay: YaacConfig | null
  try {
    overlay = await resolveProjectConfig(projectId)
  } catch (err) {
    throw new ServerError('VALIDATION', err instanceof Error ? err.message : String(err))
  }
  return writeProjectConfig(principal, projectId, withAllowedHost(overlay ?? {}, host))
}

/**
 * Return a config with a `portForward` entry for `containerPort`, using the
 * same number as the starting host port. No-op if already present.
 */
export function withPortForward(config: YaacConfig, containerPort: number): YaacConfig {
  const list = config.portForward ?? []
  if (list.some((p) => p.containerPort === containerPort)) return config
  return { ...config, portForward: [...list, { containerPort, hostPortStart: containerPort }] }
}

/** Add a port forward to a project's stored config, so future workspaces
 *  inherit it (the webapp's "forward this port" with `persist: true`). */
export async function addPortForwardToProjectConfig(
  principal: Actor,
  projectId: string,
  containerPort: number,
): Promise<YaacConfig> {
  let overlay: YaacConfig | null
  try {
    overlay = await resolveProjectConfig(projectId)
  } catch (err) {
    throw new ServerError('VALIDATION', err instanceof Error ? err.message : String(err))
  }
  return writeProjectConfig(principal, projectId, withPortForward(overlay ?? {}, containerPort))
}

/**
 * The per-project yaac-config.json as raw text ('' when absent), unparsed so
 * a malformed file can be opened and fixed.
 */
export async function readProjectConfigRaw(projectId: string): Promise<string> {
  await assertProjectExists(projectId)
  try {
    return await fs.readFile(path.join(projectConfigDir(projectId), 'yaac-config.json'), 'utf8')
  } catch {
    return ''
  }
}

/**
 * Remove the per-project yaac-config.json, if present. Only that file: the
 * config dir also holds the build dir.
 */
export async function removeProjectConfig(principal: Actor, projectId: string): Promise<void> {
  await assertProjectExists(projectId)
  await authorizeProject(principal, projectId)
  await fs.rm(path.join(projectConfigDir(projectId), 'yaac-config.json'), { force: true })
}
