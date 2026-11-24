import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { STOCK_IMAGE_ID, type ImageRevision, type ImageSummary } from '@yaac/shared/types'
import { imageBuild, imageCreate, imageEdit, imageLogs, imageUserEdit, projectImage, userImage } from '#commands/image'
import { ME, serveProjects, startFakeApi, type FakeApi } from './fake-api'

/*
 * `yaac image` against a fake server: how a save gathers and uploads its
 * support files, which build it reports, and how a followed build's log
 * is read and ends the command.
 */
let api: FakeApi
let scratch: string
let logged: string[]
let errors: string[]
let written: string[]

const stock: ImageSummary = { id: STOCK_IMAGE_ID, scope: 'project', name: 'yaac', isDefault: true, state: 'ready' }
const tiny: ImageSummary = {
  id: 'img-tiny', scope: 'project', name: 'tiny', isDefault: false, state: 'ready',
  currentRevision: { id: 'rev-2', number: 2, createdAt: '2026-11-20T10:00:00.000Z' }, lastBuiltRevision: { id: 'rev-2', number: 2 },
}
const revision = (id: string, number: number, files: ImageRevision['files'] = {}): ImageRevision => ({
  id, imageId: 'img-tiny', number, dockerfile: 'FROM x\n', files, contentHash: id, author: ME,
  createdAt: '2026-11-20T10:00:00.000Z', missingFiles: [],
})

beforeAll(async () => {
  api = await startFakeApi()
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-image-'))
  vi.stubEnv('YAAC_SERVER_URL', api.url)
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await api.close()
  await fs.rm(scratch, { recursive: true, force: true })
})

beforeEach(() => {
  api.reset()
  logged = []
  errors = []
  written = []
  process.exitCode = undefined
  vi.spyOn(console, 'log').mockImplementation((msg: unknown) => { logged.push(String(msg)) })
  vi.spyOn(console, 'error').mockImplementation((msg: unknown) => { errors.push(String(msg)) })
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk))
    return true
  })
  serveProjects(api, [['id-demo', 'demo']])
  api.on('GET /api/image/project/id-demo', { json: [stock, tiny] })
})

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

const sent = (route: string): unknown[] => api.requests.filter((r) => r.route === route).map((r) => r.body)

/** A context dir holding a Dockerfile, two support files and an ignored
 *  one. */
async function context(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(scratch, 'ctx-'))
  await fs.mkdir(path.join(dir, 'conf'))
  await fs.mkdir(path.join(dir, 'secret'))
  await fs.writeFile(path.join(dir, 'Dockerfile'), 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nCOPY conf/a.txt /a\n')
  await fs.writeFile(path.join(dir, 'conf', 'a.txt'), 'alpha')
  await fs.writeFile(path.join(dir, 'secret', 'key'), 'nope')
  await fs.writeFile(path.join(dir, '.containerignore'), '# not shipped\nsecret/\n')
  return dir
}

/** Answer uploads on `route` with a hash of what was sent. */
function serveUploads(route: string): void {
  api.on(route, (req) => {
    const { contentBase64 } = req.body as { contentBase64: string }
    return { json: { sha256: `sha-${Buffer.from(contentBase64, 'base64').toString()}`, size: 5 } }
  })
}

/** What `context()` uploads, as the manifest a save names them by. */
const CONTEXT_FILES = { 'conf/a.txt': { sha256: 'sha-alpha', size: 5 }, '.containerignore': { sha256: 'sha-# not shipped\nsecret/\n', size: 5 } }
const BUILD = { id: 'build-9', layer: 'project', revisionNumber: 1, status: 'queued' }

describe('imageCreate', () => {
  it('uploads the context less what is ignored, then creates the image with it in one revision, naming its build', async () => {
    const dir = await context()
    serveUploads('POST /api/image/project/id-demo/files')
    api.on('POST /api/image/project/id-demo', { status: 201, json: {
      ...tiny, id: 'img-new', name: 'web', currentRevision: { id: 'rev-1', number: 1, createdAt: '' }, builds: [BUILD],
    } })

    await imageCreate('demo', 'web', { file: path.join(dir, 'Dockerfile'), context: dir, note: 'first' })

    // The Dockerfile itself and the ignored dir stay home.
    const uploaded = (sent('POST /api/image/project/id-demo/files') as Array<{ contentBase64: string }>)
      .map((b) => Buffer.from(b.contentBase64, 'base64').toString()).sort()
    expect(uploaded).toEqual(['# not shipped\nsecret/\n', 'alpha'])
    expect(sent('POST /api/image/project/id-demo')).toEqual([{
      name: 'web', dockerfile: 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nCOPY conf/a.txt /a\n', files: CONTEXT_FILES, note: 'first',
    }])
    expect(logged).toEqual([
      'Created image web in demo.',
      'Saved web as revision 1.',
      'Build build-9: the project layer at revision 1, queued.',
      'Follow it with `yaac image logs build-9 --follow`.',
    ])
  })

  it('refuses a .containerignore pattern the build would not honor', async () => {
    const dir = await context()
    await fs.writeFile(path.join(dir, '.containerignore'), '*.log\n')
    await expect(imageCreate('demo', 'web', { file: path.join(dir, 'Dockerfile'), context: dir })).rejects.toThrow('may list only literal paths, not "*.log"')
    expect(sent('POST /api/image/project/id-demo')).toEqual([])
  })
})

describe('imageEdit', () => {
  it('keeps the current files without --context, and says when nothing changed', async () => {
    const files = { 'a.txt': { sha256: 'sha-a', size: 1 } }
    api.on('GET /api/image/img-tiny', { json: { image: tiny, revision: revision('rev-2', 2, files) } })
    api.on('PUT /api/image/img-tiny', { json: { revision: revision('rev-2', 2, files), changed: false, builds: [] } })
    const stdin = vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from(['FROM y\n']) as typeof process.stdin)
    await imageEdit(await projectImage('demo', 'tiny'), { file: '-', note: 'why' })
    stdin.mockRestore()
    expect(sent('PUT /api/image/img-tiny')).toEqual([{ dockerfile: 'FROM y\n', files, note: 'why' }])
    expect(logged).toEqual(['tiny already has that content, at revision 2; nothing was saved.'])
  })

  it('names images by project, refusing the stock image and an unknown name', async () => {
    await expect(projectImage('demo', 'yaac')).rejects.toThrow('yaac is the stock image')
    await expect(projectImage('demo', 'nope')).rejects.toThrow('demo has no image "nope"; its images are yaac, tiny.')
  })
})

describe('imageUserEdit', () => {
  it('creates the image on a first save with the context\'s files in one revision', async () => {
    const dir = await context()
    api.on('GET /api/image/user', { json: { image: null } })
    serveUploads('POST /api/image/user/files')
    api.on('PUT /api/image/user', { json: { revision: { ...revision('rev-1', 1), imageId: 'img-user' }, changed: true, builds: [] } })

    await imageUserEdit({ file: path.join(dir, 'Dockerfile'), context: dir })

    expect((sent('PUT /api/image/user') as Array<{ files: object }>).map((p) => p.files)).toEqual([CONTEXT_FILES])
    expect(logged).toEqual(['Saved your Dockerfile.user as revision 1, which is already built.'])
    await expect(userImage()).rejects.toThrow('You have no Dockerfile.user')
  })
})

describe('imageBuild', () => {
  it('follows each queued build\'s log by offset with --wait, and exits non-zero when one fails', async () => {
    api.on('GET /api/image/img-tiny/revisions', { json: [revision('rev-2', 2), revision('rev-1', 1)] })
    api.on('POST /api/image/img-tiny/builds', { status: 202, json: [{ id: 'b1', layer: 'project', revisionNumber: 1, status: 'queued' }] })
    api.on('GET /api/image/builds/b1/log', (req) => ({
      json: req.query.get('offset') === '0' ? { text: '#1 [1/2] RUN a\n', offset: 15, done: false } : { text: '#1 ERROR: boom\n', offset: 30, done: true },
    }))
    api.on('GET /api/image/builds/b1', { json: { id: 'b1', status: 'failed', error: 'exit 1', blockedHosts: ['evil.example'] } })

    await imageBuild(await projectImage('demo', 'tiny'), { revision: '1', cache: false, wait: true })

    expect(sent('POST /api/image/img-tiny/builds')).toEqual([{ revisionId: 'rev-1', noCache: true }])
    expect(api.requests.filter((r) => r.route === 'GET /api/image/builds/b1/log').map((r) => r.query.get('offset'))).toEqual(['0', '15'])
    expect(written.join('')).toBe('#1 [1/2] RUN a\n#1 ERROR: boom\n')
    expect(errors[0]).toBe('Build b1 failed: exit 1.')
    expect(errors[1]).toContain('refused evil.example')
    expect(process.exitCode).toBe(1)
    await expect(imageBuild(await projectImage('demo', 'tiny'), { revision: '7' })).rejects.toThrow('tiny has no revision 7; its revisions are 1 to 2.')
  })
})

describe('imageLogs', () => {
  it('prints what the log holds once, without --follow', async () => {
    api.on('GET /api/image/builds/b2/log', { json: { text: '#1 DONE 0.1s\n', offset: 13, done: false } })
    await imageLogs('b2', {})
    expect(written.join('')).toBe('#1 DONE 0.1s\n')
    expect(process.exitCode).toBeUndefined()
  })
})
