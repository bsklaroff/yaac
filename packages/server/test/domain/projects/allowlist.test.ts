import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import {
  addAllowedHostToProject,
  getProjectAllowlist,
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
