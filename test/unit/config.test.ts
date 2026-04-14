import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expandEnvVars, loadProjectConfig, parseProjectConfig, resolveProjectConfig } from '@/lib/project/config'
import { setDataDir } from '@/lib/project/paths'

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
        GITHUB_TOKEN: {
          hosts: ['api.github.com', 'github.com'],
        },
        ANTHROPIC_API_KEY: {
          hosts: ['api.anthropic.com'],
          header: 'x-api-key',
        },
      },
    }
    await fs.writeFile(path.join(tmpDir, 'yaac-config.json'), JSON.stringify(config))
    const result = await loadProjectConfig(tmpDir)
    expect(result).toEqual(config)
  })

  it('parses config with both fields', async () => {
    const config = {
      envPassthrough: ['TERM'],
      envSecretProxy: {
        GITHUB_TOKEN: {
          hosts: ['api.github.com'],
        },
      },
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
      JSON.stringify({ envSecretProxy: { GITHUB_TOKEN: 'not-an-object' } }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('envSecretProxy.GITHUB_TOKEN must be an object')
  })

  it('throws when envSecretProxy entry has both header and bodyParam', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ envSecretProxy: { MY_KEY: { hosts: ['example.com'], header: 'x-key', bodyParam: 'key' } } }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('envSecretProxy.MY_KEY cannot have both header and bodyParam')
  })

  it('throws when envSecretProxy entry has empty hosts', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ envSecretProxy: { MY_KEY: { hosts: [], header: 'x-key' } } }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('envSecretProxy.MY_KEY.hosts must be a non-empty string array')
  })

  it('parses envSecretProxy with bodyParam', async () => {
    const config = {
      envSecretProxy: {
        GITHUB_CLIENT_ID: {
          hosts: ['github.com'],
          path: '/login/oauth/*',
          bodyParam: 'client_id',
        },
      },
    }
    await fs.writeFile(path.join(tmpDir, 'yaac-config.json'), JSON.stringify(config))
    const result = await loadProjectConfig(tmpDir)
    expect(result).toEqual(config)
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

  it('parses valid config with hideInitPane', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ hideInitPane: true }),
    )
    const result = await loadProjectConfig(tmpDir)
    expect(result).toEqual({ hideInitPane: true })
  })

  it('throws on invalid hideInitPane type', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ hideInitPane: 'yes' }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('hideInitPane must be a boolean')
  })

  it('parses valid config with portForward array', async () => {
    const config = {
      portForward: [{ containerPort: 8080, hostPortStart: 9000 }],
    }
    await fs.writeFile(path.join(tmpDir, 'yaac-config.json'), JSON.stringify(config))
    const result = await loadProjectConfig(tmpDir)
    expect(result).toEqual(config)
  })

  it('parses portForward with multiple entries', async () => {
    const config = {
      portForward: [
        { containerPort: 8080, hostPortStart: 9000 },
        { containerPort: 3000, hostPortStart: 13000 },
      ],
    }
    await fs.writeFile(path.join(tmpDir, 'yaac-config.json'), JSON.stringify(config))
    const result = await loadProjectConfig(tmpDir)
    expect(result).toEqual(config)
  })

  it('throws on invalid portForward type', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ portForward: 'not-an-array' }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('portForward must be an array')
  })

  it('throws on invalid portForward entry', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ portForward: ['not-an-object'] }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('portForward[0] must be an object')
  })

  it('throws on missing portForward[].containerPort', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ portForward: [{ hostPortStart: 9000 }] }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('portForward[0].containerPort must be an integer')
  })

  it('throws on missing portForward[].hostPortStart', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ portForward: [{ containerPort: 8080 }] }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('portForward[0].hostPortStart must be an integer')
  })

  it('throws on out-of-range portForward[].containerPort', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ portForward: [{ containerPort: 70000, hostPortStart: 9000 }] }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('portForward[0].containerPort must be an integer')
  })

  it('throws on non-integer portForward[].containerPort', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ portForward: [{ containerPort: 80.5, hostPortStart: 9000 }] }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('portForward[0].containerPort must be an integer')
  })

  it('parses valid config with bindMounts', async () => {
    const config = {
      bindMounts: [
        { hostPath: '/home/user/data', containerPath: '/mnt/data', mode: 'ro' },
        { hostPath: '/opt/tools', containerPath: '/opt/tools', mode: 'rw' },
      ],
    }
    await fs.writeFile(path.join(tmpDir, 'yaac-config.json'), JSON.stringify(config))
    const result = await loadProjectConfig(tmpDir)
    expect(result).toEqual(config)
  })

  it('throws on invalid bindMounts type', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ bindMounts: 'not-an-array' }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('bindMounts must be an array')
  })

  it('throws on invalid bindMounts entry', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ bindMounts: ['not-an-object'] }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('bindMounts[0] must be an object')
  })

  it('throws on relative bindMounts hostPath', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ bindMounts: [{ hostPath: 'relative/path', containerPath: '/mnt/data' }] }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('bindMounts[0].hostPath must be an absolute path')
  })

  it('throws on relative bindMounts containerPath', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ bindMounts: [{ hostPath: '/home/user/data', containerPath: 'relative/path' }] }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('bindMounts[0].containerPath must be an absolute path')
  })

  it('throws on invalid bindMounts mode', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ bindMounts: [{ hostPath: '/home/user/data', containerPath: '/mnt/data', mode: 'yes' }] }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('bindMounts[0].mode must be "ro" or "rw"')
  })

  it('throws on missing bindMounts mode', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ bindMounts: [{ hostPath: '/home/user/data', containerPath: '/mnt/data' }] }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('bindMounts[0].mode must be "ro" or "rw"')
  })

  it('throws on missing bindMounts hostPath', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ bindMounts: [{ containerPath: '/mnt/data' }] }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('bindMounts[0].hostPath must be an absolute path')
  })

  it('throws on missing bindMounts containerPath', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ bindMounts: [{ hostPath: '/home/user/data' }] }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('bindMounts[0].containerPath must be an absolute path')
  })

  it('expands $VAR in bindMounts hostPath', async () => {
    const origHome = process.env.HOME
    process.env.HOME = '/home/testuser'
    try {
      const config = {
        bindMounts: [{ hostPath: '$HOME/datasets', containerPath: '/mnt/datasets', mode: 'ro' }],
      }
      await fs.writeFile(path.join(tmpDir, 'yaac-config.json'), JSON.stringify(config))
      const result = await loadProjectConfig(tmpDir)
      expect(result!.bindMounts).toEqual([
        { hostPath: '/home/testuser/datasets', containerPath: '/mnt/datasets', mode: 'ro' },
      ])
    } finally {
      process.env.HOME = origHome
    }
  })

  it('expands ${VAR} in bindMounts hostPath', async () => {
    process.env.YAAC_TEST_DIR = '/opt/data'
    try {
      const config = {
        bindMounts: [{ hostPath: '${YAAC_TEST_DIR}/models', containerPath: '/mnt/models', mode: 'rw' }],
      }
      await fs.writeFile(path.join(tmpDir, 'yaac-config.json'), JSON.stringify(config))
      const result = await loadProjectConfig(tmpDir)
      expect(result!.bindMounts).toEqual([
        { hostPath: '/opt/data/models', containerPath: '/mnt/models', mode: 'rw' },
      ])
    } finally {
      delete process.env.YAAC_TEST_DIR
    }
  })

  it('throws on unset env var in bindMounts hostPath', async () => {
    delete process.env.YAAC_NONEXISTENT_VAR
    const config = {
      bindMounts: [{ hostPath: '$YAAC_NONEXISTENT_VAR/data', containerPath: '/mnt/data' }],
    }
    await fs.writeFile(path.join(tmpDir, 'yaac-config.json'), JSON.stringify(config))
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow(
      'bindMounts[0].hostPath: environment variable "YAAC_NONEXISTENT_VAR" is not set',
    )
  })

  it('throws when env var expansion results in non-absolute path', async () => {
    process.env.YAAC_TEST_REL = 'relative/path'
    try {
      const config = {
        bindMounts: [{ hostPath: '$YAAC_TEST_REL/data', containerPath: '/mnt/data' }],
      }
      await fs.writeFile(path.join(tmpDir, 'yaac-config.json'), JSON.stringify(config))
      await expect(loadProjectConfig(tmpDir)).rejects.toThrow('must be an absolute path (after expanding env vars')
    } finally {
      delete process.env.YAAC_TEST_REL
    }
  })

  it('throws on pgRelay section without enabled', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ pgRelay: {} }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('pgRelay.enabled is required')
  })

  it('parses valid config with pgRelay section (all fields)', async () => {
    const config = {
      pgRelay: { enabled: true, hostPort: 5433, containerPort: 5434 },
    }
    await fs.writeFile(path.join(tmpDir, 'yaac-config.json'), JSON.stringify(config))
    const result = await loadProjectConfig(tmpDir)
    expect(result).toEqual(config)
  })

  it('parses pgRelay with enabled false', async () => {
    const config = { pgRelay: { enabled: false } }
    await fs.writeFile(path.join(tmpDir, 'yaac-config.json'), JSON.stringify(config))
    const result = await loadProjectConfig(tmpDir)
    expect(result).toEqual(config)
  })

  it('throws on invalid pgRelay type', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ pgRelay: 'not-an-object' }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('pgRelay must be an object')
  })

  it('throws on invalid pgRelay.enabled type', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ pgRelay: { enabled: 'yes' } }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('pgRelay.enabled must be a boolean')
  })

  it('throws on invalid pgRelay.hostPort', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ pgRelay: { enabled: true, hostPort: 70000 } }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('pgRelay.hostPort must be an integer between 1 and 65535')
  })

  it('throws on non-integer pgRelay.hostPort', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ pgRelay: { enabled: true, hostPort: 54.32 } }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('pgRelay.hostPort must be an integer between 1 and 65535')
  })

  it('throws on invalid pgRelay.containerPort', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ pgRelay: { enabled: true, containerPort: 0 } }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('pgRelay.containerPort must be an integer between 1 and 65535')
  })


  it('parses valid config with addAllowedUrls', async () => {
    const config = { addAllowedUrls: ['extra.example.com', '*.corp.example.com'] }
    await fs.writeFile(path.join(tmpDir, 'yaac-config.json'), JSON.stringify(config))
    const result = await loadProjectConfig(tmpDir)
    expect(result).toEqual(config)
  })

  it('parses valid config with setAllowedUrls', async () => {
    const config = { setAllowedUrls: ['*'] }
    await fs.writeFile(path.join(tmpDir, 'yaac-config.json'), JSON.stringify(config))
    const result = await loadProjectConfig(tmpDir)
    expect(result).toEqual(config)
  })

  it('parses empty addAllowedUrls array', async () => {
    const config = { addAllowedUrls: [] }
    await fs.writeFile(path.join(tmpDir, 'yaac-config.json'), JSON.stringify(config))
    const result = await loadProjectConfig(tmpDir)
    expect(result).toEqual(config)
  })

  it('parses empty setAllowedUrls array', async () => {
    const config = { setAllowedUrls: [] }
    await fs.writeFile(path.join(tmpDir, 'yaac-config.json'), JSON.stringify(config))
    const result = await loadProjectConfig(tmpDir)
    expect(result).toEqual(config)
  })

  it('throws on invalid addAllowedUrls type', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ addAllowedUrls: 'not-an-array' }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('addAllowedUrls must be a string array')
  })

  it('throws on non-string addAllowedUrls entries', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ addAllowedUrls: [123] }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('addAllowedUrls must be a string array')
  })

  it('throws on invalid setAllowedUrls type', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ setAllowedUrls: 'not-an-array' }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('setAllowedUrls must be a string array')
  })

  it('throws when both addAllowedUrls and setAllowedUrls are set', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'yaac-config.json'),
      JSON.stringify({ addAllowedUrls: ['a.com'], setAllowedUrls: ['b.com'] }),
    )
    await expect(loadProjectConfig(tmpDir)).rejects.toThrow('addAllowedUrls and setAllowedUrls are mutually exclusive')
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

describe('expandEnvVars', () => {
  it('expands $VAR syntax', () => {
    process.env.YAAC_TEST_A = '/foo'
    try {
      expect(expandEnvVars('$YAAC_TEST_A/bar')).toBe('/foo/bar')
    } finally {
      delete process.env.YAAC_TEST_A
    }
  })

  it('expands ${VAR} syntax', () => {
    process.env.YAAC_TEST_B = '/baz'
    try {
      expect(expandEnvVars('${YAAC_TEST_B}/qux')).toBe('/baz/qux')
    } finally {
      delete process.env.YAAC_TEST_B
    }
  })

  it('expands multiple variables', () => {
    process.env.YAAC_TEST_C = '/a'
    process.env.YAAC_TEST_D = 'b'
    try {
      expect(expandEnvVars('$YAAC_TEST_C/${YAAC_TEST_D}')).toBe('/a/b')
    } finally {
      delete process.env.YAAC_TEST_C
      delete process.env.YAAC_TEST_D
    }
  })

  it('returns string unchanged when no variables present', () => {
    expect(expandEnvVars('/plain/path')).toBe('/plain/path')
  })

  it('throws on unset variable', () => {
    delete process.env.YAAC_UNSET_VAR
    expect(() => expandEnvVars('$YAAC_UNSET_VAR')).toThrow('environment variable "YAAC_UNSET_VAR" is not set')
  })
})
