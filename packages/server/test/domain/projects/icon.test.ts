import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import {
  listProjects,
  MAX_ICON_BYTES,
  readProjectIcon,
  removeProjectIcon,
  setProjectIcon,
} from '#domain/projects'
import { BUILT_IN_USER_ID, deleteProjectRow, recordProject } from '#db'
import { installFakeWorkspaceDriver, resetWorkspaceDriver } from '#test/support/fake-driver'
import { DEMO_PROJECT_ID } from '@yaac/test-utils/project-fixture'

/** The caller of every user-caused write here. */
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const stranger = { kind: 'local', userId: '0a0a0a0a-0000-4000-8000-0000000000aa' } as const

const MISSING = 'ea21841d-a70e-4405-8f19-fabc4ff8bdd9'
const OTHER = 'f1e2d3c4-b5a6-4978-8a7b-6c5d4e3f2a1b'

/** Enough of each format for its magic bytes to be recognized. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6])

const projectId = DEMO_PROJECT_ID
let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  installFakeWorkspaceDriver()
  await recordProject({ id: projectId, name: 'demo', remoteUrl: 'https://example.com/demo.git', addedAt: '2026-01-01T00:00:00.000Z' }, BUILT_IN_USER_ID)
  await recordProject({ id: OTHER, name: 'other', remoteUrl: 'https://example.com/other.git', addedAt: '2026-01-01T00:00:00.000Z' }, BUILT_IN_USER_ID)
})

afterEach(async () => {
  resetWorkspaceDriver()
  await cleanupTempDir(tmpDir)
})

const summary = async (id = projectId) => (await listProjects()).find((p) => p.id === id)

describe('readProjectIcon', () => {
  it('answers the stored bytes and their sniffed type, and NOT_FOUND once there are none', async () => {
    await expect(readProjectIcon(projectId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await setProjectIcon(local, projectId, JPEG)
    const icon = await readProjectIcon(projectId)
    expect(icon.mimeType).toBe('image/jpeg')
    expect(new Uint8Array(icon.bytes)).toEqual(JPEG)
    // The icon goes with its project.
    await deleteProjectRow(projectId)
    await expect(readProjectIcon(projectId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('setProjectIcon', () => {
  it('replaces the picture, which the summary names by a hash that changes with it', async () => {
    expect((await summary())?.iconHash).toBeUndefined()
    await setProjectIcon(local, projectId, PNG)
    const first = (await summary())?.iconHash
    expect(first).toMatch(/^[0-9a-f]{16}$/)
    await setProjectIcon(local, projectId, JPEG)
    expect((await summary())?.iconHash).not.toBe(first)
    expect((await readProjectIcon(projectId)).mimeType).toBe('image/jpeg')
    expect((await summary(OTHER))?.iconHash).toBeUndefined()
  })

  // An SVG can carry script, so only the webapp's rasterized copy of one
  // is ever stored.
  it('refuses SVG and anything else not a raster image, an oversized one, a stranger and a missing project, keeping what was saved', async () => {
    await setProjectIcon(local, projectId, PNG)
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    await expect(setProjectIcon(local, projectId, svg)).rejects.toMatchObject({ code: 'VALIDATION' })
    const huge = new Uint8Array(MAX_ICON_BYTES + 1)
    huge.set(PNG)
    await expect(setProjectIcon(local, projectId, huge)).rejects.toMatchObject({ code: 'TOO_LARGE' })
    await expect(setProjectIcon(stranger, projectId, JPEG)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(setProjectIcon(local, MISSING, JPEG)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(new Uint8Array((await readProjectIcon(projectId)).bytes)).toEqual(PNG)
  })
})

describe('removeProjectIcon', () => {
  it('drops the picture, which a stranger may not', async () => {
    await setProjectIcon(local, projectId, PNG)
    await expect(removeProjectIcon(stranger, projectId)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await removeProjectIcon(local, projectId)
    expect((await summary())?.iconHash).toBeUndefined()
    await expect(readProjectIcon(projectId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
