import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { MAMA_BODY_LIMIT, mamaRelayApp, workspaceApp } from '#routes/workspaces'
import { toErrorBody } from '#api/http/errors'
import { BUILT_IN_USER_ID } from '#db'
import { recordProject } from '#db/project-store'
import { insertQueuedWorkspace } from '#db/queued-workspace-store'
import { insertDraftWorkspace } from '#db/draft-workspace-store'
import { closeDb } from '#db/client'
import { recordWorkspaceCreated, recordWorkspaceStopped } from '#db/workspace-store'
import { recordConversations } from '#db/conversation-store'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import {
  CONVERSATION_PROMPT_PREVIEW_LENGTH,
  MAX_PROMPT_LENGTH,
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

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'
/** A prompt of the maximum length, multibyte throughout. */
const LONG = 'é✓🙂 fix it\n'.repeat(MAX_PROMPT_LENGTH).slice(0, MAX_PROMPT_LENGTH)

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await recordProject({ id: PROJ, name: 'demo', remoteUrl: 'https://example.com/proj', addedAt: '2026-01-01T00:00:00.000Z' }, BUILT_IN_USER_ID)
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

  it('takes a prompt of the maximum length however it is escaped, and refuses more', async () => {
    const maximal = envelope('é'.repeat(MAX_PROMPT_LENGTH))
    expect(Buffer.byteLength(maximal)).toBeGreaterThan(MAX_PROMPT_LENGTH * 6)
    expect((await post(maximal)).status).toBe(401)
    // A raw multibyte prompt passes the same way.
    expect((await post(JSON.stringify({ command: 'queue', body: LONG }))).status).toBe(401)

    // Counted in UTF-16 units, as every bound on a prompt is: an emoji
    // counts twice.
    for (const prompt of ['é'.repeat(MAX_PROMPT_LENGTH + 1), '🙂'.repeat(MAX_PROMPT_LENGTH / 2 + 1)]) {
      const over = await post(envelope(prompt))
      expect(over.status).toBe(400)
      expect(await over.json()).toMatchObject({
        error: { message: 'body: the prompt is over the 200,000-character limit' },
      })
    }
    expect((await post(JSON.stringify({ command: 'queue', body: ' '.repeat(MAMA_BODY_LIMIT) }))).status).toBe(413)
  })
})

describe('GET /prompt', () => {
  it('returns a queued entry\'s or draft\'s whole prompt', async () => {
    const queued = await insertQueuedWorkspace(PROJ, { parentWorkspaceId: 'w-1' }, {
      prompt: LONG, tool: 'claude', model: 'opus', mode: 'tui', permissionMode: 'manual', branch: 'main',
    })
    const draft = await insertDraftWorkspace(PROJ, { prompt: `${LONG.slice(1)}!`, tool: 'claude', mode: 'tui', permissionMode: 'manual' })
    for (const [id, prompt] of [[queued.id, LONG], [draft.id, `${LONG.slice(1)}!`]]) {
      const res = await app.request(`/prompt?id=${id}`)
      expect(res.status).toBe(200)
      expect(((await res.json()) as { prompt: string }).prompt === prompt).toBe(true)
    }
    expect((await app.request('/prompt?id=7a3b2e4c-9d5f-4a0b-8c8e-2f3a4b5c6d7e')).status).toBe(404)
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
