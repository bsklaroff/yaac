import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { projectConfigDir } from '@yaac/shared/project-paths'
import {
  addAllowedHostToProject,
  getProjectAllowlist,
  importConfigAllowlists,
  setProjectAllowlist,
} from '#domain/projects'
import { BUILT_IN_USER_ID, recordProject } from '#db'
import { DEMO_PROJECT_ID } from '@yaac/test-utils/project-fixture'

/** The caller of every user-caused write here. */
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const

const MISSING = 'ea21841d-a70e-4405-8f19-fabc4ff8bdd9'
const OTHER = '5d0f2b9e-27a4-4a3c-9a43-1b1c2f3e4d5a'

const projectId = DEMO_PROJECT_ID
let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  for (const [id, name] of [[projectId, 'demo'], [OTHER, 'other']]) {
    await recordProject({ id, name, remoteUrl: 'https://example.com/foo', addedAt: '2026-01-01T00:00:00.000Z' }, BUILT_IN_USER_ID)
  }
})

afterEach(async () => {
  await cleanupTempDir(tmpDir)
})

const configPath = (id: string): string => path.join(projectConfigDir(id), 'yaac-config.json')

async function seedConfig(id: string, raw: string): Promise<void> {
  await fs.mkdir(projectConfigDir(id), { recursive: true })
  await fs.writeFile(configPath(id), raw)
}

describe('getProjectAllowlist', () => {
  it('starts on the defaults with nothing added', async () => {
    expect(await getProjectAllowlist(projectId)).toEqual({ hosts: [], defaults: true })
  })

  it('throws NOT_FOUND for an unknown project', async () => {
    await expect(getProjectAllowlist(MISSING)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('setProjectAllowlist', () => {
  it('stores a normalized list per project and returns it', async () => {
    const saved = await setProjectAllowlist(local, projectId, {
      hosts: [' API.Example.com ', '*.cdn.example.com', 'api.example.com'],
      defaults: false,
    })
    expect(saved).toEqual({ hosts: ['api.example.com', '*.cdn.example.com'], defaults: false })
    expect(await getProjectAllowlist(projectId)).toEqual(saved)
    expect(await getProjectAllowlist(OTHER)).toEqual({ hosts: [], defaults: true })
  })

  it('rejects a host with a scheme, path or port, keeping the stored list', async () => {
    for (const bad of ['https://a.com', 'a.com/x', 'a.com:443', '']) {
      await expect(setProjectAllowlist(local, projectId, { hosts: [bad], defaults: true }))
        .rejects.toMatchObject({ code: 'VALIDATION' })
    }
    expect(await getProjectAllowlist(projectId)).toEqual({ hosts: [], defaults: true })
  })

  it('throws NOT_FOUND for an unknown project', async () => {
    await expect(setProjectAllowlist(local, MISSING, { hosts: [], defaults: true }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('addAllowedHostToProject', () => {
  it('appends a host once, keeping the defaults setting', async () => {
    await setProjectAllowlist(local, projectId, { hosts: ['pinned.com'], defaults: false })
    await addAllowedHostToProject(local, projectId, 'extra.com')
    await addAllowedHostToProject(local, projectId, 'pinned.com')
    expect(await getProjectAllowlist(projectId)).toEqual({ hosts: ['pinned.com', 'extra.com'], defaults: false })
  })
})

describe('importConfigAllowlists', () => {
  it('moves each config allowlist into its project and strips the keys from the file', async () => {
    await seedConfig(projectId, JSON.stringify({ initCommands: ['make'], addAllowedUrls: ['a.com'] }))
    await seedConfig(OTHER, JSON.stringify({ setAllowedUrls: ['b.com'] }))
    await setProjectAllowlist(local, projectId, { hosts: ['kept.com'], defaults: true })

    await importConfigAllowlists()

    expect(await getProjectAllowlist(projectId)).toEqual({ hosts: ['kept.com', 'a.com'], defaults: true })
    expect(await getProjectAllowlist(OTHER)).toEqual({ hosts: ['b.com'], defaults: false })
    expect(JSON.parse(await fs.readFile(configPath(projectId), 'utf8'))).toEqual({ initCommands: ['make'] })
    expect(JSON.parse(await fs.readFile(configPath(OTHER), 'utf8'))).toEqual({})

    // A second start finds nothing to move.
    await importConfigAllowlists()
    expect(await getProjectAllowlist(projectId)).toEqual({ hosts: ['kept.com', 'a.com'], defaults: true })
  })

  it('leaves a malformed file or allowlist, or one with both keys, in place for the user to fix', async () => {
    const both = { addAllowedUrls: ['a.com'], setAllowedUrls: ['b.com'] }
    await seedConfig(projectId, '{ broken')
    await seedConfig(OTHER, JSON.stringify({ addAllowedUrls: 'a.com' }))

    await importConfigAllowlists()
    expect(await fs.readFile(configPath(projectId), 'utf8')).toBe('{ broken')
    expect(JSON.parse(await fs.readFile(configPath(OTHER), 'utf8'))).toEqual({ addAllowedUrls: 'a.com' })

    await seedConfig(OTHER, JSON.stringify(both))
    await importConfigAllowlists()
    expect(JSON.parse(await fs.readFile(configPath(OTHER), 'utf8'))).toEqual(both)
    expect(await getProjectAllowlist(OTHER)).toEqual({ hosts: [], defaults: true })
  })

  it('drops entries that would change effect: unmatchable hosts, and a * beside others', async () => {
    // A lone `*` in setAllowedUrls allowed everything, so it is kept.
    await seedConfig(OTHER, JSON.stringify({ setAllowedUrls: ['*'] }))
    // Elsewhere `*` matched only single-label names, and an uppercase,
    // scheme, path or port entry never matched the proxy's lowercased host.
    await seedConfig(projectId, JSON.stringify({
      addAllowedUrls: ['*', 'ok.example.com', 'Mixed.Example.com', 'https://bad.example.com/x', 'host:8080'],
    }))

    await importConfigAllowlists()

    expect(await getProjectAllowlist(OTHER)).toEqual({ hosts: ['*'], defaults: false })
    expect(await getProjectAllowlist(projectId)).toEqual({ hosts: ['ok.example.com'], defaults: true })
    // What was kept still saves.
    await addAllowedHostToProject(local, projectId, 'new.example.com')
  })
})
