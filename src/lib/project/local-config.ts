import fs from 'node:fs/promises'
import path from 'node:path'
import { projectConfigDir, projectDir } from '@/lib/project/paths'
import { parseProjectConfig } from '@/lib/project/config'
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
 * Remove the per-project config directory. No-op if absent.
 */
export async function removeProjectConfig(slug: string): Promise<void> {
  await ensureProjectExists(slug)
  await fs.rm(projectConfigDir(slug), { recursive: true, force: true })
}
