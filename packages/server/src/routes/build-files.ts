import { Hono, type Context } from 'hono'
import { zv } from '#routes/validator'
import { z } from 'zod'
import { herd } from '#herd'

/**
 * Routes over one build dir's support files, mounted twice: under
 * `/project/:slug/build-files` and `/config/user-build-files`, with
 * `resolveRoot` supplying the scope's build dir per request.
 *
 * Writes take JSON — `content` for text (the editor), `contentBase64` for
 * uploads — rather than multipart, so uploads ride the same typed RPC
 * client, validator, and error envelope as every other route. The ~33%
 * base64 overhead is irrelevant at build-context scale, and folder uploads
 * are per-file requests, which keeps request sizes bounded and progress
 * reporting trivial.
 */
export function buildFilesApp(resolveRoot: (c: Context) => Promise<string>) {
  return new Hono()
    .get('/', async (c) => c.json({ files: await herd().projects.listBuildFiles(await resolveRoot(c)) }))
    .get(
      '/file',
      zv('query', z.object({ path: z.string().min(1) })),
      async (c) =>
        c.json(await herd().projects.readBuildFile(await resolveRoot(c), c.req.valid('query').path)),
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
        return c.json(await herd().projects.writeBuildFile(await resolveRoot(c), rel, data))
      },
    )
    .post(
      '/rename',
      zv('json', z.object({ from: z.string().min(1), to: z.string().min(1) })),
      async (c) => {
        const { from, to } = c.req.valid('json')
        return c.json(await herd().projects.renameBuildFile(await resolveRoot(c), from, to))
      },
    )
    .delete(
      '/file',
      zv('query', z.object({ path: z.string().min(1) })),
      async (c) => {
        await herd().projects.deleteBuildFile(await resolveRoot(c), c.req.valid('query').path)
        return c.body(null, 204)
      },
    )
}
