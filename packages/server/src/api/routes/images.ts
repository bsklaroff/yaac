import { Hono } from 'hono'
import { z } from 'zod'
import { zv } from '#routes/validator'
import { requireAdmin } from '#domain/access'
import { resolveProjectId } from '#domain/projects'
import {
  allowBuildHost,
  buildConcurrency,
  buildLog,
  cancelBuild,
  createProjectImage,
  deleteImage,
  getBuild,
  getImageDetail,
  getUserImage,
  listBuilds,
  listProjectImages,
  listRevisions,
  readImageFile,
  requestImageBuild,
  restoreRevision,
  retryBuild,
  saveImage,
  saveUserImage,
  setBuildConcurrency,
  setDefaultImage,
  setImageCacheDays,
  uploadImageFile,
} from '#domain/images'
import { isBinaryContent } from '#lib/text-file'
import { requireDriverFeature } from '#api/http/driver-features'
import { personOnly, type IdentityEnv } from '#api/http/web-auth'

/**
 * Images, their revisions and builds (docs/image-builds.md), mounted at
 * `/image`. A save names its support files by the hash an upload returned,
 * so a file is sent once and a revision is one request. Logs are polled by
 * byte offset while a build page is open.
 *
 * Every route refuses on a runtime that builds no images
 * (`requireDriverFeature`).
 */

const content = z.object({
  dockerfile: z.string(),
  files: z.record(z.string(), z.object({ sha256: z.string(), size: z.number().int().nonnegative() })).default({}),
  note: z.string().max(500).optional(),
})

/** One support file's bytes, as text or base64. */
const upload = z.object({ content: z.string().optional(), contentBase64: z.string().optional() }).refine(
  (b) => (b.content === undefined) !== (b.contentBase64 === undefined),
  { message: 'Provide exactly one of content / contentBase64.' },
)

function bytesOf(body: z.infer<typeof upload>): Buffer {
  return body.content !== undefined ? Buffer.from(body.content, 'utf8') : Buffer.from(body.contentBase64!, 'base64')
}

export const imageApp = new Hono<IdentityEnv>()
  // A user image is its user's alone, so a delegate is refused before
  // anything else answers, the feature check included.
  .use('/user', personOnly)
  .use('/user/*', personOnly)
  .use('*', async (_c, next) => {
    requireDriverFeature('images')
    await next()
  })
  .get('/settings', async (c) => c.json({ buildConcurrency: await buildConcurrency() }))
  .put('/settings', zv('json', z.object({ buildConcurrency: z.number().int().nullable() })), async (c) => {
    await requireAdmin(c.get('principal'), 'change the image build concurrency')
    return c.json({ buildConcurrency: await setBuildConcurrency(c.req.valid('json').buildConcurrency) })
  })
  .get('/project/:projectId', async (c) => c.json(await listProjectImages(c.get('principal'), await resolveProjectId(c.req.param('projectId')))))
  .post('/project/:projectId', zv('json', content.extend({ name: z.string() })), async (c) => {
    const { name, ...body } = c.req.valid('json')
    return c.json(await createProjectImage(c.get('principal'), await resolveProjectId(c.req.param('projectId')), name, body), 201)
  })
  .put('/project/:projectId/default', zv('json', z.object({ imageId: z.string() })), async (c) => {
    await setDefaultImage(c.get('principal'), await resolveProjectId(c.req.param('projectId')), c.req.valid('json').imageId)
    return c.body(null, 204)
  })
  .put('/project/:projectId/cache-days', zv('json', z.object({ days: z.number().int().nullable() })), async (c) => {
    await setImageCacheDays(c.get('principal'), await resolveProjectId(c.req.param('projectId')), c.req.valid('json').days)
    return c.body(null, 204)
  })
  // A support file uploaded before the image it goes in exists.
  .post('/project/:projectId/files', zv('json', upload), async (c) =>
    c.json(await uploadImageFile(c.get('principal'), { projectId: await resolveProjectId(c.req.param('projectId')) }, bytesOf(c.req.valid('json')))))
  .post('/user/files', zv('json', upload), async (c) =>
    c.json(await uploadImageFile(c.get('principal'), { user: true }, bytesOf(c.req.valid('json')))))
  .get('/user', async (c) => c.json({ image: await getUserImage(c.get('principal')) }))
  .put('/user', zv('json', content), async (c) => c.json(await saveUserImage(c.get('principal'), c.req.valid('json'))))
  .get('/builds', zv('query', z.object({ projectId: z.string().optional(), imageId: z.string().optional() })), async (c) =>
    c.json(await listBuilds(c.get('principal'), c.req.valid('query'))))
  .get('/builds/:buildId', async (c) => c.json(await getBuild(c.get('principal'), c.req.param('buildId'))))
  .get('/builds/:buildId/log', zv('query', z.object({ offset: z.coerce.number().int().nonnegative().default(0) })), async (c) =>
    c.json(await buildLog(c.get('principal'), c.req.param('buildId'), c.req.valid('query').offset)))
  .post('/builds/:buildId/cancel', async (c) => {
    await cancelBuild(c.get('principal'), c.req.param('buildId'))
    return c.body(null, 204)
  })
  // Allow a refused host (with its registry's other hosts) for the build's
  // project, then build again.
  .post('/builds/:buildId/allow-host', zv('json', z.object({ host: z.string().min(1) })), async (c) =>
    c.json(await allowBuildHost(c.get('principal'), c.req.param('buildId'), c.req.valid('json').host), 202))
  .post('/builds/:buildId/retry', zv('json', z.object({ noCache: z.boolean().optional() })), async (c) =>
    c.json(await retryBuild(c.get('principal'), c.req.param('buildId'), c.req.valid('json')), 202))
  .get('/:imageId', async (c) => c.json(await getImageDetail(c.get('principal'), c.req.param('imageId'))))
  .put('/:imageId', zv('json', content), async (c) =>
    c.json(await saveImage(c.get('principal'), c.req.param('imageId'), c.req.valid('json'))))
  .delete('/:imageId', async (c) => {
    await deleteImage(c.get('principal'), c.req.param('imageId'))
    return c.body(null, 204)
  })
  .post('/:imageId/files', zv('json', upload), async (c) =>
    c.json(await uploadImageFile(c.get('principal'), { imageId: c.req.param('imageId') }, bytesOf(c.req.valid('json')))))
  .get('/:imageId/revisions', async (c) => c.json(await listRevisions(c.get('principal'), c.req.param('imageId'))))
  .get('/:imageId/revisions/:revisionId/file', zv('query', z.object({ path: z.string().min(1) })), async (c) => {
    const data = await readImageFile(c.get('principal'), c.req.param('imageId'), c.req.param('revisionId'), c.req.valid('query').path)
    return isBinaryContent(data)
      ? c.json({ binary: true, contentBase64: data.toString('base64') })
      : c.json({ binary: false, content: data.toString('utf8') })
  })
  .post('/:imageId/revisions/:revisionId/restore', async (c) =>
    c.json(await restoreRevision(c.get('principal'), c.req.param('imageId'), c.req.param('revisionId'))))
  .post('/:imageId/builds', zv('json', z.object({
    revisionId: z.string().optional(),
    noCache: z.boolean().optional(),
    projectId: z.string().optional(),
  })), async (c) => c.json(await requestImageBuild(c.get('principal'), c.req.param('imageId'), c.req.valid('json')), 202))
