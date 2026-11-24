/**
 * A project's images, a user's own, their revisions, builds and what a
 * create launches (docs/image-builds.md). The driver is the fake: its
 * chain tags are content hashes of what it is handed, and a build request
 * is recorded and settled by the test.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  allowBuildHost,
  buildLog,
  cancelBuild,
  createProjectImage,
  deleteImage,
  getBuild,
  getImageDetail,
  getUserImage,
  imageForCreate,
  listBuilds,
  listProjectImages,
  listRevisions,
  readImageFile,
  removeProjectImages,
  requestImageBuild,
  resolveImageName,
  restoreRevision,
  retryBuild,
  saveImage,
  saveUserImage,
  setBuildConcurrency,
  setDefaultImage,
  setImageCacheDays,
  spareImageTag,
  uploadImageFile,
} from '#domain/images'
import { getProjectAllowlist } from '#domain/projects'
import { BUILT_IN_USER_ID, getImage, getProjectRow, listImageBuilds } from '#db'
import { closeDb } from '#db/client'
import { _resetImageBuildsForTests } from '#domain/images/builds'
import { cleanupTempDir, createTempDataDir } from '@yaac/test-utils/setup'
import { DEMO_PROJECT_ID, recordTestProject } from '@yaac/test-utils/project-fixture'
import type * as buildContextModule from '#lib/build-context'

// Small caps, so a test crosses them without writing megabytes.
vi.mock('#lib/build-context', async (importOriginal) => ({
  ...(await importOriginal<typeof buildContextModule>()),
  MAX_IMAGE_FILE_BYTES: 8,
  BUILDER_CONTEXT_MAX_BYTES: 16,
}))
import { globalProjectPath } from '@yaac/shared/project-paths'
import { STOCK_IMAGE_ID, type ImageLayerName } from '@yaac/shared/types'
import { installFakeWorkspaceDriver, resetWorkspaceDriver } from '#test/support/fake-driver'
import type { ImageBuildOutcome, ImageBuildRequest } from '#drivers/contract'

const owner = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const stranger = { kind: 'local', userId: '4101bef8-794f-4d98-8e95-dfb54850c68b' } as const
const LAYERED = 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo hi\n'

/** Build requests the fake driver got, each settled by the test. */
let requests: Array<{ request: ImageBuildRequest; settle: (o: ImageBuildOutcome) => void }>
/** Layers the fake registry lacks; every request builds them. */
let missing: ImageLayerName[]
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
  missing = ['project']
  installFakeWorkspaceDriver({
    missingImageLayers: (chain) => Promise.resolve(missing.filter((m) => chain.layers.some((l) => l.name === m))),
    buildImageLayers: (request) => new Promise((settle) => {
      request.onLayerStart(request.layers[0])
      request.onLine(request.layers[0], '#5 [1/2] FROM fake-tools:t@sha256:' + 'a'.repeat(64))
      request.onLine(request.layers[0], '#6 [2/2] RUN echo hi')
      request.onLine(request.layers[0], '#1 WARN: JSONArgsRecommended: use JSON (line 3)')
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

/** Wait for the fake driver's next build request. */
async function nextRequest(): Promise<(typeof requests)[number]> {
  await settles(() => { expect(requests.length).toBeGreaterThan(0) })
  return requests.shift()!
}

/** A project image named `web`, with one support file. */
async function webImage(): Promise<string> {
  // A file is uploaded against an image, so a first image takes it.
  const seed = await createProjectImage(owner, DEMO_PROJECT_ID, 'seed', { dockerfile: 'FROM x', files: {} })
  await nextRequest().then((r) => r.settle({ ok: true, blockedHosts: [] }))
  const file = await uploadImageFile(owner, { imageId: seed.id }, Buffer.from('hello'))
  const image = await createProjectImage(owner, DEMO_PROJECT_ID, 'web', { dockerfile: LAYERED, files: { 'conf/a.txt': file } })
  await nextRequest().then((r) => r.settle({ ok: true, blockedHosts: [] }))
  await settles(async () => { expect((await listImageBuilds({ imageId: image.id }))[0].status).toBe('succeeded') })
  return image.id
}

describe('createProjectImage', () => {
  it('creates an image at revision 1 and builds it at once', async () => {
    const image = await createProjectImage(owner, DEMO_PROJECT_ID, 'web', { dockerfile: LAYERED, files: {} })
    expect(image).toMatchObject({ name: 'web', currentRevision: { number: 1 }, isDefault: false })
    const { request, settle } = await nextRequest()
    expect(request.spec.layers).toEqual([expect.objectContaining({ layer: 'project', dockerfile: LAYERED })])
    // The project's allowlist is all the build may reach.
    expect(request.allowedHosts).toContain('github.com')
    settle({ ok: true, blockedHosts: [] })
    await expect(createProjectImage(owner, DEMO_PROJECT_ID, 'web', { dockerfile: 'FROM y', files: {} })).rejects.toThrow(/already has an image named web/)
    await expect(createProjectImage(owner, DEMO_PROJECT_ID, 'yaac', { dockerfile: 'FROM y', files: {} })).rejects.toThrow(/not `yaac`/)
    await expect(createProjectImage(stranger, DEMO_PROJECT_ID, 'x', { dockerfile: 'FROM y', files: {} })).rejects.toThrow(/owner/)
  })
})

describe('uploadImageFile', () => {
  it('stores a file once by its content, and a save must name only stored files', async () => {
    const id = await webImage()
    const a = await uploadImageFile(owner, { imageId: id }, Buffer.from('x'))
    expect(await uploadImageFile(owner, { imageId: id }, Buffer.from('x'))).toEqual(a)
    await expect(fs.readFile(path.join(globalProjectPath(DEMO_PROJECT_ID, 'image-blobs'), a.sha256), 'utf8')).resolves.toBe('x')
    await expect(saveImage(owner, id, { dockerfile: LAYERED, files: { b: { sha256: 'f'.repeat(64), size: 1 } } }))
      .rejects.toThrow(/upload these files first: b/)
    await expect(saveImage(owner, id, { dockerfile: LAYERED, files: { '../x': a } })).rejects.toThrow(/escapes/)
  })

  it('refuses a file over the cap, and a save past the context cap, a bad path or a file that is also a folder', async () => {
    const id = await webImage()
    await expect(uploadImageFile(owner, { imageId: id }, Buffer.from('123456789'))).rejects.toThrow(/may be at most/)
    const eight = await uploadImageFile(owner, { imageId: id }, Buffer.from('12345678'))
    const save = (files: Record<string, { sha256: string; size: number }>) => saveImage(owner, id, { dockerfile: LAYERED, files })
    // Sizes count as stored, whatever the client claims.
    await expect(save({ a: { ...eight, size: 0 }, b: { ...eight, size: 0 }, c: { ...eight, size: 0 } })).rejects.toThrow(/may be at most/)
    const saved = await save({ a: { ...eight, size: 0 } })
    expect(saved.revision.files.a.size).toBe(8)
    for (const bad of ['/abs', 'a\\b', 'a\0b', '', ' a']) {
      await expect(save({ [bad]: eight }), JSON.stringify(bad)).rejects.toThrow(/invalid file path/)
    }
    await expect(save({ a: eight, 'a/b': eight })).rejects.toThrow(/a is both a file and a folder/)
  })
})

describe('saveImage', () => {
  it('appends a revision only when the content changed, and builds it', async () => {
    const id = await webImage()
    const same = await saveImage(owner, id, { dockerfile: LAYERED, files: (await getImageDetail(owner, id)).revision!.files })
    expect(same).toMatchObject({ changed: false, revision: { number: 1 } })
    const next = await saveImage(owner, id, { dockerfile: `${LAYERED}RUN echo two\n`, files: {}, note: 'two' })
    expect(next).toMatchObject({ changed: true, revision: { number: 2, note: 'two' } })
    const { settle } = await nextRequest()
    settle({ ok: false, error: 'exit code 1', failedLayer: 'project', blockedHosts: ['registry-1.docker.io'] })
    await settles(async () => { expect((await listBuilds(owner, { imageId: id }))[0].status).toBe('failed') })
  })
})

describe('getImageDetail', () => {
  it('answers the image with its current revision', async () => {
    const id = await webImage()
    const detail = await getImageDetail(owner, id)
    expect(detail.image).toMatchObject({ id, state: 'ready', lastBuiltRevision: { number: 1 } })
    expect(Object.keys(detail.revision!.files)).toEqual(['conf/a.txt'])
    await expect(getImageDetail(owner, 'not-an-id')).rejects.toThrow(/no such image/)
  })

  it('keeps a user\'s Dockerfile.user from every other user', async () => {
    await saveUserImage(owner, { dockerfile: LAYERED, files: {} })
    const mine = (await getUserImage(owner))!
    await expect(getImageDetail(stranger, mine.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(saveImage(stranger, mine.id, { dockerfile: `${LAYERED}RUN x\n`, files: {} })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await getUserImage(stranger)).toBeNull()
  })
})

describe('listProjectImages', () => {
  it('lists the stock image first, then the project\'s with their state', async () => {
    const id = await webImage()
    await saveImage(owner, id, { dockerfile: `${LAYERED}RUN echo two\n`, files: {} })
    await nextRequest()
    const list = await listProjectImages(owner, DEMO_PROJECT_ID)
    expect(list[0]).toMatchObject({ id: STOCK_IMAGE_ID, name: 'yaac', isDefault: true, state: 'ready' })
    expect(list.find((i) => i.id === id)).toMatchObject({ state: 'building', currentRevision: { number: 2 }, lastBuiltRevision: { number: 1 } })
  })
})

describe('listRevisions', () => {
  it('lists revisions newest first with their build status', async () => {
    const id = await webImage()
    await saveImage(owner, id, { dockerfile: `${LAYERED}RUN echo two\n`, files: {} })
    await nextRequest()
    await settles(async () => {
      expect((await listRevisions(owner, id)).map((r) => [r.number, r.buildStatus])).toEqual([[2, 'running'], [1, 'succeeded']])
    })
  })
})

describe('readImageFile', () => {
  it('reads a revision\'s support file from the store', async () => {
    const id = await webImage()
    const revision = (await getImageDetail(owner, id)).revision!
    expect((await readImageFile(owner, id, revision.id, 'conf/a.txt')).toString()).toBe('hello')
    await expect(readImageFile(owner, id, revision.id, 'nope')).rejects.toThrow(/no stored file/)
  })
})

describe('restoreRevision', () => {
  it('appends a revision with an old one\'s content, naming files whose bytes are gone', async () => {
    const id = await webImage()
    const first = (await getImageDetail(owner, id)).revision!
    await saveImage(owner, id, { dockerfile: `${LAYERED}RUN echo two\n`, files: {} })
    await nextRequest()
    await fs.rm(globalProjectPath(DEMO_PROJECT_ID, 'image-blobs'), { recursive: true })
    const restored = await restoreRevision(owner, id, first.id)
    expect(restored.droppedFiles).toEqual(['conf/a.txt'])
    expect(restored.revision).toMatchObject({ number: 3, dockerfile: LAYERED, files: {}, note: 'restored revision 1' })
  })
})

describe('deleteImage', () => {
  it('deletes the image and its history, and forgets it as the project default', async () => {
    const id = await webImage()
    await setDefaultImage(owner, DEMO_PROJECT_ID, id)
    await deleteImage(owner, id)
    expect((await listProjectImages(owner, DEMO_PROJECT_ID)).map((i) => i.name)).toEqual(['yaac', 'seed'])
    expect((await getProjectRow(DEMO_PROJECT_ID))?.defaultImageId).toBeUndefined()
  })
})

describe('removeProjectImages', () => {
  it('stops a project\'s builds and deletes its images, build rows and logs', async () => {
    const id = await webImage()
    const [done] = await listImageBuilds({ imageId: id })
    await saveImage(owner, id, { dockerfile: `${LAYERED}RUN echo two\n`, files: {} })
    const { request } = await nextRequest()
    await removeProjectImages(DEMO_PROJECT_ID)
    expect(request.signal.aborted).toBe(true)
    expect(await listProjectImages(owner, DEMO_PROJECT_ID)).toEqual([expect.objectContaining({ id: STOCK_IMAGE_ID })])
    expect(await listImageBuilds({ projectId: DEMO_PROJECT_ID })).toEqual([])
    await expect(fs.access(done.logPath!)).rejects.toThrow()
  })
})

describe('setDefaultImage', () => {
  it('sets a project image or the stock image as the default', async () => {
    const id = await webImage()
    await setDefaultImage(owner, DEMO_PROJECT_ID, id)
    expect((await getProjectRow(DEMO_PROJECT_ID))?.defaultImageId).toBe(id)
    await setDefaultImage(owner, DEMO_PROJECT_ID, STOCK_IMAGE_ID)
    expect((await getProjectRow(DEMO_PROJECT_ID))?.defaultImageId).toBeUndefined()
    await expect(setDefaultImage(owner, DEMO_PROJECT_ID, '00000000-1111-4000-8000-000000000000')).rejects.toThrow(/no such image/)
  })
})

describe('setImageCacheDays', () => {
  it('sets a project\'s cache age, which its builds then use', async () => {
    await setImageCacheDays(owner, DEMO_PROJECT_ID, 7)
    await createProjectImage(owner, DEMO_PROJECT_ID, 'web', { dockerfile: LAYERED, files: {} })
    expect((await nextRequest()).request.cacheMaxDays).toBe(7)
    await expect(setImageCacheDays(owner, DEMO_PROJECT_ID, 0)).rejects.toThrow(/1 to 365/)
  })
})

describe('resolveImageName', () => {
  it('names the stock image `yaac` and the project\'s by their names', async () => {
    const id = await webImage()
    await expect(resolveImageName(DEMO_PROJECT_ID, 'yaac')).resolves.toBe(STOCK_IMAGE_ID)
    await expect(resolveImageName(DEMO_PROJECT_ID, 'web')).resolves.toBe(id)
    await expect(resolveImageName(DEMO_PROJECT_ID, 'nope')).rejects.toThrow(/no image named "nope"/)
  })
})

describe('saveUserImage', () => {
  it('creates the user\'s own image on its first save, refusing one not layered', async () => {
    await expect(saveUserImage(owner, { dockerfile: 'FROM ubuntu', files: {} })).rejects.toThrow(/ARG BASE_IMAGE/)
    // It builds on top of each owned project's default image.
    missing = ['user']
    const { revision, builds } = await saveUserImage(owner, { dockerfile: LAYERED, files: {} })
    expect(revision.number).toBe(1)
    expect(builds.map((b) => b.layer)).toEqual(['user'])
    const { request } = await nextRequest()
    expect(request.layers).toEqual(['user'])
    expect(request.spec.layers.map((l) => l.layer)).toEqual(['user'])
  })
})

describe('getUserImage', () => {
  it('answers the caller\'s user image, or null', async () => {
    expect(await getUserImage(owner)).toBeNull()
    await saveUserImage(owner, { dockerfile: LAYERED, files: {} })
    expect(await getUserImage(owner)).toMatchObject({ scope: 'user', name: 'Dockerfile.user' })
  })
})

describe('requestImageBuild', () => {
  it('builds now, without cache when asked, joining a build of the same chain only if it too skips the cache', async () => {
    const id = await webImage()
    // The tag is gone again: a cached build of it starts.
    const cached = await requestImageBuild(owner, id, {})
    expect(cached).toEqual([expect.objectContaining({ reason: 'manual', noCache: false })])
    expect((await nextRequest()).request.noCache).toBe(false)
    // A no-cache request while it runs is a build of its own, which a
    // second no-cache request joins.
    const builds = await requestImageBuild(owner, id, { noCache: true })
    expect(builds).toEqual([expect.objectContaining({ reason: 'manual', noCache: true })])
    expect(builds[0].id).not.toBe(cached[0].id)
    const again = await requestImageBuild(owner, id, { noCache: true })
    expect(again.map((b) => b.id)).toEqual(builds.map((b) => b.id))
    expect((await nextRequest()).request.noCache).toBe(true)
  })

  it('runs one build for requests of the same chain that arrive together', async () => {
    const id = await webImage()
    const [a, b] = await Promise.all([requestImageBuild(owner, id, {}), requestImageBuild(owner, id, {})])
    expect(b.map((x) => x.id)).toEqual(a.map((x) => x.id))
    await nextRequest()
    expect(requests).toEqual([])
    expect((await listImageBuilds({ imageId: id })).filter((r) => r.status === 'queued' || r.status === 'running')).toHaveLength(1)
  })
})

describe('getBuild', () => {
  it('answers a build with its live progress and what it consumed', async () => {
    const id = await webImage()
    const [build] = await listBuilds(owner, { imageId: id })
    expect(await getBuild(owner, build.id)).toMatchObject({
      status: 'succeeded', totalSteps: 2, cachedSteps: 0, layer: 'project', revisionNumber: 1,
      warnings: [{ message: 'JSONArgsRecommended: use JSON (line 3)', line: 3 }],
      baseDigests: { 'fake-tools:t': `sha256:${'a'.repeat(64)}` },
    })
    await expect(getBuild(stranger, build.id)).rejects.toThrow(/owner/)
  })

  it('counts cached steps, and marks a layer above a failed one as never run', async () => {
    missing = ['project', 'user']
    await saveUserImage(owner, { dockerfile: `${LAYERED}RUN echo mine\n`, files: {} })
    const created = await createProjectImage(owner, DEMO_PROJECT_ID, 'two', { dockerfile: `${LAYERED}RUN echo two\n`, files: {} })
    const { request, settle } = await settles(() => {
      const r = requests.find((x) => x.request.spec.layers.some((l) => l.dockerfile.includes('RUN echo two')))
      expect(r).toBeDefined()
      return r!
    })
    expect(request.layers).toEqual(['project', 'user'])
    request.onLine('project', '#5 CACHED')
    settle({ ok: false, error: 'exit code 1', failedLayer: 'project', blockedHosts: [] })
    await settles(async () => {
      const rows = await listBuilds(owner, { imageId: created.id })
      expect(rows[0]).toMatchObject({ layer: 'project', status: 'failed', cachedSteps: 1 })
    })
    const user = (await listBuilds(owner, { projectId: DEMO_PROJECT_ID })).find((b) => b.layer === 'user' && b.revisionNumber === 1 && b.status === 'cancelled')
    expect(user).toMatchObject({ error: 'an earlier layer failed' })
  })
})

describe('listBuilds', () => {
  it('lists a project\'s or an image\'s builds, newest first', async () => {
    const id = await webImage()
    await requestImageBuild(owner, id, { noCache: true })
    expect((await listBuilds(owner, { projectId: DEMO_PROJECT_ID })).map((b) => b.reason)).toEqual(['manual', 'save', 'save'])
    await expect(listBuilds(owner, {})).rejects.toThrow(/name a project or an image/)
  })
})

describe('buildLog', () => {
  it('reads a build\'s log from an offset', async () => {
    const id = await webImage()
    const [build] = await listBuilds(owner, { imageId: id })
    const first = await buildLog(owner, build.id, 0)
    expect(first.text).toContain('#6 [2/2] RUN echo hi')
    expect(await buildLog(owner, build.id, first.offset)).toEqual({ text: '', offset: first.offset, done: true })
  })
})

describe('cancelBuild', () => {
  it('cancels a queued or running build, and refuses a finished one', async () => {
    const id = await webImage()
    const [build] = await requestImageBuild(owner, id, { noCache: true })
    const { request, settle } = await nextRequest()
    await cancelBuild(owner, build.id)
    expect(request.signal.aborted).toBe(true)
    settle({ ok: false, error: 'cancelled', blockedHosts: [] })
    await settles(async () => { expect((await getBuild(owner, build.id)).status).toBe('cancelled') })
    await expect(cancelBuild(owner, build.id)).rejects.toThrow(/already ended/)
  })

  it('stops only the build it names, while it is queued or still being written', async () => {
    await setBuildConcurrency(1)
    const id = await webImage()
    // One build runs; two more queue behind it.
    await saveImage(owner, id, { dockerfile: `${LAYERED}RUN a\n`, files: {} })
    const running = await nextRequest()
    const queued = (await saveImage(owner, id, { dockerfile: `${LAYERED}RUN b\n`, files: {} })).builds
    // Cancelled as soon as its row exists, which may be before its job is
    // queued: either way it never runs, and nothing else is dropped.
    const forming = saveImage(owner, id, { dockerfile: `${LAYERED}RUN c\n`, files: {} })
    const cancelled = await settles(async () => {
      const row = (await listImageBuilds({ imageId: id })).find((b) => b.status === 'queued' && !queued.some((q) => q.id === b.id))
      expect(row).toBeDefined()
      return row!
    })
    await cancelBuild(owner, cancelled.id)
    await forming
    running.settle({ ok: true, blockedHosts: [] })
    // The other queued build runs next; the cancelled one never does.
    const next = await nextRequest()
    expect(next.request.spec.layers[0].dockerfile).toContain('RUN b')
    next.settle({ ok: true, blockedHosts: [] })
    await settles(async () => { expect((await getBuild(owner, cancelled.id)).status).toBe('cancelled') })
    expect(requests).toEqual([])
  })
})

describe('retryBuild', () => {
  it('builds the same revision again', async () => {
    const id = await webImage()
    const [build] = await listBuilds(owner, { imageId: id })
    await retryBuild(owner, build.id, { noCache: true })
    const { request } = await nextRequest()
    expect(request.noCache).toBe(true)
    expect(await listImageBuilds({ imageId: id })).toHaveLength(2)
  })
})

describe('allowBuildHost', () => {
  it('allows a refused registry\'s hosts together, then builds again', async () => {
    const id = await webImage()
    const [build] = await listBuilds(owner, { imageId: id })
    const { allowed, builds } = await allowBuildHost(owner, build.id, 'registry-1.docker.io')
    expect(builds).toEqual([expect.objectContaining({ imageId: id, reason: 'manual' })])
    expect(allowed).toEqual(expect.arrayContaining(['registry-1.docker.io', 'auth.docker.io', 'production.cloudflare.docker.com']))
    expect((await getProjectAllowlist(DEMO_PROJECT_ID)).hosts).toEqual(expect.arrayContaining(allowed))
    await nextRequest()
  })
})

describe('imageForCreate', () => {
  it('launches the last built revision, waits only when asked or nothing is built, and remembers the choice', async () => {
    // The stock image, with nothing missing, launches at once.
    expect(await imageForCreate({ projectId: DEMO_PROJECT_ID, imageId: STOCK_IMAGE_ID })).toEqual({ ref: 'registry.test/fake-tools:t', tag: 'fake-tools:t' })
    const id = await webImage()
    const built = (await getImageDetail(owner, id)).revision!
    await saveImage(owner, id, { dockerfile: `${LAYERED}RUN echo two\n`, files: {} })
    const saveBuild = await nextRequest()
    // A save in progress never holds a create up.
    const launched = await imageForCreate({ projectId: DEMO_PROJECT_ID, imageId: id })
    expect(launched).toMatchObject({ imageId: id, revisionId: built.id })
    expect((await getProjectRow(DEMO_PROJECT_ID))?.lastImageId).toBe(id)
    // Waiting for the revision being built joins that build, and reports
    // progress once it has: a build that ended first would not be joined.
    const joined = vi.fn()
    const waited = imageForCreate({ projectId: DEMO_PROJECT_ID, imageId: id, awaitBuild: true, remember: false, onProgress: joined })
    await settles(() => { expect(joined).toHaveBeenCalledTimes(1) })
    saveBuild.settle({ ok: true, blockedHosts: [] })
    expect((await waited).revisionId).not.toBe(built.id)
    // A failed build fails the create that waited on it.
    await saveImage(owner, id, { dockerfile: `${LAYERED}RUN false\n`, files: {} })
    const failing = await nextRequest()
    const waitedFail = imageForCreate({ projectId: DEMO_PROJECT_ID, imageId: id, awaitBuild: true, onProgress: joined })
    await settles(() => { expect(joined).toHaveBeenCalledTimes(2) })
    failing.settle({ ok: false, error: 'exit code 1', blockedHosts: [] })
    await expect(waitedFail).rejects.toThrow(/the image build failed: exit code 1/)
  })

  it('follows the project default until a create names an image, remembering the stock image too', async () => {
    const id = await webImage()
    await setDefaultImage(owner, DEMO_PROJECT_ID, id)
    expect(await imageForCreate({ projectId: DEMO_PROJECT_ID })).toMatchObject({ imageId: id })
    expect((await getProjectRow(DEMO_PROJECT_ID))?.lastImageId).toBeUndefined()
    await imageForCreate({ projectId: DEMO_PROJECT_ID, imageId: STOCK_IMAGE_ID })
    expect((await getProjectRow(DEMO_PROJECT_ID))?.lastImageId).toBe(STOCK_IMAGE_ID)
  })

  it('launches an image under its owner\'s user image as it is now, building that layer first when it changed', async () => {
    const id = await webImage()
    const before = await imageForCreate({ projectId: DEMO_PROJECT_ID, imageId: id, remember: false })
    // A user image saved since: the image's last built tag tops the old
    // user layer (none), so the create builds the new one on top.
    missing = ['user']
    await saveUserImage(owner, { dockerfile: `${LAYERED}RUN echo mine\n`, files: {} })
    await settles(() => { expect(requests.length).toBeGreaterThan(0) })
    for (const r of requests.splice(0)) r.settle({ ok: true, blockedHosts: [] })
    const after = imageForCreate({ projectId: DEMO_PROJECT_ID, imageId: id, remember: false })
    const { request, settle } = await nextRequest()
    expect(request.layers).toEqual(['user'])
    settle({ ok: true, blockedHosts: [] })
    const launched = await after
    expect(launched.revisionId).toBe(before.revisionId)
    expect(launched.tag).not.toBe(before.tag)
  })
})

describe('spareImageTag', () => {
  it('is the last built tag of the image the last create chose, else the project default\'s', async () => {
    expect(await spareImageTag(DEMO_PROJECT_ID)).toBe('fake-tools:t')
    const id = await webImage()
    await setDefaultImage(owner, DEMO_PROJECT_ID, id)
    const built = (await getImage(id))?.lastBuiltTag
    expect(built).toMatch(new RegExp(`^fake-project-${DEMO_PROJECT_ID}:`))
    expect(await spareImageTag(DEMO_PROJECT_ID)).toBe(built)
    await imageForCreate({ projectId: DEMO_PROJECT_ID, imageId: STOCK_IMAGE_ID })
    expect(await spareImageTag(DEMO_PROJECT_ID)).toBe('fake-tools:t')
    await imageForCreate({ projectId: DEMO_PROJECT_ID, imageId: id })
    expect(await spareImageTag(DEMO_PROJECT_ID)).toBe(built)
  })
})
