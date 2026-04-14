import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { YaacConfig, PostgresRelayConfig } from '@/types'
import { configOverrideDir, repoDir } from '@/lib/project/paths'
import { getDefaultBranch } from '@/lib/git'

const execFileAsync = promisify(execFile)

const KNOWN_KEYS = new Set(['envPassthrough', 'envSecretProxy', 'cacheVolumes', 'initCommands', 'nestedContainers', 'portForward', 'bindMounts', 'hideInitPane', 'pgRelay', 'addAllowedUrls', 'setAllowedUrls'])

/** Expand `$VAR` and `${VAR}` references in a string using `process.env`. */
export function expandEnvVars(s: string): string {
  return s.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, plain) => {
    const name = (braced ?? plain) as string
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
    if (!Array.isArray(obj.initCommands) || !obj.initCommands.every((v) => typeof v === 'string')) {
      throw new Error('yaac-config.json: initCommands must be a string array')
    }
    config.initCommands = obj.initCommands
  }

  if (obj.nestedContainers !== undefined) {
    if (typeof obj.nestedContainers !== 'boolean') {
      throw new Error('yaac-config.json: nestedContainers must be a boolean')
    }
    config.nestedContainers = obj.nestedContainers
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

  if (obj.pgRelay !== undefined) {
    if (typeof obj.pgRelay !== 'object' || obj.pgRelay === null || Array.isArray(obj.pgRelay)) {
      throw new Error('yaac-config.json: pgRelay must be an object')
    }
    const pg = obj.pgRelay as Record<string, unknown>

    if (pg.enabled === undefined) {
      throw new Error('yaac-config.json: pgRelay.enabled is required')
    }
    if (typeof pg.enabled !== 'boolean') {
      throw new Error('yaac-config.json: pgRelay.enabled must be a boolean')
    }
    const pgConfig: PostgresRelayConfig = { enabled: pg.enabled }
    if (pg.hostPort !== undefined) {
      if (typeof pg.hostPort !== 'number' || !Number.isInteger(pg.hostPort) || pg.hostPort < 1 || pg.hostPort > 65535) {
        throw new Error('yaac-config.json: pgRelay.hostPort must be an integer between 1 and 65535')
      }
      pgConfig.hostPort = pg.hostPort
    }
    if (pg.containerPort !== undefined) {
      if (typeof pg.containerPort !== 'number' || !Number.isInteger(pg.containerPort) || pg.containerPort < 1 || pg.containerPort > 65535) {
        throw new Error('yaac-config.json: pgRelay.containerPort must be an integer between 1 and 65535')
      }
      pgConfig.containerPort = pg.containerPort
    }
    config.pgRelay = pgConfig
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

export async function loadProjectConfigFromRef(repoPath: string, ref: string): Promise<YaacConfig | null> {
  try {
    const { stdout } = await execFileAsync('git', ['show', `${ref}:yaac-config.json`], { cwd: repoPath })
    return parseProjectConfig(stdout)
  } catch {
    return null
  }
}

export async function resolveProjectConfig(projectSlug: string): Promise<YaacConfig | null> {
  const override = await loadProjectConfig(configOverrideDir(projectSlug))
  if (override) return override

  const repo = repoDir(projectSlug)
  try {
    const defaultBranch = await getDefaultBranch(repo)
    const fromRef = await loadProjectConfigFromRef(repo, `origin/${defaultBranch}`)
    if (fromRef) return fromRef
  } catch {
    // git not available or repo not initialized — fall through to filesystem
  }

  return loadProjectConfig(repo)
}

function sortKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(sortKeys)
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((obj as Record<string, unknown>)[key])
  }
  return sorted
}

export function hashConfig(config: YaacConfig): string {
  const stable = JSON.stringify(sortKeys(config))
  return crypto.createHash('sha256').update(stable).digest('hex').slice(0, 16)
}
