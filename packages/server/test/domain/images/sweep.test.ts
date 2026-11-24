/**
 * The image sweep, what image GC keeps, and support-file GC
 * (docs/image-builds.md "Behavior", docs/image-gc.md). The fake
 * driver's registry lacks what `missing` names.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createProjectImage,
  keptImageTags,
  pruneImageBlobs,
  reconcileImageSweep,
  saveImage,
  saveUserImage,
  imageForCreate,
  setDefaultImage,
  uploadImageFile,
} from '#domain/images'
import { BUILT_IN_USER_ID, listImageBuilds, updateImageBuild } from '#db'
import { closeDb } from '#db/client'
import { _resetImageBuildsForTests } from '#domain/images/builds'
import { cleanupTempDir, createTempDataDir } from '@yaac/test-utils/setup'
import { DEMO_PROJECT_ID, recordTestProject } from '@yaac/test-utils/project-fixture'
import { globalProjectPath } from '@yaac/shared/project-paths'
import { installFakeWorkspaceDriver, resetWorkspaceDriver } from '#test/support/fake-driver'
import type { ImageBuildRequest } from '#drivers/contract'
import type { ImageLayerName } from '@yaac/shared/types'

const owner = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const LAYERED = 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n'

let built: ImageBuildRequest[]
let missing: ImageLayerName[]
/** The trusted chain's tag, which every project tag folds in, as the real
 *  ones do: bumping it is a yaac upgrade. */
let toolsTag: string
/** While true, builds wait in `held` until the test releases them. */
let hold: boolean
let held: Array<() => void>
let tmpDir: string

/** Builds settle over several event-loop turns and database writes, which a
 *  loaded machine can stretch past `vi.waitFor`'s one-second default. */
function settles<T>(check: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(check, { timeout: 10_000 })
}

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await recordTestProject(DEMO_PROJECT_ID)
  built = []
  missing = []
  toolsTag = 'fake-tools:t1'
  hold = false
  held = []
  installFakeWorkspaceDriver({
    resolveImageChain: (spec) => {
      const tags = [toolsTag, ...spec.layers.map((l) => `fake-${l.layer}-${spec.projectId}:${toolsTag}-${l.contentHash}`)]
      return Promise.resolve({
        layers: tags.map((tag, i) => ({ name: i === 0 ? 'tools' : spec.layers[i - 1].layer, tag })),
        finalTag: tags.at(-1)!,
      })
    },
    missingImageLayers: (chain) => Promise.resolve(missing.filter((m) => chain.layers.some((l) => l.name === m))),
    buildImageLayers: (request) => {
      built.push(request)
      request.onLayerStart(request.layers[0])
      if (!hold) return Promise.resolve({ ok: true, blockedHosts: [] })
      return new Promise((resolve) => { held.push(() => { resolve({ ok: true, blockedHosts: [] }) }) })
    },
  })
})

afterEach(async () => {
  _resetImageBuildsForTests()
  resetWorkspaceDriver()
  vi.unstubAllEnvs()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

/** A project image, built. */
async function image(name: string, dockerfile = LAYERED): Promise<string> {
  missing = ['project']
  const { id } = await createProjectImage(owner, DEMO_PROJECT_ID, name, { dockerfile, files: {} })
  await settles(async () => { expect((await listImageBuilds({ imageId: id }))[0]?.status).toBe('succeeded') })
  missing = []
  return id
}

describe('reconcileImageSweep', () => {
  it('rebuilds the default image when its chain is missing, and backs off a failure', async () => {
    const id = await image('web')
    await setDefaultImage(owner, DEMO_PROJECT_ID, id)
    built = []
    // Nothing missing: a sweep is lookups only.
    await reconcileImageSweep()
    expect(built).toEqual([])
    // A yaac upgrade: a new trusted chain, so a new tag for the image.
    toolsTag = 'fake-tools:t2'
    missing = ['project']
    await reconcileImageSweep()
    await settles(() => { expect(built).toHaveLength(1) })
    expect((await listImageBuilds({ imageId: id }))[0].reason).toBe('prewarm')
    // A recent failure of that tag holds the sweep off.
    await settles(async () => { expect((await listImageBuilds({ imageId: id }))[0].status).toBe('succeeded') })
    const [last] = await listImageBuilds({ imageId: id })
    await updateImageBuild(last.id, { status: 'failed', finishedAt: new Date() })
    built = []
    await reconcileImageSweep()
    expect(built).toEqual([])
    // Not in e2e, where tests build what they need.
    vi.stubEnv('YAAC_REQUIRE_PREBUILT_IMAGES', '1')
    await updateImageBuild(last.id, { finishedAt: new Date(0) })
    await reconcileImageSweep()
    expect(built).toEqual([])
  })

  it('rebuilds the last used image beside the default, starts each once while it runs, and is off under YAAC_IMAGE_PREWARM=0', async () => {
    const web = await image('web')
    const api = await image('api', `${LAYERED}RUN echo api\n`)
    await setDefaultImage(owner, DEMO_PROJECT_ID, web)
    await imageForCreate({ projectId: DEMO_PROJECT_ID, imageId: api })
    built = []
    toolsTag = 'fake-tools:t2'
    missing = ['project']
    hold = true
    await reconcileImageSweep()
    await settles(() => { expect(built).toHaveLength(2) })
    // Both still building: a pass starts neither again.
    await reconcileImageSweep()
    expect(built).toHaveLength(2)
    for (const release of held.splice(0)) release()
    await settles(async () => {
      for (const id of [web, api]) expect((await listImageBuilds({ imageId: id }))[0].status).toBe('succeeded')
    })
    hold = false
    built = []
    vi.stubEnv('YAAC_IMAGE_PREWARM', '0')
    toolsTag = 'fake-tools:t3'
    await reconcileImageSweep()
    expect(built).toEqual([])
  })

  it('rebuilds the stock chain under its owner\'s user image, and a cancelled build holds it off', async () => {
    missing = ['user']
    await saveUserImage(owner, { dockerfile: LAYERED, files: {} })
    await settles(() => { expect(built).toHaveLength(1) })
    built = []
    toolsTag = 'fake-tools:t2'
    await reconcileImageSweep()
    await settles(() => { expect(built).toHaveLength(1) })
    expect(built[0].layers).toEqual(['user'])
    expect(built[0].spec.layers.map((l) => l.layer)).toEqual(['user'])
    const [last] = await settles(async () => {
      const rows = await listImageBuilds({ projectId: DEMO_PROJECT_ID })
      expect(rows[0].status).toBe('succeeded')
      return rows
    })
    await updateImageBuild(last.id, { status: 'cancelled', finishedAt: new Date() })
    built = []
    await reconcileImageSweep()
    expect(built).toEqual([])
  })
})

describe('keptImageTags', () => {
  it('keeps each image\'s two newest builds and its last built chain', async () => {
    const id = await image('web')
    for (const n of [2, 3]) {
      missing = ['project']
      await saveImage(owner, id, { dockerfile: `${LAYERED}RUN echo ${n}\n`, files: {} })
      await settles(async () => { expect((await listImageBuilds({ imageId: id })).filter((b) => b.status === 'succeeded')).toHaveLength(n) })
    }
    const builds = await listImageBuilds({ imageId: id })
    const kept = await keptImageTags()
    expect(kept).toEqual(expect.arrayContaining([builds[0].tag, builds[1].tag]))
    expect(kept).not.toContain(builds[2].tag)
  })
})

describe('pruneImageBlobs', () => {
  it('drops support files no kept revision names', async () => {
    const id = await image('web')
    const old = await uploadImageFile(owner, { imageId: id }, Buffer.from('old'))
    for (const [n, files] of [[2, { a: old }], [3, {}], [4, {}]] as const) {
      missing = ['project']
      await saveImage(owner, id, { dockerfile: `${LAYERED}RUN echo ${n}\n`, files })
      await settles(async () => { expect((await listImageBuilds({ imageId: id })).filter((b) => b.status === 'succeeded')).toHaveLength(n) })
    }
    const blob = path.join(globalProjectPath(DEMO_PROJECT_ID, 'image-blobs'), old.sha256)
    // An upload no revision names yet is kept for a day, so a file added in
    // the editor survives until its revision is saved.
    const unsaved = await uploadImageFile(owner, { imageId: id }, Buffer.from('unsaved'))
    const unsavedBlob = path.join(globalProjectPath(DEMO_PROJECT_ID, 'image-blobs'), unsaved.sha256)
    const dayAgo = new Date(Date.now() - 25 * 60 * 60_000)
    await fs.utimes(blob, dayAgo, dayAgo)
    // Revision 2 is neither among the two newest revisions nor made one of
    // the two newest builds, so its file goes, once past that day.
    await pruneImageBlobs()
    await expect(fs.access(blob)).rejects.toThrow()
    await fs.access(unsavedBlob)
  })
})
