import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { asTailnet, makeTestApiClient } from '@yaac/test-utils/api'
import { buildApp } from '@yaac/server/main/server'
import { recordWorkspaceCreated } from '@yaac/server/db/workspace-store'
import { recordAgentSessions } from '@yaac/server/db/agent-session-store'
import { closeDb } from '@yaac/server/db/client'
import { acpLogDir, claudeDir } from '@yaac/shared/project-paths'
import { DEMO_PROJECT_ID, recordTestProject } from '@yaac/test-utils/project-fixture'
import type { AcpEvent } from '@yaac/shared/acp'

/**
 * The transcript route over real HTTP, against real files.
 *
 * The route matrix covers only the empty server; this checks what a
 * recorded conversation returns. Nothing below the route is mocked: rows are
 * written through the store and transcripts to disk, since the point is
 * that a transcript is readable with no pod.
 */

const WORKSPACE = 'wt-1'
const ACP_SESSION = '11111111-1111-1111-1111-111111111111'
const TUI_SESSION = '22222222-2222-2222-2222-222222222222'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: WORKSPACE })
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

const client = (): ReturnType<typeof makeTestApiClient> =>
  makeTestApiClient(buildApp({ buildId: 'test' }))

async function get(sessionId: string): Promise<{ status: number; events?: AcpEvent[] }> {
  const res = await client().workspace[':id']['agent-sessions'][':sessionId'].transcript.$get({
    param: { id: WORKSPACE, sessionId },
  })
  if (res.status !== 200) return { status: res.status }
  return { status: res.status, events: (await res.json()).events }
}

/** A recorded acp conversation: one prompt and its answer, as acpd logs it. */
async function recordAcpConversation(): Promise<void> {
  await recordAgentSessions(DEMO_PROJECT_ID, WORKSPACE, [
    { tool: 'claude', agentSessionId: ACP_SESSION, mode: 'acp' },
  ])
  const dir = acpLogDir(DEMO_PROJECT_ID, WORKSPACE)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${ACP_SESSION}.jsonl`), [
    { jsonrpc: '2.0', method: '_acpd/life', params: { id: 'life-1' } },
    {
      jsonrpc: '2.0', id: 1, method: 'session/prompt',
      params: { sessionId: ACP_SESSION, prompt: [{ type: 'text', text: 'ship it' }] },
    },
    {
      jsonrpc: '2.0', method: 'session/update',
      params: {
        sessionId: ACP_SESSION,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'shipped' } },
      },
    },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n')
}

describe('GET /workspace/:id/agent-sessions/:sessionId/transcript', () => {
  it('serves an acp conversation from the record acpd wrote', async () => {
    await recordAcpConversation()

    const { status, events } = await get(ACP_SESSION)

    expect(status).toBe(200)
    expect(events?.map((e) => e.type)).toEqual(['user', 'agent'])
  })

  // Transcripts are `reader`: any user may read another's.
  it('serves another user\'s conversation to a teammate', async () => {
    vi.stubEnv('YAAC_ALLOWED_HOSTS', 'srv.tailnet.ts.net')
    await recordTestProject(DEMO_PROJECT_ID)
    await recordAcpConversation()

    const tailnetApp = buildApp({ buildId: 'test', access: () => 'tailnet' })
    const res = await tailnetApp.request(
      `/api/workspace/${WORKSPACE}/agent-sessions/${ACP_SESSION}/transcript`,
      { headers: asTailnet('teammate@example.com', 'srv.tailnet.ts.net') },
    )

    expect(res.status).toBe(200)
    expect(((await res.json()) as { events: AcpEvent[] }).events.map((e) => e.type)).toEqual(['user', 'agent'])
  })

  it('serves a tui claude conversation from claude\'s own transcript', async () => {
    // yaac records no events for a TUI conversation; claude's transcript
    // is replayed through the ACP adapter's translation.
    await recordAgentSessions(DEMO_PROJECT_ID, WORKSPACE, [
      { tool: 'claude', agentSessionId: TUI_SESSION, mode: 'tui' },
    ])
    const file = path.join(claudeDir(DEMO_PROJECT_ID), 'projects', '-workspace', `${TUI_SESSION}.jsonl`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, [
      {
        type: 'user', uuid: 'u1', parentUuid: null, sessionId: TUI_SESSION, cwd: '/workspace',
        timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'what changed?' },
      },
      {
        type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: TUI_SESSION, cwd: '/workspace',
        timestamp: '2026-01-01T00:00:01Z',
        message: {
          role: 'assistant', model: 'claude-fable-5',
          content: [{ type: 'text', text: 'the router' }],
        },
      },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n')

    const { status, events } = await get(TUI_SESSION)

    expect(status).toBe(200)
    expect(events?.map((e) => e.type)).toEqual(['user', 'agent'])
    const said = events?.[1]
    expect(said?.type === 'agent' && said.content).toEqual([{ type: 'text', text: 'the router' }])
  })

  it('answers 404 for a conversation the workspace never had', async () => {
    await recordAgentSessions(DEMO_PROJECT_ID, WORKSPACE, [
      { tool: 'claude', agentSessionId: TUI_SESSION, mode: 'tui' },
    ])
    expect((await get('never-happened')).status).toBe(404)
  })

  it('answers with an empty conversation when the agent never wrote one, whatever its tool', async () => {
    const sessions = [
      { tool: 'claude', agentSessionId: TUI_SESSION },
      { tool: 'codex', agentSessionId: '01a1111c-de75-7ce3-8999-3257b2615db0' },
      { tool: 'pi', agentSessionId: '01a1110b-f851-758d-ba08-45c4ee75613f' },
      { tool: 'opencode', agentSessionId: 'ses_eeef51727ffedBWQdWdy0dzOE2' },
    ] as const
    await recordAgentSessions(DEMO_PROJECT_ID, WORKSPACE, sessions.map((s) => ({ ...s, mode: 'tui' as const })))
    for (const s of sessions) expect(await get(s.agentSessionId), s.tool).toEqual({ status: 200, events: [] })
  })
})
