import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { PROJECT_CONFIG_DEFAULTS, recordTestProject } from '@yaac/test-utils/project-fixture'
import { BUILT_IN_USER_ID, getProjectRow } from '#db'
import {
  addPortForward,
  cacheVolumesSchema,
  portForwardsSchema,
  resolveProjectConfig,
  updateProjectConfig,
} from '#domain/projects'

const FOO = 'acbd18db-4cc2-485c-8def-654fccc4a4d8'
const MISSING = 'ea21841d-a70e-4405-8f19-fabc4ff8bdd9'
const OWNER = { kind: 'local' as const, userId: BUILT_IN_USER_ID }

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await recordTestProject(FOO)
})

afterEach(async () => {
  await cleanupTempDir(tmpDir)
})

/** The first issue's path and message, as a route's 400 reports it. */
function issue(schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } } }, value: unknown): string {
  const result = schema.safeParse(value)
  expect(result.success, JSON.stringify(value)).toBe(false)
  const [first] = result.error!.issues
  return [...first.path.map(String), first.message].join(' ')
}

describe('portForwardsSchema', () => {
  it('takes container/host pairs, keeping the first of a container port listed twice', () => {
    expect(portForwardsSchema.parse([
      { containerPort: 8080, hostPortStart: 9000 },
      { containerPort: 5432, hostPortStart: 15432 },
      { containerPort: 8080, hostPortStart: 1 },
    ])).toEqual([{ containerPort: 8080, hostPortStart: 9000 }, { containerPort: 5432, hostPortStart: 15432 }])
  })

  it('refuses malformed entries, ports out of range, and yaac\'s own infra ports', () => {
    expect(issue(portForwardsSchema, 'x')).toMatch(/must be an array/)
    expect(issue(portForwardsSchema, ['x'])).toMatch(/^0 must be an object/)
    expect(issue(portForwardsSchema, [{ hostPortStart: 9000 }])).toMatch(/^0 containerPort must be an integer/)
    expect(issue(portForwardsSchema, [{ containerPort: 8080 }])).toMatch(/^0 hostPortStart must be an integer/)
    expect(issue(portForwardsSchema, [{ containerPort: 70000, hostPortStart: 9000 }])).toMatch(/must be an integer/)
    expect(issue(portForwardsSchema, [{ containerPort: 80.5, hostPortStart: 9000 }])).toMatch(/must be an integer/)
    // 10250-10350 is reserved for yaac's in-workspace services; a database
    // port above may be forwarded explicitly.
    for (const containerPort of [10250, 10300, 10350]) {
      expect(issue(portForwardsSchema, [{ containerPort, hostPortStart: 9000 }])).toMatch(`${containerPort} is reserved`)
    }
  })
})

describe('cacheVolumesSchema', () => {
  it('takes a name to absolute path map', () => {
    const ok = { 'pnpm.store_v3-x': '/root/.local/share/pnpm/store/v3', ['x'.repeat(64)]: '/b' }
    expect(cacheVolumesSchema.parse(ok)).toEqual(ok)
  })

  it('refuses a non-object, a value that is not a normalized absolute path, and a name that could be any dir but its own', () => {
    expect(issue(cacheVolumesSchema, 'x')).toMatch(/must be an object/)
    expect(issue(cacheVolumesSchema, { store: 123 })).toBe('store must be a string (absolute container path)')
    for (const val of ['relative/path', '/', '/a/../b', '/a//b', '/a/./b']) {
      expect(issue(cacheVolumesSchema, { store: val })).toBe('store must be a normalized absolute path other than /')
    }
    // A name is a host dir under cache-volumes/. A parent reference would
    // mount another server dir into the pod; a subdir would nest one mount
    // inside another, which the pod could swap for a symlink.
    for (const key of ['../../../.credentials', 'a/b', '..', '.', '.hidden', '', 'x'.repeat(65), 'a b']) {
      expect(issue(cacheVolumesSchema, { [key]: '/cache' })).toMatch(`name "${key}"`)
    }
  })
})

describe('resolveProjectConfig', () => {
  it('answers a project\'s settings, the defaults until set, and undefined for no project', async () => {
    expect(await resolveProjectConfig(FOO)).toEqual(PROJECT_CONFIG_DEFAULTS)
    expect(await resolveProjectConfig(MISSING)).toBeUndefined()
  })
})

describe('updateProjectConfig', () => {
  it('replaces the settings named, keeps the rest, and answers all of them', async () => {
    const ports = [{ containerPort: 3000, hostPortStart: 3000 }]
    expect(await updateProjectConfig(OWNER, FOO, { portForwards: ports, npmCache: false }))
      .toEqual({ ...PROJECT_CONFIG_DEFAULTS, portForwards: ports, npmCache: false })
    expect(await updateProjectConfig(OWNER, FOO, { nestedContainers: true, cacheVolumes: { pip: '/p' } }))
      .toEqual({ portForwards: ports, cacheVolumes: { pip: '/p' }, nestedContainers: true, npmCache: false })
    expect(await resolveProjectConfig(FOO)).toEqual({ portForwards: ports, cacheVolumes: { pip: '/p' }, nestedContainers: true, npmCache: false })
  })

  it('refuses anyone but the owner, and an unknown project', async () => {
    await expect(updateProjectConfig({ kind: 'local', userId: MISSING }, FOO, { npmCache: false }))
      .rejects.toThrow(/only the owner/)
    await expect(updateProjectConfig(OWNER, MISSING, { npmCache: false })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await getProjectRow(FOO))?.npmCache).toBe(true)
  })
})

describe('addPortForward', () => {
  it('adds the port at the same host port once, keeping the others', async () => {
    await updateProjectConfig(OWNER, FOO, { portForwards: [{ containerPort: 3000, hostPortStart: 13000 }] })
    await addPortForward(OWNER, FOO, 8080)
    expect((await addPortForward(OWNER, FOO, 8080)).portForwards).toEqual([
      { containerPort: 3000, hostPortStart: 13000 },
      { containerPort: 8080, hostPortStart: 8080 },
    ])
    await expect(addPortForward(OWNER, MISSING, 8080)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
