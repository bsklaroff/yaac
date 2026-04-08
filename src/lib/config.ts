import fs from 'node:fs/promises'
import path from 'node:path'
import type { YaacConfig } from '@/types'

const KNOWN_KEYS = new Set(['envPassthrough', 'envSecretProxy'])

export async function loadProjectConfig(repoPath: string): Promise<YaacConfig | null> {
  const configPath = path.join(repoPath, 'yaac-config.json')
  let raw: string
  try {
    raw = await fs.readFile(configPath, 'utf8')
  } catch {
    return null
  }

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
      if (!Array.isArray(val) || !val.every((v) => typeof v === 'string')) {
        throw new Error(`yaac-config.json: envSecretProxy.${key} must be a string array`)
      }
    }
    config.envSecretProxy = proxy as Record<string, string[]>
  }

  return config
}
