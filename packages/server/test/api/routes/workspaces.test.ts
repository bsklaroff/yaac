import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { recordTestProject } from '@yaac/test-utils/project-fixture'
import { Hono } from 'hono'
import { MAMA_BODY_LIMIT, mamaRelayApp, workspaceApp } from '#routes/workspaces'
import { toErrorBody } from '#api/http/errors'
import { insertQueuedWorkspace } from '#db/queued-workspace-store'
import { insertDraftWorkspace } from '#db/draft-workspace-store'
import { closeDb } from '#db/client'
import { recordWorkspaceCreated, recordWorkspaceStopped } from '#db/workspace-store'
import { recordConversations } from '#db/conversation-store'
import { insertSession } from '#db/session-store'
import { clearAllProvisioningForTests, registerProvisioning } from '#domain/workspaces/provisioning'
import { MAX_ICON_BYTES } from '#domain/projects'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import {
  CONVERSATION_PROMPT_PREVIEW_LENGTH,
  MAX_PROMPT_BYTES,
  PROMPT_PREVIEW_LENGTH,
  type StoppedWorkspacePage,
} from '@yaac/shared/types'

// Only the root app's onError serializes a ServerError, so wrap the routes
// with the same handler.
const app = new Hono()
  .onError((err, c) => {
    const { status, body } = toErrorBody(err)
    return c.json(body, status as 400 | 401 | 404 | 413 | 500)
  })
  .route('/', workspaceApp)
  // A relay whose proxy never authenticates: a request that reaches it got
  // past the body limit and validation, and is refused as 401.
  .route('/relay', mamaRelayApp(() => Promise.resolve(false)))
  // A relay whose proxy authenticates, naming the caller it was given.
  .route('/proxied', mamaRelayApp(() => Promise.resolve(true)))

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

  // What a body may hold is each command's to check (`runMamaCommand`); an
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

describe('GET /prompt', () => {
  afterEach(() => { clearAllProvisioningForTests() })

  // A session's comes from its create's provisioning row until the create
  // records the session. One opened on a conversation has that
  // conversation's, as the snapshot shows it.
  it('returns a queued entry\'s, draft\'s or session\'s whole prompt', async () => {
    const queued = await insertQueuedWorkspace(PROJ, { parentWorkspaceId: 'w-1' }, {
      prompt: LONG, tool: 'claude', model: 'opus', mode: 'tui', permissionMode: 'manual', repos: [], nested: false, cwd: '.',
    })
    const draft = await insertDraftWorkspace(PROJ, { prompt: `${LONG.slice(1)}!`, tool: 'claude', mode: 'tui', permissionMode: 'manual' })
    const workspaceId = '6f2a1d3b-8c4e-4f9a-8b7d-1e2f3a4b5c6d'
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId })
    const session = await insertSession(PROJ, workspaceId, {
      cwd: '',
      tool: 'claude', mode: 'acp', permissionMode: 'manual', prompt: `${LONG.slice(2)}?`,
    })
    await recordConversations(PROJ, workspaceId, [{ tool: 'claude', conversationId: 'conv-1', firstPrompt: `${LONG.slice(4)};` }])
    const resumed = await insertSession(PROJ, workspaceId, {
      cwd: '',
      tool: 'claude', mode: 'acp', permissionMode: 'manual', conversationId: 'conv-1',
    })
    const creating = '0b6a1f4e-2c3d-4e5f-8a9b-1c2d3e4f5a6b'
    registerProvisioning({ workspaceId: 'w-2', projectId: PROJ, kind: 'create', sessionId: creating, prompt: `${LONG.slice(3)}.` })
    for (const [id, prompt] of [
      [queued.id, LONG], [draft.id, `${LONG.slice(1)}!`], [session.id, `${LONG.slice(2)}?`], [creating, `${LONG.slice(3)}.`],
      [resumed.id, `${LONG.slice(4)};`],
    ]) {
      const res = await app.request(`/prompt?id=${id}`)
      expect(res.status).toBe(200)
      expect(((await res.json()) as { prompt: string }).prompt === prompt).toBe(true)
    }
    for (const id of ['7a3b2e4c-9d5f-4a0b-8c8e-2f3a4b5c6d7e', 'not-a-uuid']) {
      expect((await app.request(`/prompt?id=${id}`)).status).toBe(404)
    }

    // A create naming a session id already taken, by a session or by a
    // create still provisioning, is refused before it starts.
    for (const id of [session.id, creating]) {
      const res = await app.request('/create', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: PROJ, tool: 'claude', sessionId: id }),
      })
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ error: { message: `session id ${id} is already in use` } })
    }
  })
})

describe('GET /list-stopped', () => {
  it('carries a preview of each prompt, as the snapshot does', async () => {
    installFakeWorkspaceDriver()
    const workspaceId = '6f2a1d3b-8c4e-4f9a-8b7d-1e2f3a4b5c6d'
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId })
    await recordConversations(PROJ, workspaceId, [{ tool: 'claude', conversationId: workspaceId, firstPrompt: LONG }])
    await recordWorkspaceStopped(PROJ, workspaceId)

    const res = await app.request(`/list-stopped?project=${PROJ}`)
    expect(res.status).toBe(200)
    const [entry] = ((await res.json()) as StoppedWorkspacePage).entries
    const prompts = [entry?.prompt ?? '', entry?.conversations[0]?.prompt ?? '']
    expect(prompts.map((p) => p.length)).toEqual([PROMPT_PREVIEW_LENGTH, CONVERSATION_PROMPT_PREVIEW_LENGTH])
    expect(prompts.every((p) => LONG.startsWith(p))).toBe(true)
  })
})
