import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { recordTestProject } from '@yaac/test-utils/project-fixture'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { MAMA_BODY_LIMIT, mamaRelayApp } from '#api/mama/endpoint'
import { toErrorBody } from '#api/http/errors'
import { closeDb } from '#db/client'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { MAX_ICON_BYTES } from '#domain/projects'
import { MAX_PROMPT_BYTES } from '@yaac/shared/types'

/** A dispatch no case here reaches: each is refused before its command runs. */
const unrouted = () => () => Promise.reject(new Error('no command runs here'))

// Only the root app's onError serializes a ServerError, so wrap the routes
// with the same handler.
const app = new Hono()
  .onError((err, c) => {
    const { status, body } = toErrorBody(err)
    return c.json(body, status as 400 | 401 | 403 | 404 | 413 | 500)
  })
  // A relay whose proxy never authenticates: a request that reaches it got
  // past the body limit and validation, and is refused as 401.
  .route('/relay', mamaRelayApp(() => Promise.resolve(false), unrouted))
  // A relay whose proxy authenticates, naming the caller it was given.
  .route('/proxied', mamaRelayApp(() => Promise.resolve(true), unrouted))

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'
/** A prompt of the maximum size, multibyte throughout: 20 bytes a repeat,
 *  which divides the cap. */
const LONG = 'é✓🙂 fix it no\n'.repeat(MAX_PROMPT_BYTES / 20)

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await recordTestProject(PROJ, { name: 'demo', remoteUrl: 'https://example.com/proj', addedAt: '2026-01-01T00:00:00.000Z' })
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('POST /mama', () => {
  const post = (body: string): Promise<Response> => Promise.resolve(app.request('/relay/mama', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  }))
  /** A queue envelope whose prompt is JSON-escaped as `\uXXXX` per UTF-16 unit, the largest
   *  any client can send it. */
  const envelope = (prompt: string): string => JSON.stringify({
    command: 'queue',
    args: { 'parent-workspace': 'a'.repeat(36), tool: 'claude', title: 't'.repeat(500) },
    body: '__BODY__',
  }).replace('__BODY__', Array.from({ length: prompt.length }, (_, n) =>
    `\\u${prompt.charCodeAt(n).toString(16).padStart(4, '0')}`).join(''))

  // What a body may hold is each command's, or its route's, to check; an
  // unauthenticated caller shows a request got past the size limit.
  it('lets through the largest request a prompt or an icon makes, however it is escaped, and no more', async () => {
    // One byte a character, so the most characters to escape.
    const maximal = envelope('a'.repeat(MAX_PROMPT_BYTES))
    expect(Buffer.byteLength(maximal)).toBeGreaterThan(MAX_PROMPT_BYTES * 6)
    expect((await post(maximal)).status).toBe(401)
    // A raw multibyte prompt passes the same way.
    expect((await post(JSON.stringify({ command: 'queue', body: LONG }))).status).toBe(401)
    // An icon goes as base64, well past the prompt cap.
    const icon = Buffer.alloc(MAX_ICON_BYTES).toString('base64')
    expect((await post(JSON.stringify({ command: 'icon-set', body: icon }))).status).toBe(401)
    expect((await post(JSON.stringify({ command: 'queue', body: ' '.repeat(MAMA_BODY_LIMIT) }))).status).toBe(413)
  })

  // A site's release faces the internet, so it may not act on yaac, nor
  // reach a hosted remote (docs/public-sites.md).
  it('refuses a public site\'s release, for yaac-mama and hosted git alike', async () => {
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'rel-1', siteId: '0b3a8d3c-1c1e-4d65-9a43-6f0f1e7b2c11' })
    const headers = { 'content-type': 'application/json', authorization: 'Bearer x', 'x-yaac-workspace-id': 'rel-1' }
    const mama = await app.request('/proxied/mama', { method: 'POST', headers, body: JSON.stringify({ command: 'list' }) })
    expect(mama.status).toBe(403)
    expect(await mama.json()).toMatchObject({ error: { message: expect.stringContaining('may not call yaac') as unknown } })
    expect((await app.request(`/proxied/git/${PROJ}.git/info/refs?service=git-upload-pack`, { headers })).status).toBe(403)
  })
})
