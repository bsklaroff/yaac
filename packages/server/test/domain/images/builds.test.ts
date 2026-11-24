/**
 * The image build queue (docs/image-builds.md "The queue") and the
 * building pill the snapshot carries. Builds start through the images
 * verbs; the fake driver records each request and the test settles it.
 */
import fs from 'node:fs/promises'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { activeImageBuilds, buildConcurrency, createProjectImage, failInterruptedBuilds, imageForCreate, setBuildConcurrency } from '#domain/images'
import { BUILT_IN_USER_ID, listImageBuilds, updateImageBuild } from '#db'
import { closeDb } from '#db/client'
import { _resetImageBuildsForTests } from '#domain/images/builds'
import { cleanupTempDir, createTempDataDir } from '@yaac/test-utils/setup'
import { DEMO_PROJECT_ID, recordTestProject } from '@yaac/test-utils/project-fixture'
import { serverLocalPath } from '@yaac/shared/project-paths'
import { installFakeWorkspaceDriver, resetWorkspaceDriver } from '#test/support/fake-driver'
import type { ImageBuildOutcome, ImageBuildRequest } from '#drivers/contract'

const owner = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const LAYERED = 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n'

let requests: Array<{ request: ImageBuildRequest; settle: (o: ImageBuildOutcome) => void }>
let tmpDir: string


/** Builds settle over several event-loop turns and database writes, which a
 *  loaded machine can stretch past `vi.waitFor`'s one-second default. */
function settles<T>(check: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(check, { timeout: 10_000 })
}
beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await recordTestProject(DEMO_PROJECT_ID)
  requests = []
  installFakeWorkspaceDriver({
    missingImageLayers: () => Promise.resolve(['project']),
    buildImageLayers: (request) => new Promise((settle) => {
      request.onLayerStart('project')
      requests.push({ request, settle })
    }),
  })
})

afterEach(async () => {
  _resetImageBuildsForTests()
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('buildConcurrency', () => {
  it('defaults to two builds at once', async () => {
    expect(await buildConcurrency()).toBe(2)
  })
})

describe('setBuildConcurrency', () => {
  it('holds builds past the limit as queued, starting a create\'s ahead of a save\'s', async () => {
    await expect(setBuildConcurrency(0)).rejects.toThrow(/1 to 16/)
    expect(await setBuildConcurrency(1)).toBe(1)
    await createProjectImage(owner, DEMO_PROJECT_ID, 'a', { dockerfile: `${LAYERED}RUN a\n`, files: {} })
    await settles(() => { expect(requests).toHaveLength(1) })
    const b = await createProjectImage(owner, DEMO_PROJECT_ID, 'b', { dockerfile: `${LAYERED}RUN b\n`, files: {} })
    const c = await createProjectImage(owner, DEMO_PROJECT_ID, 'c', { dockerfile: `${LAYERED}RUN c\n`, files: {} })
    await settles(async () => { expect((await activeImageBuilds()).filter((x) => x.status === 'queued')).toHaveLength(2) })
    // A create waiting on c jumps the queue past b's save.
    let joined!: () => void
    const joining = new Promise<void>((resolve) => { joined = resolve })
    // It reports progress once it has joined c's queued build.
    const create = imageForCreate({ projectId: DEMO_PROJECT_ID, imageId: c.id, onProgress: () => { joined() } })
    await joining
    requests.shift()!.settle({ ok: true, blockedHosts: [] })
    await settles(() => { expect(requests).toHaveLength(1) })
    expect(requests[0].request.spec.layers[0].dockerfile).toContain('RUN c')
    requests.shift()!.settle({ ok: true, blockedHosts: [] })
    await expect(create).resolves.toMatchObject({ imageId: c.id })
    await settles(() => { expect(requests[0]?.request.spec.layers[0].dockerfile).toContain('RUN b') })
    expect(b.name).toBe('b')
    expect(await setBuildConcurrency(null)).toBe(2)
  })
})

describe('activeImageBuilds', () => {
  it('shows queued and running builds, and a recent failure until a later build replaces it', async () => {
    await createProjectImage(owner, DEMO_PROJECT_ID, 'a', { dockerfile: LAYERED, files: {} })
    await settles(() => { expect(requests).toHaveLength(1) })
    expect((await activeImageBuilds()).map((b) => b.status)).toEqual(['running'])
    requests.shift()!.settle({ ok: false, error: 'boom', failedLayer: 'project', blockedHosts: ['quay.io'] })
    await settles(async () => {
      expect(await activeImageBuilds()).toEqual([expect.objectContaining({ status: 'failed', error: 'boom', blockedHosts: ['quay.io'] })])
    })
    // An hour on, it leaves the pill.
    const [failed] = await activeImageBuilds()
    await updateImageBuild(failed.id, { finishedAt: new Date(Date.now() - 2 * 60 * 60_000) })
    expect(await activeImageBuilds()).toEqual([])
  })
})

describe('failInterruptedBuilds', () => {
  it('marks the builds a dead server left queued or running failed, and drops their contexts', async () => {
    await createProjectImage(owner, DEMO_PROJECT_ID, 'a', { dockerfile: LAYERED, files: {} })
    await settles(() => { expect(requests).toHaveLength(1) })
    // As at the next start: this process never ran the build.
    _resetImageBuildsForTests()
    const leftover = serverLocalPath('image-contexts', 'old-build', 'project')
    await fs.mkdir(leftover, { recursive: true })
    expect(await failInterruptedBuilds()).toBe(1)
    const [row] = await listImageBuilds({ projectId: DEMO_PROJECT_ID })
    expect(row).toMatchObject({ status: 'failed', error: 'the server restarted during this build' })
    await expect(fs.access(leftover)).rejects.toThrow()
    expect(await failInterruptedBuilds()).toBe(0)
  })
})
