import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { recordTestProject } from '@yaac/test-utils/project-fixture'
import { Hono } from 'hono'
import { workspaceApp } from '#routes/workspaces'
import { toErrorBody } from '#api/http/errors'
import { insertQueuedWorkspace } from '#db/queued-workspace-store'
import { insertDraftWorkspace } from '#db/draft-workspace-store'
import { closeDb } from '#db/client'
import { recordWorkspaceCreated, recordWorkspaceStopped } from '#db/workspace-store'
import { recordConversations } from '#db/conversation-store'
import { insertSession } from '#db/session-store'
import { clearAllProvisioningForTests, registerProvisioning } from '#domain/workspaces/provisioning'
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
