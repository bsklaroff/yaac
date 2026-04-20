import fs from 'node:fs/promises'
import path from 'node:path'
import { configOverrideDir, projectDir } from '@/lib/project/paths'
import { parseProjectConfig } from '@/lib/project/config'
import { DaemonError } from '@/lib/daemon/errors'
import type { YaacConfig } from '@/types'

async function ensureProjectExists(slug: string): Promise<void> {
  try {
    await fs.access(path.join(projectDir(slug), 'project.json'))
  } catch {
    throw new DaemonError('NOT_FOUND', `project ${slug} not found`)
  }
}

/**
 * Write (or replace) the per-project config-override/yaac-config.json.
 * Validates the incoming config with the same parser the repo-level
 * config goes through so malformed input fails at the edge.
 */
export async function writeConfigOverride(slug: string, rawConfig: unknown): Promise<YaacConfig> {
  await ensureProjectExists(slug)

  let config: YaacConfig
  try {
    config = parseProjectConfig(JSON.stringify(rawConfig))
  } catch (err) {
    throw new DaemonError('VALIDATION', err instanceof Error ? err.message : String(err))
  }

  const dir = configOverrideDir(slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'yaac-config.json'),
    JSON.stringify(config, null, 2) + '\n',
  )
  return config
}

/**
 * Remove the config-override directory for a project. No-op if absent.
 */
export async function removeConfigOverride(slug: string): Promise<void> {
  await ensureProjectExists(slug)
  await fs.rm(configOverrideDir(slug), { recursive: true, force: true })
}
