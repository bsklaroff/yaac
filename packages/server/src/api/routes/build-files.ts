import { Hono, type Context } from 'hono'
import { zv } from '#routes/validator'
import { z } from 'zod'
import { deleteBuildFile, listBuildFiles, readBuildFile, renameBuildFile, writeBuildFile } from '#domain/projects'
import { requireDriverFeature } from '#http'

/**
 * Routes over one build dir's support files, mounted under
 * `/project/:slug/build-files` and `/config/user-build-files`; `resolveRoot`
 * gives the build dir per request.
 *
 * Writes take JSON (`content` for text, `contentBase64` for uploads) rather
 * than multipart, so uploads use the same typed RPC client, validator and
 * error envelope as every other route. Base64 overhead is negligible at this
 * scale, and folder uploads send one request per file.
 *
 * The sub-app refuses on a runtime that builds no images, since nothing
 * would read these files.
 */
export function buildFilesApp(resolveRoot: (c: Context) => Promise<string>) {
  return new Hono()
    .use('*', async (_c, next) => {
      requireDriverFeature('images')
      await next()
    })
    .get('/', async (c) => c.json({ files: await listBuildFiles(await resolveRoot(c)) }))
    .get(
      '/file',
      zv('query', z.object({ path: z.string().min(1) })),
      async (c) =>
        c.json(await readBuildFile(await resolveRoot(c), c.req.valid('query').path)),
    )
    .put(
      '/file',
      zv('json', z.object({
        path: z.string().min(1),
        content: z.string().optional(),
        contentBase64: z.string().optional(),
      }).refine(
        (b) => (b.content === undefined) !== (b.contentBase64 === undefined),
        { message: 'Provide exactly one of content / contentBase64.' },
      )),
      async (c) => {
        const { path: rel, content, contentBase64 } = c.req.valid('json')
        const data = content !== undefined
          ? Buffer.from(content, 'utf8')
          : Buffer.from(contentBase64!, 'base64')
        return c.json(await writeBuildFile(await resolveRoot(c), rel, data))
      },
    )
    .post(
      '/rename',
      zv('json', z.object({ from: z.string().min(1), to: z.string().min(1) })),
      async (c) => {
        const { from, to } = c.req.valid('json')
        return c.json(await renameBuildFile(await resolveRoot(c), from, to))
      },
    )
    .delete(
      '/file',
      zv('query', z.object({ path: z.string().min(1) })),
      async (c) => {
        await deleteBuildFile(await resolveRoot(c), c.req.valid('query').path)
        return c.body(null, 204)
      },
    )
}
