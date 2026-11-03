import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveProjectConfig } from '#domain/projects'
import { setDataDir, projectConfigDir } from '@yaac/shared/project-paths'
import type { YaacConfig } from '@yaac/shared/types'

const projectId = 'test-project'
let dataDir: string

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-config-test-'))
  await fs.mkdir(path.join(dataDir, 'global', 'projects', projectId, 'repo'), { recursive: true })
  setDataDir(dataDir)
})

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true })
})

/** Store a project's yaac-config.json verbatim. Takes text so malformed
 *  files are testable. */
async function storeConfig(raw: string): Promise<void> {
  const dir = projectConfigDir(projectId)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'yaac-config.json'), raw)
}

/** Store `config` as JSON and resolve it back, as a caller would. Returns a
 *  promise chain so rejection cases can use `.rejects`. */
function roundTrip(config: unknown): Promise<YaacConfig | null> {
  return storeConfig(JSON.stringify(config)).then(() => resolveProjectConfig(projectId))
}

describe('resolveProjectConfig', () => {
  it('returns null when the project has no stored config', async () => {
    expect(await resolveProjectConfig(projectId)).toBeNull()
  })

  it('ignores a yaac-config.json checked into the cloned repo', async () => {
    // Only the per-project config dir is a config source.
    await fs.writeFile(
      path.join(dataDir, 'global', 'projects', projectId, 'repo', 'yaac-config.json'),
      JSON.stringify({ npmCache: false }),
    )
    expect(await resolveProjectConfig(projectId)).toBeNull()
  })

  it('rejects a file that is not a JSON object', async () => {
    await storeConfig('[]')
    await expect(resolveProjectConfig(projectId)).rejects.toThrow('must be a JSON object')
    await storeConfig('"a string"')
    await expect(resolveProjectConfig(projectId)).rejects.toThrow('must be a JSON object')
    await storeConfig('{ not json')
    await expect(resolveProjectConfig(projectId)).rejects.toThrow()
  })

  it('rejects an unknown field, naming it and the fields there are', async () => {
    await expect(roundTrip({ npmCache: true, unknownField: true }))
      .rejects.toThrow('yaac-config.json: unknown field "unknownField"; the fields are cacheVolumes, portForward,')
    // A name every object inherits is still unknown here.
    await expect(roundTrip({ toString: 1 })).rejects.toThrow('unknown field "toString"')
    // A retired one says where its setting went.
    await expect(roundTrip({ ephemeralModulesPaths: ['node_modules'] }))
      .rejects.toThrow('"ephemeralModulesPaths" is now the project\'s scratch directories')
    await expect(roundTrip({ initCommands: ['pnpm install'] }))
      .rejects.toThrow('"initCommands" is now the project\'s init steps')
    await expect(roundTrip({ hideInitPane: true })).rejects.toThrow('"hideInitPane" is gone')
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
        .rejects.toThrow('cacheVolumes.store must be a normalized absolute path')
    })

    it('refuses a value that is the root or not normalized', async () => {
      for (const val of ['/', '/a/../b', '/a//b', '/a/./b']) {
        await expect(roundTrip({ cacheVolumes: { store: val } }), val)
          .rejects.toThrow('cacheVolumes.store must be a normalized absolute path')
      }
    })

    it('refuses a key that could name any dir but its own', async () => {
      // A key is a host dir name under cache-volumes/. A parent reference
      // would mount another server dir into the pod; a subdir would nest one
      // mount inside another, which the pod could swap for a symlink.
      for (const key of ['../../../.credentials', 'a/b', '..', '.', '.hidden', '', 'x'.repeat(65), 'a b']) {
        await expect(roundTrip({ cacheVolumes: { [key]: '/cache' } }), key)
          .rejects.toThrow(`cacheVolumes key "${key}"`)
      }
      const ok = { cacheVolumes: { 'pnpm.store_v3-x': '/a', ['x'.repeat(64)]: '/b' } }
      expect(await roundTrip(ok)).toEqual(ok)
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

    it('refuses yaac\'s own in-workspace infra ports, but allows a sensitive one', async () => {
      // 10250-10350 is reserved for yaac's in-workspace services. A database
      // port may be forwarded explicitly; only one-click detection skips it.
      for (const containerPort of [10250, 10300, 10350]) {
        await expect(roundTrip({ portForward: [{ containerPort, hostPortStart: 9000 }] }))
          .rejects.toThrow(`portForward[0].containerPort ${containerPort} is reserved`)
      }
      const db = { portForward: [{ containerPort: 5432, hostPortStart: 15432 }] }
      expect(await roundTrip(db)).toEqual(db)
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
    })
  })
})
