import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ephemeralModulesSlotKey, resolveEphemeralModulesPaths, resolveProjectConfig } from '#domain/projects'
import { setDataDir, projectConfigDir } from '@yaac/shared/project-paths'
import type { YaacConfig } from '@yaac/shared/types'

const slug = 'test-project'
let dataDir: string

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-config-test-'))
  await fs.mkdir(path.join(dataDir, 'projects', slug, 'repo'), { recursive: true })
  setDataDir(dataDir)
})

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true })
})

/** Store a project's yaac-config.json verbatim — the only thing
 *  `resolveProjectConfig` reads. Takes text so malformed files are testable. */
async function storeConfig(raw: string): Promise<void> {
  const dir = projectConfigDir(slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'yaac-config.json'), raw)
}

/** Store `config` as JSON and resolve it back, so each case asserts on what a
 *  caller (session create, the prewarmer) actually gets. Also the shape a
 *  rejection case uses — `.rejects` needs the failure on the returned promise,
 *  hence the chain rather than an `await`. */
function roundTrip(config: unknown): Promise<YaacConfig | null> {
  return storeConfig(JSON.stringify(config)).then(() => resolveProjectConfig(slug))
}

describe('resolveProjectConfig', () => {
  it('returns null when the project has no stored config', async () => {
    expect(await resolveProjectConfig(slug)).toBeNull()
  })

  it('ignores a yaac-config.json checked into the cloned repo', async () => {
    // Regression guard: previously the repo working tree was a config
    // source. After the rename, only the per-project config dir is read.
    await fs.writeFile(
      path.join(dataDir, 'projects', slug, 'repo', 'yaac-config.json'),
      JSON.stringify({ envPassthrough: ['FOO'] }),
    )
    expect(await resolveProjectConfig(slug)).toBeNull()
  })

  it('rejects a file that is not a JSON object', async () => {
    await storeConfig('[]')
    await expect(resolveProjectConfig(slug)).rejects.toThrow('must be a JSON object')
    await storeConfig('"a string"')
    await expect(resolveProjectConfig(slug)).rejects.toThrow('must be a JSON object')
    await storeConfig('{ not json')
    await expect(resolveProjectConfig(slug)).rejects.toThrow()
  })

  it('warns about unknown fields but keeps the known ones', async () => {
    const warns: string[] = []
    const origWarn = console.warn
    console.warn = (msg: string) => warns.push(msg)
    try {
      expect(await roundTrip({ envPassthrough: ['TERM'], unknownField: true }))
        .toEqual({ envPassthrough: ['TERM'] })
    } finally {
      console.warn = origWarn
    }
    expect(warns).toContain('yaac-config.json: unknown field "unknownField"')
  })

  describe('env', () => {
    it('round-trips envPassthrough and env, leaving $VAR in env values literal', async () => {
      expect(await roundTrip({
        envPassthrough: ['TERM', 'LANG'],
        env: { FOO: 'bar', LITERAL: '$HOME/stuff' },
      })).toEqual({
        envPassthrough: ['TERM', 'LANG'],
        env: { FOO: 'bar', LITERAL: '$HOME/stuff' },
      })
    })

    it('rejects a malformed envPassthrough or env', async () => {
      await expect(roundTrip({ envPassthrough: 'not-an-array' }))
        .rejects.toThrow('envPassthrough must be a string array')
      await expect(roundTrip({ env: ['FOO=bar'] }))
        .rejects.toThrow('env must be an object of string values')
      await expect(roundTrip({ env: 'FOO=bar' }))
        .rejects.toThrow('env must be an object of string values')
      await expect(roundTrip({ env: { FOO: 42 } }))
        .rejects.toThrow('env.FOO must be a string')
    })
  })

  describe('envSecretProxy', () => {
    it('round-trips header, bodyParam, path, and prefix rules', async () => {
      const config = {
        envSecretProxy: {
          GITHUB_TOKEN: { hosts: ['api.github.com', 'github.com'] },
          ANTHROPIC_API_KEY: { hosts: ['api.anthropic.com'], header: 'x-api-key', prefix: 'Bearer ' },
          GITHUB_CLIENT_ID: {
            hosts: ['github.com'],
            path: '/login/oauth/*',
            bodyParam: 'client_id',
          },
        },
      }
      expect(await roundTrip(config)).toEqual(config)
    })

    it('rejects a malformed rule', async () => {
      await expect(roundTrip({ envSecretProxy: 'not-an-object' }))
        .rejects.toThrow('envSecretProxy must be an object')
      await expect(roundTrip({ envSecretProxy: { GITHUB_TOKEN: 'not-an-object' } }))
        .rejects.toThrow('envSecretProxy.GITHUB_TOKEN must be an object')
      await expect(roundTrip({ envSecretProxy: { MY_KEY: { hosts: [] } } }))
        .rejects.toThrow('envSecretProxy.MY_KEY.hosts must be a non-empty string array')
      await expect(roundTrip({ envSecretProxy: { MY_KEY: { hosts: ['a.com'], path: 5 } } }))
        .rejects.toThrow('envSecretProxy.MY_KEY.path must be a string')
      await expect(roundTrip({ envSecretProxy: { MY_KEY: { hosts: ['a.com'], header: 5 } } }))
        .rejects.toThrow('envSecretProxy.MY_KEY.header must be a string')
      await expect(roundTrip({ envSecretProxy: { MY_KEY: { hosts: ['a.com'], prefix: 5 } } }))
        .rejects.toThrow('envSecretProxy.MY_KEY.prefix must be a string')
      await expect(roundTrip({ envSecretProxy: { MY_KEY: { hosts: ['a.com'], bodyParam: 5 } } }))
        .rejects.toThrow('envSecretProxy.MY_KEY.bodyParam must be a string')
      await expect(roundTrip({
        envSecretProxy: { MY_KEY: { hosts: ['a.com'], header: 'x-key', bodyParam: 'key' } },
      })).rejects.toThrow('envSecretProxy.MY_KEY cannot have both header and bodyParam')
    })
  })

  describe('cacheVolumes', () => {
    it('round-trips a name → absolute container path map', async () => {
      const config = { cacheVolumes: { 'pnpm-store': '/root/.local/share/pnpm/store/v3' } }
      expect(await roundTrip(config)).toEqual(config)
    })

    it('rejects non-object, non-string, and relative values', async () => {
      await expect(roundTrip({ cacheVolumes: 'not-an-object' }))
        .rejects.toThrow('cacheVolumes must be an object')
      await expect(roundTrip({ cacheVolumes: { store: 123 } }))
        .rejects.toThrow('cacheVolumes.store must be a string')
      await expect(roundTrip({ cacheVolumes: { store: 'relative/path' } }))
        .rejects.toThrow('cacheVolumes.store must be an absolute path')
    })
  })

  describe('initCommands', () => {
    it('round-trips the string form and the one-window-per-entry object form', async () => {
      expect(await roundTrip({ initCommands: ['pnpm install', 'pnpm build'] }))
        .toEqual({ initCommands: ['pnpm install', 'pnpm build'] })
      expect(await roundTrip({ initCommands: [] })).toEqual({ initCommands: [] })

      const objectForm = {
        initCommands: [
          { name: 'backend', commands: ['pnpm dev:backend'] },
          { name: 'frontend', commands: ['pnpm dev:frontend'], hidePane: true },
        ],
      }
      expect(await roundTrip(objectForm)).toEqual(objectForm)
    })

    it('drops an omitted hidePane rather than defaulting it', async () => {
      expect(await roundTrip({
        initCommands: [
          { name: 'backend', commands: ['pnpm dev:backend'] },
          { name: 'frontend', commands: ['pnpm dev:frontend'], hidePane: false },
        ],
      })).toEqual({
        initCommands: [
          { name: 'backend', commands: ['pnpm dev:backend'] },
          { name: 'frontend', commands: ['pnpm dev:frontend'], hidePane: false },
        ],
      })
    })

    it('rejects a non-array or a mix of the two forms', async () => {
      await expect(roundTrip({ initCommands: 'not-an-array' }))
        .rejects.toThrow('initCommands must be an array')
      await expect(roundTrip({ initCommands: ['pnpm install', { name: 'be', commands: ['x'] }] }))
        .rejects.toThrow('cannot be mixed')
    })

    it('rejects window names that could clobber an agent pane or a tmux target', async () => {
      await expect(roundTrip({ initCommands: [{ commands: ['x'] }] }))
        .rejects.toThrow(/initCommands\[0\]\.name/)
      for (const reserved of ['claude', 'codex', 'opencode', 'pi', 'init', 'yaac']) {
        await expect(roundTrip({ initCommands: [{ name: reserved, commands: ['x'] }] }))
          .rejects.toThrow(`"${reserved}" is reserved`)
      }
      for (const bad of ['be:1', 'be.1', 'with space', '-lead']) {
        await expect(roundTrip({ initCommands: [{ name: bad, commands: ['x'] }] }))
          .rejects.toThrow(/must match/)
      }
      await expect(roundTrip({
        initCommands: [{ name: 'be', commands: ['a'] }, { name: 'be', commands: ['b'] }],
      })).rejects.toThrow('"be" is duplicated')
    })

    it('rejects an empty or non-string commands list and a non-boolean hidePane', async () => {
      await expect(roundTrip({ initCommands: [{ name: 'be', commands: [] }] }))
        .rejects.toThrow(/commands must be a non-empty array/)
      await expect(roundTrip({ initCommands: [{ name: 'be', commands: ['ok', 42] }] }))
        .rejects.toThrow(/commands must be a non-empty array/)
      await expect(roundTrip({ initCommands: [{ name: 'be', commands: ['x'], hidePane: 'yes' }] }))
        .rejects.toThrow(/hidePane must be a boolean/)
    })
  })

  describe('bindMounts', () => {
    it('round-trips absolute host/container paths with a mode', async () => {
      const config = {
        bindMounts: [
          { hostPath: '/home/user/data', containerPath: '/mnt/data', mode: 'ro' },
          { hostPath: '/opt/tools', containerPath: '/opt/tools', mode: 'rw' },
        ],
      }
      expect(await roundTrip(config)).toEqual(config)
    })

    it('expands $VAR and ${VAR} in hostPath', async () => {
      process.env.YAAC_TEST_DIR = '/opt/data'
      const origHome = process.env.HOME
      process.env.HOME = '/home/testuser'
      try {
        const result = await roundTrip({
          bindMounts: [
            { hostPath: '$HOME/datasets', containerPath: '/mnt/datasets', mode: 'ro' },
            { hostPath: '${YAAC_TEST_DIR}/models', containerPath: '/mnt/models', mode: 'rw' },
            { hostPath: '$YAAC_TEST_DIR/${YAAC_TEST_DIR}', containerPath: '/mnt/both', mode: 'ro' },
            { hostPath: '/plain/path', containerPath: '/mnt/plain', mode: 'ro' },
          ],
        })
        expect(result?.bindMounts?.map((m) => m.hostPath)).toEqual([
          '/home/testuser/datasets',
          '/opt/data/models',
          '/opt/data//opt/data',
          '/plain/path',
        ])
      } finally {
        process.env.HOME = origHome
        delete process.env.YAAC_TEST_DIR
      }
    })

    it('rejects an unset variable, and a path still relative after expansion', async () => {
      delete process.env.YAAC_NONEXISTENT_VAR
      await expect(roundTrip({
        bindMounts: [{ hostPath: '$YAAC_NONEXISTENT_VAR/data', containerPath: '/mnt/data' }],
      })).rejects.toThrow(
        'bindMounts[0].hostPath: environment variable "YAAC_NONEXISTENT_VAR" is not set',
      )

      process.env.YAAC_TEST_REL = 'relative/path'
      try {
        await expect(roundTrip({
          bindMounts: [{ hostPath: '$YAAC_TEST_REL/data', containerPath: '/mnt/data' }],
        })).rejects.toThrow('must be an absolute path (after expanding env vars')
      } finally {
        delete process.env.YAAC_TEST_REL
      }
    })

    it('rejects malformed entries and relative or missing paths', async () => {
      await expect(roundTrip({ bindMounts: 'not-an-array' }))
        .rejects.toThrow('bindMounts must be an array')
      await expect(roundTrip({ bindMounts: ['not-an-object'] }))
        .rejects.toThrow('bindMounts[0] must be an object')
      await expect(roundTrip({ bindMounts: [{ hostPath: 'relative/path', containerPath: '/mnt/data' }] }))
        .rejects.toThrow('bindMounts[0].hostPath must be an absolute path')
      await expect(roundTrip({ bindMounts: [{ containerPath: '/mnt/data' }] }))
        .rejects.toThrow('bindMounts[0].hostPath must be an absolute path')
      await expect(roundTrip({ bindMounts: [{ hostPath: '/home/user/data', containerPath: 'rel' }] }))
        .rejects.toThrow('bindMounts[0].containerPath must be an absolute path')
      await expect(roundTrip({ bindMounts: [{ hostPath: '/home/user/data' }] }))
        .rejects.toThrow('bindMounts[0].containerPath must be an absolute path')
    })

    it('requires an explicit ro/rw mode', async () => {
      await expect(roundTrip({
        bindMounts: [{ hostPath: '/home/user/data', containerPath: '/mnt/data', mode: 'yes' }],
      })).rejects.toThrow('bindMounts[0].mode must be "ro" or "rw"')
      await expect(roundTrip({
        bindMounts: [{ hostPath: '/home/user/data', containerPath: '/mnt/data' }],
      })).rejects.toThrow('bindMounts[0].mode must be "ro" or "rw"')
    })
  })

  describe('portForward', () => {
    it('round-trips a list of container/host port pairs', async () => {
      const config = {
        portForward: [
          { containerPort: 8080, hostPortStart: 9000 },
          { containerPort: 3000, hostPortStart: 13000 },
        ],
      }
      expect(await roundTrip(config)).toEqual(config)
    })

    it('rejects malformed entries and out-of-range or non-integer ports', async () => {
      await expect(roundTrip({ portForward: 'not-an-array' }))
        .rejects.toThrow('portForward must be an array')
      await expect(roundTrip({ portForward: ['not-an-object'] }))
        .rejects.toThrow('portForward[0] must be an object')
      await expect(roundTrip({ portForward: [{ hostPortStart: 9000 }] }))
        .rejects.toThrow('portForward[0].containerPort must be an integer')
      await expect(roundTrip({ portForward: [{ containerPort: 8080 }] }))
        .rejects.toThrow('portForward[0].hostPortStart must be an integer')
      await expect(roundTrip({ portForward: [{ containerPort: 70000, hostPortStart: 9000 }] }))
        .rejects.toThrow('portForward[0].containerPort must be an integer')
      await expect(roundTrip({ portForward: [{ containerPort: 80.5, hostPortStart: 9000 }] }))
        .rejects.toThrow('portForward[0].containerPort must be an integer')
      await expect(roundTrip({ portForward: [{ containerPort: 8080, hostPortStart: 70000 }] }))
        .rejects.toThrow('portForward[0].hostPortStart must be an integer')
    })
  })

  describe('egress allowlists', () => {
    it('round-trips addAllowedUrls and setAllowedUrls, including empty lists', async () => {
      expect(await roundTrip({ addAllowedUrls: ['extra.example.com', '*.corp.example.com'] }))
        .toEqual({ addAllowedUrls: ['extra.example.com', '*.corp.example.com'] })
      expect(await roundTrip({ setAllowedUrls: ['*'] })).toEqual({ setAllowedUrls: ['*'] })
      expect(await roundTrip({ addAllowedUrls: [] })).toEqual({ addAllowedUrls: [] })
      expect(await roundTrip({ setAllowedUrls: [] })).toEqual({ setAllowedUrls: [] })
    })

    it('rejects non-string-array values and the two lists together', async () => {
      await expect(roundTrip({ addAllowedUrls: 'not-an-array' }))
        .rejects.toThrow('addAllowedUrls must be a string array')
      await expect(roundTrip({ addAllowedUrls: [123] }))
        .rejects.toThrow('addAllowedUrls must be a string array')
      await expect(roundTrip({ setAllowedUrls: 'not-an-array' }))
        .rejects.toThrow('setAllowedUrls must be a string array')
      await expect(roundTrip({ addAllowedUrls: ['a.com'], setAllowedUrls: ['b.com'] }))
        .rejects.toThrow('addAllowedUrls and setAllowedUrls are mutually exclusive')
    })
  })

  describe('nestedContainers / virtualCluster', () => {
    it('round-trips both booleans, and virtualCluster implies nestedContainers', async () => {
      expect(await roundTrip({ nestedContainers: true })).toEqual({ nestedContainers: true })
      expect(await roundTrip({ nestedContainers: false })).toEqual({ nestedContainers: false })
      expect(await roundTrip({ virtualCluster: false })).toEqual({ virtualCluster: false })
      expect(await roundTrip({ virtualCluster: true }))
        .toEqual({ virtualCluster: true, nestedContainers: true })
      expect(await roundTrip({ virtualCluster: true, nestedContainers: true }))
        .toEqual({ virtualCluster: true, nestedContainers: true })
    })

    it('rejects an explicit opt-out that contradicts virtualCluster', async () => {
      await expect(roundTrip({ virtualCluster: true, nestedContainers: false }))
        .rejects.toThrow('virtualCluster requires nestedContainers')
    })

    it('rejects non-boolean values', async () => {
      await expect(roundTrip({ nestedContainers: 'yes' }))
        .rejects.toThrow('nestedContainers must be a boolean')
      await expect(roundTrip({ virtualCluster: 1 }))
        .rejects.toThrow('virtualCluster must be a boolean')
      await expect(roundTrip({ hideInitPane: 'yes' }))
        .rejects.toThrow('hideInitPane must be a boolean')
    })

    it('round-trips hideInitPane', async () => {
      expect(await roundTrip({ hideInitPane: true })).toEqual({ hideInitPane: true })
    })
  })

  describe('ephemeralModulesPaths', () => {
    it('normalizes a string array, stripping surrounding slashes', async () => {
      expect(await roundTrip({
        ephemeralModulesPaths: ['node_modules', 'packages/web/node_modules/', 'apps/api/node_modules'],
      })).toEqual({
        ephemeralModulesPaths: ['node_modules', 'packages/web/node_modules', 'apps/api/node_modules'],
      })
      expect(await roundTrip({ ephemeralModulesPaths: [] })).toEqual({ ephemeralModulesPaths: [] })
    })

    it('rejects non-arrays, non-strings, absolute paths, and traversal', async () => {
      await expect(roundTrip({ ephemeralModulesPaths: 'node_modules' }))
        .rejects.toThrow(/must be a string array/)
      await expect(roundTrip({ ephemeralModulesPaths: ['node_modules', 5] }))
        .rejects.toThrow(/must be a string array/)
      await expect(roundTrip({ ephemeralModulesPaths: ['/etc/passwd'] }))
        .rejects.toThrow(/relative to \/workspace/)
      await expect(roundTrip({ ephemeralModulesPaths: [''] })).rejects.toThrow(/must not be empty/)
      for (const bad of ['../escape', 'a/./b', 'packages/../escape']) {
        await expect(roundTrip({ ephemeralModulesPaths: [bad] })).rejects.toThrow(/must not contain/)
      }
    })
  })

  describe('referenceBranch', () => {
    it('round-trips plain and slashed branch names', async () => {
      expect(await roundTrip({ referenceBranch: 'develop' })).toEqual({ referenceBranch: 'develop' })
      expect(await roundTrip({ referenceBranch: 'release/2.x' }))
        .toEqual({ referenceBranch: 'release/2.x' })
    })

    it('rejects non-strings, an origin/ prefix, whitespace, and unsafe names', async () => {
      await expect(roundTrip({ referenceBranch: 5 })).rejects.toThrow(/non-empty string/)
      await expect(roundTrip({ referenceBranch: '' })).rejects.toThrow(/non-empty string/)
      await expect(roundTrip({ referenceBranch: 'origin/develop' }))
        .rejects.toThrow(/drop the "origin\/" prefix/)
      await expect(roundTrip({ referenceBranch: 'my branch' })).rejects.toThrow(/whitespace/)
      await expect(roundTrip({ referenceBranch: '-flag' })).rejects.toThrow(/not a valid branch name/)
      await expect(roundTrip({ referenceBranch: 'a..b' })).rejects.toThrow(/not a valid branch name/)
    })
  })
})

describe('resolveEphemeralModulesPaths', () => {
  it('defaults to the root node_modules when unset or unconfigured', () => {
    expect(resolveEphemeralModulesPaths(null)).toEqual(['node_modules'])
    expect(resolveEphemeralModulesPaths({})).toEqual(['node_modules'])
  })

  it('returns the user list when set, and [] when explicitly disabled', () => {
    expect(resolveEphemeralModulesPaths({
      ephemeralModulesPaths: ['node_modules', 'packages/web/node_modules'],
    })).toEqual(['node_modules', 'packages/web/node_modules'])
    expect(resolveEphemeralModulesPaths({ ephemeralModulesPaths: [] })).toEqual([])
  })

  it('returns a fresh array each call (not a shared reference)', () => {
    resolveEphemeralModulesPaths({}).push('mutated')
    expect(resolveEphemeralModulesPaths({})).toEqual(['node_modules'])
  })
})

describe('ephemeralModulesSlotKey', () => {
  it('maps "node_modules" to "root"', () => {
    expect(ephemeralModulesSlotKey('node_modules')).toBe('root')
  })

  it('collapses slashes to underscores for nested paths', () => {
    expect(ephemeralModulesSlotKey('packages/web/node_modules')).toBe('packages_web_node_modules')
    expect(ephemeralModulesSlotKey('apps/api/node_modules')).toBe('apps_api_node_modules')
  })
})
