import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveEphemeralModulesPaths, resolveProjectConfig, retryImageBuild } from '#domain/projects'
import { installFakeWorktreeDriver } from '@yaac/test-utils/fake-driver'
import { setDataDir, projectConfigDir } from '@yaac/shared/project-paths'
import type { YaacConfig } from '@yaac/shared/types'

const slug = 'test-project'
let dataDir: string

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-config-test-'))
  await fs.mkdir(path.join(dataDir, 'global', 'projects', slug, 'repo'), { recursive: true })
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
      path.join(dataDir, 'global', 'projects', slug, 'repo', 'yaac-config.json'),
      JSON.stringify({ initCommands: ['pnpm install'] }),
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
      expect(await roundTrip({ initCommands: ['pnpm install'], unknownField: true }))
        .toEqual({ initCommands: ['pnpm install'] })
    } finally {
      console.warn = origWarn
    }
    expect(warns).toContain('yaac-config.json: unknown field "unknownField"')
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

  describe('npmCache', () => {
    it('round-trips the boolean and rejects anything else', async () => {
      expect(await roundTrip({ npmCache: false })).toEqual({ npmCache: false })
      expect(await roundTrip({ npmCache: true })).toEqual({ npmCache: true })
      await expect(roundTrip({ npmCache: 'off' })).rejects.toThrow('npmCache must be a boolean')
    })
  })

  describe('nestedContainers', () => {
    it('round-trips the boolean', async () => {
      expect(await roundTrip({ nestedContainers: true })).toEqual({ nestedContainers: true })
      expect(await roundTrip({ nestedContainers: false })).toEqual({ nestedContainers: false })
    })

    it('rejects non-boolean values', async () => {
      await expect(roundTrip({ nestedContainers: 'yes' }))
        .rejects.toThrow('nestedContainers must be a boolean')
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

describe('retryImageBuild', () => {
  type RetryVerb = (id: string, cfg: (slug: string) => Promise<YaacConfig | undefined>) => boolean

  // The runtime cannot read config itself — a rebuild that defaulted it
  // would silently drop a nested project's nestable layer. "No config" reads
  // as all-defaults: null from the store, undefined to the contract.
  it('hands the runtime a reader for each owning project’s config', async () => {
    const mockRetry = vi.fn<RetryVerb>().mockReturnValue(true)
    installFakeWorktreeDriver({ retryImageBuild: mockRetry })
    await storeConfig(JSON.stringify({ nestedContainers: true }))

    expect(retryImageBuild('b1')).toBe(true)

    const reader = mockRetry.mock.calls[0][1]
    await expect(reader(slug)).resolves.toEqual({ nestedContainers: true })
    await expect(reader('unconfigured')).resolves.toBeUndefined()
  })

  it('reports that there was nothing to retry', () => {
    installFakeWorktreeDriver({ retryImageBuild: () => false })

    expect(retryImageBuild('gone')).toBe(false)
  })
})
