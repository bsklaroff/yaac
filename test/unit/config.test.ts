import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadProjectConfig, parseProjectConfig, resolveProjectConfig } from '@/lib/config'
import { setDataDir } from '@/lib/paths'

describe('loadProjectConfig', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-config-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('returns null when yaac-config.json is missing', async () => {
    const result = await loadProjectConfig(tmpDir)
    expect(result).toBeNull()
  })

  it('parses valid config with envPassthrough', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ envPassthrough: ['TERM', 'LANG'] }),
    )
    const result = await loadProjectConfig(tmpDir)
    expect(result).toEqual({ envPassthrough: ['TERM', 'LANG'] })
  })

  it('parses valid config with envSecretProxy', async () => {
    const config = {
      envSecretProxy: {
        GITHUB_TOKEN: ['api.github.com', 'github.com'],
        ANTHROPIC_API_KEY: ['api.anthropic.com'],
      },
    }
    await fs.writeFile(path.join(tmpDir, 'yaac-config.json'), JSON.stringify(config))
    const result = await loadProjectConfig(tmpDir)
    expect(result).toEqual(config)
  })

  it('parses config with both fields', async () => {
    const config = {
      envPassthrough: ['TERM'],
      envSecretProxy: { GITHUB_TOKEN: ['api.github.com'] },
    }
    await fs.writeFile(path.join(tmpDir, 'yaac-config.json'), JSON.stringify(config))
    const result = await loadProjectConfig(tmpDir)
    expect(result).toEqual(config)
  })

  it('throws on invalid envPassthrough type', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ envPassthrough: 'not-an-array' }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('envPassthrough must be a string array')
  })

  it('throws on invalid envSecretProxy type', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ envSecretProxy: 'not-an-object' }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('envSecretProxy must be an object')
  })

  it('throws on invalid envSecretProxy values', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ envSecretProxy: { GITHUB_TOKEN: 'not-an-array' } }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('envSecretProxy.GITHUB_TOKEN must be a string array')
  })

  it('parses valid config with cacheVolumes', async () => {
    const config = {
      cacheVolumes: { 'pnpm-store': '/root/.local/share/pnpm/store/v3' },
    }
    await fs.writeFile(path.join(tmpDir, 'yaac-config.json'), JSON.stringify(config))
    const result = await loadProjectConfig(tmpDir)
    expect(result).toEqual(config)
  })

  it('parses valid config with initCommands', async () => {
    const config = {
      initCommands: ['pnpm install'],
    }
    await fs.writeFile(path.join(tmpDir, 'yaac-config.json'), JSON.stringify(config))
    const result = await loadProjectConfig(tmpDir)
    expect(result).toEqual(config)
  })

  it('throws on invalid cacheVolumes type', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ cacheVolumes: 'not-an-object' }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('cacheVolumes must be an object')
  })

  it('throws on non-string cacheVolumes values', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ cacheVolumes: { store: 123 } }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('cacheVolumes.store must be a string')
  })

  it('throws on relative cacheVolumes paths', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ cacheVolumes: { store: 'relative/path' } }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('cacheVolumes.store must be an absolute path')
  })

  it('throws on invalid initCommands type', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ initCommands: 'not-an-array' }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('initCommands must be a string array')
  })

  it('parses valid config with nestedContainers', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ nestedContainers: true }),
    )
    const result = await loadProjectConfig(tmpDir)
    expect(result).toEqual({ nestedContainers: true })
  })

  it('throws on invalid nestedContainers type', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ nestedContainers: 'yes' }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('nestedContainers must be a boolean')
  })

  it('parseProjectConfig parses raw JSON string', () => {
    const result = parseProjectConfig(JSON.stringify({ nestedContainers: true, initCommands: ['echo hi'] }))
    expect(result).toEqual({ nestedContainers: true, initCommands: ['echo hi'] })
  })

  it('warns on unknown fields', async () => {
    const warns: string[] = []
    const origWarn = console.warn
    console.warn = (msg: string) => warns.push(msg)

    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ envPassthrough: [], unknownField: true }),
    )
    await loadProjectConfig(tmpDir)

    console.warn = origWarn
    expect(warns).toContain('yaac-config.json: unknown field "unknownField"')
  })
})

describe('resolveProjectConfig', () => {
  let dataDir: string
  const slug = 'test-project'

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-resolve-test-'))
    await fs.mkdir(path.join(dataDir, 'projects', slug, 'repo'), { recursive: true })
    setDataDir(dataDir)
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('returns override config when present in config-override dir', async () => {
    await fs.mkdir(path.join(dataDir, 'projects', slug, 'config-override'), { recursive: true })
    await fs.writeFile(
      path.join(dataDir, 'projects', slug, 'config-override', 'yaac-config.json'),
      JSON.stringify({ initCommands: ['echo override'] }),
    )
    await fs.writeFile(
      path.join(dataDir, 'projects', slug, 'repo', 'yaac-config.json'),
      JSON.stringify({ initCommands: ['echo repo'] }),
    )
    const result = await resolveProjectConfig(slug)
    expect(result).toEqual({ initCommands: ['echo override'] })
  })

  it('falls back to repo config when no override exists', async () => {
    await fs.writeFile(
      path.join(dataDir, 'projects', slug, 'repo', 'yaac-config.json'),
      JSON.stringify({ envPassthrough: ['FOO'] }),
    )
    const result = await resolveProjectConfig(slug)
    expect(result).toEqual({ envPassthrough: ['FOO'] })
  })

  it('returns null when neither config exists', async () => {
    const result = await resolveProjectConfig(slug)
    expect(result).toBeNull()
  })

  it('fully replaces repo config (no merging)', async () => {
    await fs.mkdir(path.join(dataDir, 'projects', slug, 'config-override'), { recursive: true })
    await fs.writeFile(
      path.join(dataDir, 'projects', slug, 'config-override', 'yaac-config.json'),
      JSON.stringify({ initCommands: ['echo override'] }),
    )
    await fs.writeFile(
      path.join(dataDir, 'projects', slug, 'repo', 'yaac-config.json'),
      JSON.stringify({ envPassthrough: ['FOO'], initCommands: ['echo repo'] }),
    )
    const result = await resolveProjectConfig(slug)
    expect(result).toEqual({ initCommands: ['echo override'] })
    expect(result?.envPassthrough).toBeUndefined()
  })

  it('validates override config the same way', async () => {
    await fs.mkdir(path.join(dataDir, 'projects', slug, 'config-override'), { recursive: true })
    await fs.writeFile(
      path.join(dataDir, 'projects', slug, 'config-override', 'yaac-config.json'),
      JSON.stringify({ envPassthrough: 'not-an-array' }),
    )
    await expect(resolveProjectConfig(slug)).rejects.toThrow('envPassthrough must be a string array')
  })
})
