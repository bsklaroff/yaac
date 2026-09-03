import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
      expect(await roundTrip({ initCommands: ['pnpm install'], unknownField: true }))
        .toEqual({ initCommands: ['pnpm install'] })
    } finally {
      console.warn = origWarn
    }
    expect(warns).toContain('yaac-config.json: unknown field "unknownField"')
  })

  describe('retired keys', () => {
    // A retired key is not an unknown one: the generic "unknown field"
    // warning reads like a typo, and would leave someone whose worktrees
    // silently stopped getting their environment with nothing to search for.
    const warningsFor = async (config: object): Promise<string[]> => {
      const warns: string[] = []
      const origWarn = console.warn
      console.warn = (msg: string) => warns.push(msg)
      try {
        await roundTrip(config)
      } finally {
        console.warn = origWarn
      }
      return warns
    }

    it('names where a project environment lives now', async () => {
      const warns = await warningsFor({
        env: { FOO: 'bar' },
        envPassthrough: ['TERM'],
        envSecretProxy: { MY_KEY: { hosts: ['api.example.com'] } },
      })
      for (const key of ['env', 'envPassthrough', 'envSecretProxy']) {
        expect(warns.some((w) => w.includes(`"${key}" is no longer supported`))).toBe(true)
      }
      expect(warns.join('\n')).toContain('Settings → Project Config → Environment')
    })

    it('names cacheVolumes as what replaced bindMounts', async () => {
      const warns = await warningsFor({
        bindMounts: [{ hostPath: '/data', containerPath: '/mnt/data', mode: 'ro' }],
      })
      expect(warns.some((w) => w.includes('"bindMounts" is no longer supported'))).toBe(true)
      expect(warns.join('\n')).toContain('cacheVolumes')
    })

    it('drops them from the parsed config rather than carrying them through', async () => {
      const origWarn = console.warn
      console.warn = () => { /* the messages are asserted above */ }
      try {
        expect(await roundTrip({
          env: { FOO: 'bar' },
          bindMounts: [{ hostPath: '/data', containerPath: '/mnt/data', mode: 'ro' }],
          initCommands: ['pnpm install'],
        })).toEqual({ initCommands: ['pnpm install'] })
      } finally {
        console.warn = origWarn
      }
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

    // A retired key is not an unknown key: the generic "unknown field"
    // warning reads like a typo, and would leave someone whose worktrees
    // silently stopped getting a feature with nothing to search for. The
    // config still parses, so an unedited one keeps creating worktrees.
    it('names virtualCluster as retired rather than warning it is unknown', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* quiet */ })
      try {
        expect(await roundTrip({ virtualCluster: true, nestedContainers: true }))
          .toEqual({ nestedContainers: true })
        const said = warn.mock.calls.map((c) => String(c[0])).join('\n')
        expect(said).toContain('"virtualCluster" is no longer supported')
        expect(said).not.toContain('unknown field')
      } finally {
        warn.mockRestore()
      }
    })

    // The retired key always implied nestedContainers, and the in-pod
    // engine it implied still exists. Dropping the implication would take
    // the engine away from an unedited config, surfacing much later as
    // `docker: not found` inside the worktree.
    it('keeps virtualCluster implying nestedContainers, unless it says otherwise', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* quiet */ })
      try {
        expect(await roundTrip({ virtualCluster: true })).toEqual({ nestedContainers: true })
        // An explicit opt-out wins — it is the newer key, said outright.
        expect(await roundTrip({ virtualCluster: true, nestedContainers: false }))
          .toEqual({ nestedContainers: false })
        // And the key alone implies nothing when it is off.
        expect(await roundTrip({ virtualCluster: false })).toEqual({})
      } finally {
        warn.mockRestore()
      }
    })

    // The warning has to describe what the parser DID, which is not the same
    // sentence in all three shapes: claiming the implication where it never
    // fired names the one thing that did not happen.
    it('only claims the implication in the case that actually implies', async () => {
      const said = async (config: object): Promise<string> => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* quiet */ })
        try {
          await roundTrip(config)
          return warn.mock.calls.map((c) => String(c[0])).join('\n')
        } finally {
          warn.mockRestore()
        }
      }
      expect(await said({ virtualCluster: true })).toContain('It still implies')
      // Both of these resolve to no implication, so neither may claim one.
      expect(await said({ virtualCluster: true, nestedContainers: false }))
        .not.toContain('It still implies')
      expect(await said({ virtualCluster: false })).not.toContain('It still implies')
      // Every shape still names the key as retired rather than unknown.
      for (const c of [{ virtualCluster: true }, { virtualCluster: false }]) {
        expect(await said(c)).toContain('no longer supported')
        expect(await said(c)).not.toContain('unknown field')
      }
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
