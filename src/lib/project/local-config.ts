import fs from 'node:fs/promises'
import path from 'node:path'
import { projectConfigDir, projectDir } from '@/lib/project/paths'
import { parseProjectConfig, resolveProjectConfig } from '@/lib/project/config'
import { DaemonError } from '@/daemon/errors'
import type { YaacConfig } from '@/shared/types'

async function ensureProjectExists(slug: string): Promise<void> {
  try {
    await fs.access(path.join(projectDir(slug), 'project.json'))
  } catch {
    throw new DaemonError('NOT_FOUND', `project ${slug} not found`)
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
    throw new DaemonError('VALIDATION', err instanceof Error ? err.message : String(err))
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
 * future session of the project inherits it. Read-modify-write of
 * config/yaac-config.json, re-validated by writeProjectConfig (which also
 * re-runs the same parse the read did, so a stored-and-reloaded overlay
 * round-trips unchanged).
 */
export async function addAllowedHostToProjectConfig(slug: string, host: string): Promise<YaacConfig> {
  let overlay: YaacConfig | null
  try {
    overlay = await resolveProjectConfig(slug)
  } catch (err) {
    throw new DaemonError('VALIDATION', err instanceof Error ? err.message : String(err))
  }
  return writeProjectConfig(slug, withAllowedHost(overlay ?? {}, host))
}

/**
 * Remove the per-project config directory. No-op if absent.
 */
export async function removeProjectConfig(slug: string): Promise<void> {
  await ensureProjectExists(slug)
  await fs.rm(projectConfigDir(slug), { recursive: true, force: true })
}
