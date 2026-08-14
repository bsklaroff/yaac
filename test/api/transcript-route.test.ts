import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { makeTestApiClient } from '@yaac/test-utils/api'
import { buildApp } from '@yaac/server/main/server'
import { recordWorktreeCreated } from '@yaac/server/db/worktree-store'
import { recordAgentSessions } from '@yaac/server/db/agent-session-store'
import { closeDb } from '@yaac/server/db/client'
import { acpLogDir, claudeDir } from '@yaac/shared/project-paths'
import type { AcpEvent } from '@yaac/shared/acp'

/**
 * The transcript route over real HTTP, against real files.
 *
 * The route matrix only states what this answers on an empty server; what a
 * *recorded* conversation comes back as is the thing worth proving, and it is
 * the reason a stopped worktree is worth clicking. Nothing here is mocked
 * below the route: the rows are written through the store and the transcripts
 * through the filesystem, because "readable with no pod" is the claim.
 */

const SLUG = 'demo'
const WORKTREE = 'wt-1'
const ACP_SESSION = '11111111-1111-1111-1111-111111111111'
const TUI_SESSION = '22222222-2222-2222-2222-222222222222'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await recordWorktreeCreated({ projectSlug: SLUG, worktreeId: WORKTREE })
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

const client = (): ReturnType<typeof makeTestApiClient> =>
  makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))

async function get(sessionId: string): Promise<{ status: number; events?: AcpEvent[] }> {
  const res = await client().worktree[':id']['agent-sessions'][':sessionId'].transcript.$get({
    param: { id: WORKTREE, sessionId },
  })
  if (res.status !== 200) return { status: res.status }
  return { status: res.status, events: (await res.json()).events }
}

describe('GET /worktree/:id/agent-sessions/:sessionId/transcript', () => {
  it('serves an acp conversation from the record acpd wrote', async () => {
    await recordAgentSessions(SLUG, WORKTREE, [
      { tool: 'claude', agentSessionId: ACP_SESSION, mode: 'acp' },
    ])
    const dir = acpLogDir(SLUG, WORKTREE)
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

    const { status, events } = await get(ACP_SESSION)

    expect(status).toBe(200)
    expect(events?.map((e) => e.type)).toEqual(['user', 'agent'])
  })

  it('serves a tui claude conversation from claude\'s own transcript', async () => {
    // The half with no record at all: driven through a PTY, replayed on
    // demand through the ACP adapter's own translation.
    await recordAgentSessions(SLUG, WORKTREE, [
      { tool: 'claude', agentSessionId: TUI_SESSION, mode: 'tui' },
    ])
    const file = path.join(claudeDir(SLUG), 'projects', '-workspace', `${TUI_SESSION}.jsonl`)
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

  it('answers 404 for a conversation the worktree never had', async () => {
    await recordAgentSessions(SLUG, WORKTREE, [
      { tool: 'claude', agentSessionId: TUI_SESSION, mode: 'tui' },
    ])
    expect((await get('never-happened')).status).toBe(404)
  })

  it('answers 501 for a tool whose history is not readable from the host', async () => {
    // opencode's history is a sqlite database inside the container. Refusing
    // says so; an empty conversation would read as "nothing was said".
    await recordAgentSessions(SLUG, WORKTREE, [
      { tool: 'opencode', agentSessionId: 'oc-1', mode: 'tui' },
    ])
    expect((await get('oc-1')).status).toBe(501)
  })

  it('answers with an empty conversation when the agent never wrote one', async () => {
    await recordAgentSessions(SLUG, WORKTREE, [
      { tool: 'claude', agentSessionId: TUI_SESSION, mode: 'tui' },
    ])
    expect(await get(TUI_SESSION)).toEqual({ status: 200, events: [] })
  })
})
