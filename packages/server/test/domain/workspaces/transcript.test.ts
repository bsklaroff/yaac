import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { recordAgentSessions } from '#db/agent-session-store'
import { closeDb } from '#db/client'
import { acpLogDir, agentHistoryDir, claudeDir, opencodeCheckpointDir } from '@yaac/shared/project-paths'
import { getAgentSessionTranscript } from '#domain/workspaces/transcript'
import type { AgentMode, AgentTool } from '@yaac/shared/types'

/**
 * Which file a conversation's history is read from. The readers run for
 * real against files on disk, since the feature exists to read a
 * conversation with no pod.
 */

const PROJECT = '7d4e2a1c-5b3f-4e8a-9c6d-1f2e3a4b5c6d'
const WORKSPACE = 'wt-1'
/** claude conversation ids are UUIDs; the first one is the workspace's id. */
const ACP_SESSION = '11111111-1111-1111-1111-111111111111'
const TUI_SESSION = '22222222-2222-2222-2222-222222222222'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await recordWorkspaceCreated({ projectId: PROJECT, workspaceId: WORKSPACE })
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

async function seedSession(
  agentSessionId: string,
  opts: { tool?: AgentTool; mode?: AgentMode } = {},
): Promise<void> {
  await recordAgentSessions(PROJECT, WORKSPACE, [
    { tool: opts.tool ?? 'claude', agentSessionId, mode: opts.mode ?? 'tui' },
  ])
}

/** Write the record acpd keeps of an `acp` conversation. */
async function writeAcpRecord(agentSessionId: string, lines: unknown[]): Promise<void> {
  const dir = acpLogDir(PROJECT, WORKSPACE)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, `${agentSessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  )
}

/** Write claude's own transcript at its conventional path, used for a `tui`
 *  conversation with no recorded path. */
async function writeClaudeTranscript(agentSessionId: string, at?: string): Promise<string> {
  const file = at ?? path.join(claudeDir(PROJECT), 'projects', '-workspace', `${agentSessionId}.jsonl`)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, [
    {
      type: 'user', uuid: 'u1', parentUuid: null, sessionId: agentSessionId, cwd: '/workspace',
      timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'what changed?' },
    },
    {
      type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: agentSessionId, cwd: '/workspace',
      timestamp: '2026-01-01T00:00:01Z',
      message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'the router' }] },
    },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n')
  return file
}

describe('getAgentSessionTranscript', () => {
  it('replays an acp conversation from the record acpd wrote', async () => {
    await seedSession(ACP_SESSION, { mode: 'acp' })
    await writeAcpRecord(ACP_SESSION, [
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
    ])

    const events = await getAgentSessionTranscript(PROJECT, WORKSPACE, ACP_SESSION)

    expect(events.map((e) => e.type)).toEqual(['user', 'agent'])
    expect(events[0].type === 'user' && events[0].content).toEqual([{ type: 'text', text: 'ship it' }])
  })

  it('replays a tui claude conversation from claude\'s own transcript', async () => {
    await seedSession(TUI_SESSION)
    await writeClaudeTranscript(TUI_SESSION)

    const events = await getAgentSessionTranscript(PROJECT, WORKSPACE, TUI_SESSION)

    expect(events.map((e) => e.type)).toEqual(['user', 'agent'])
    expect(events[1].type === 'agent' && events[1].content).toEqual([{ type: 'text', text: 'the router' }])
  })

  it('fills in a subagent\'s thread that the conversation left out from claude\'s transcript of it', async () => {
    // A transcript's companion dir holds each subagent's own conversation.
    const withSubagent = async (agentSessionId: string, toolUseId: string): Promise<void> => {
      const dir = path.join(claudeDir(PROJECT), 'projects', '-workspace', agentSessionId, 'subagents')
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'agent-x1.meta.json'), JSON.stringify({ toolUseId }))
      const entry = (uuid: string, parentUuid: string | null, role: string, content: unknown): unknown => ({
        type: role, uuid, parentUuid, isSidechain: true, agentId: 'x1', sessionId: agentSessionId, cwd: '/workspace',
        timestamp: '2026-01-01T00:00:00Z', message: { role, content, ...(role === 'assistant' ? { model: 'claude-fable-5' } : {}) },
      })
      await fs.writeFile(path.join(dir, 'agent-x1.jsonl'), [
        entry('s1', null, 'user', 'Look around'),
        entry('s2', 's1', 'assistant', [{ type: 'text', text: 'All clear.' }]),
      ].map((l) => JSON.stringify(l)).join('\n') + '\n')
    }
    // An acp conversation a `session/load` replayed: the Agent call, none of
    // its thread.
    await seedSession(ACP_SESSION, { mode: 'acp' })
    await writeAcpRecord(ACP_SESSION, [{ jsonrpc: '2.0', id: 1, method: 'session/load', params: { sessionId: ACP_SESSION } }, {
      jsonrpc: '2.0', method: 'session/update',
      params: {
        sessionId: ACP_SESSION,
        update: {
          sessionUpdate: 'tool_call', toolCallId: 'toolu_look', title: 'look around', kind: 'think', status: 'pending',
          rawInput: { prompt: 'Look around' }, _meta: { claudeCode: { toolName: 'Agent' } },
        },
      },
    }])
    await writeClaudeTranscript(ACP_SESSION)
    await withSubagent(ACP_SESSION, 'toolu_look')

    const events = await getAgentSessionTranscript(PROJECT, WORKSPACE, ACP_SESSION)

    expect(events.map((e) => [e.type, 'thread' in e ? e.thread : undefined])).toEqual([
      ['tool', undefined], ['subagent', undefined], ['agent', 'toolu_look'],
    ])
    expect(events.at(-1)).toMatchObject({ seq: 2, content: [{ type: 'text', text: 'All clear.' }] })
  })

  it('finds a conversation with no recorded path in the workspace\'s own history', async () => {
    // Finding it needs both the conversation id and the workspace id.
    await seedSession(TUI_SESSION)
    await writeClaudeTranscript(
      TUI_SESSION,
      path.join(agentHistoryDir(PROJECT, WORKSPACE, 'claude'), '-workspace', `${TUI_SESSION}.jsonl`),
    )

    const events = await getAgentSessionTranscript(PROJECT, WORKSPACE, TUI_SESSION)

    expect(events.map((e) => e.type)).toEqual(['user', 'agent'])
  })

  it('prefers a recorded transcript path over the one the layout implies', async () => {
    // codex's rollout filename cannot be derived, and a `/clear`ed claude
    // conversation can be anywhere, so a recorded path wins.
    await seedSession(TUI_SESSION)
    const elsewhere = path.join(claudeDir(PROJECT), 'projects', '-elsewhere', 'moved.jsonl')
    await writeClaudeTranscript(TUI_SESSION, elsewhere)
    await recordAgentSessions(PROJECT, WORKSPACE, [{
      tool: 'claude',
      agentSessionId: TUI_SESSION,
      transcriptPath: path.relative(path.dirname(claudeDir(PROJECT)), elsewhere),
    }])

    expect((await getAgentSessionTranscript(PROJECT, WORKSPACE, TUI_SESSION)).map((e) => e.type))
      .toEqual(['user', 'agent'])
  })

  it('answers empty for a conversation whose file was never written', async () => {
    // An agent that never spoke has an empty history, as with acp.
    await seedSession(TUI_SESSION)
    expect(await getAgentSessionTranscript(PROJECT, WORKSPACE, TUI_SESSION)).toEqual([])

    await seedSession(ACP_SESSION, { mode: 'acp' })
    expect(await getAgentSessionTranscript(PROJECT, WORKSPACE, ACP_SESSION)).toEqual([])
  })

  it('translates a tui conversation of every other tool from its own history', async () => {
    // Each tool keeps its history in its own format and place: codex a
    // rollout named for its thread, pi a log named for its session, and
    // opencode (sandboxed, as with no driver) the export its checkpoint
    // writes. Each comes back as the same events.
    const line = (o: unknown): string => JSON.stringify(o)
    const CODEX = '01a1111c-de75-7ce3-8999-3257b2615db0'
    const codexItem = (item: unknown, ms: number): string => line({
      timestamp: new Date(ms).toISOString(), type: 'event_msg',
      payload: { type: 'item_completed', thread_id: CODEX, turn_id: 't1', item, started_at_ms: ms, completed_at_ms: ms },
    })
    const rollouts = path.join(agentHistoryDir(PROJECT, WORKSPACE, 'codex'), '2026', '10', '06')
    await fs.mkdir(rollouts, { recursive: true })
    await fs.writeFile(path.join(rollouts, `rollout-2026-10-06T12-07-47-${CODEX}.jsonl`), [
      line({ timestamp: '2026-10-06T12:07:47.000Z', type: 'session_meta', payload: { id: CODEX, cwd: '/workspace' } }),
      line({ timestamp: '2026-10-06T12:07:47.001Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }),
      codexItem({ type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'what changed?' }] }, 1791288467002),
      codexItem({ type: 'AgentMessage', id: 'a1', content: [{ type: 'Text', text: 'the router' }] }, 1791288467003),
    ].join('\n') + '\n')

    const PI = '01a1110b-f851-758d-ba08-45c4ee75613f'
    const pi = agentHistoryDir(PROJECT, WORKSPACE, 'pi')
    await fs.mkdir(pi, { recursive: true })
    await fs.writeFile(path.join(pi, `2026-10-06T11-49-19-571Z_${PI}.jsonl`), [
      line({ type: 'session', version: 3, id: PI, cwd: '/workspace' }),
      line({ type: 'message', id: 'm1', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'what changed?' }] } }),
      line({ type: 'message', id: 'm2', parentId: 'm1', message: { role: 'assistant', content: [{ type: 'text', text: 'the router' }] } }),
    ].join('\n') + '\n')

    const OPENCODE = 'ses_eeef51727ffedBWQdWdy0dzOE2'
    const exported = path.join(opencodeCheckpointDir(PROJECT, WORKSPACE), 'yaac-transcripts')
    await fs.mkdir(exported, { recursive: true })
    await fs.writeFile(path.join(exported, `${OPENCODE}.jsonl`), [
      line({ session: OPENCODE, type: 'session', parent: null, directory: '/workspace' }),
      line({ session: OPENCODE, type: 'user', seq: 1, data: { text: 'what changed?', files: [] } }),
      line({ session: OPENCODE, type: 'assistant', seq: 2, data: { content: [{ type: 'text', text: 'the router' }] } }),
    ].join('\n') + '\n')

    for (const [tool, id] of [['codex', CODEX], ['pi', PI], ['opencode', OPENCODE]] as const) {
      await seedSession(id, { tool })
      const said = (await getAgentSessionTranscript(PROJECT, WORKSPACE, id))
        .flatMap((e) => (e.type === 'user' || e.type === 'agent' ? [`${e.type}: ${JSON.stringify(e.content)}`] : []))
      expect(said, tool).toEqual([
        'user: [{"type":"text","text":"what changed?"}]',
        'agent: [{"type":"text","text":"the router"}]',
      ])
    }
  })

  it('finds a claude transcript filed under a cwd that is not the pod\'s', async () => {
    // A containerless workspace runs claude in the host checkout, not
    // `/workspace`, so claude files the conversation under a directory named
    // for that path.
    await seedSession(TUI_SESSION)
    await writeClaudeTranscript(TUI_SESSION, path.join(
      claudeDir(PROJECT), 'projects', `-home-yaac--yaac-projects-${PROJECT}-workspaces-wt-1`,
      `${TUI_SESSION}.jsonl`,
    ))

    expect((await getAgentSessionTranscript(PROJECT, WORKSPACE, TUI_SESSION)).map((e) => e.type))
      .toEqual(['user', 'agent'])
  })

  it('refuses a conversation too large to answer with, rather than reading it', async () => {
    // The whole file is read into one JSON body, so a huge one would stall
    // the server. Truncating would look like a conversation that started
    // later, so it is refused.
    await seedSession(TUI_SESSION)
    const file = path.join(claudeDir(PROJECT), 'projects', '-workspace', `${TUI_SESSION}.jsonl`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    // Sparse, so the file uses no real disk.
    const handle = await fs.open(file, 'w')
    await handle.truncate(65 * 1024 * 1024)
    await handle.close()

    await expect(getAgentSessionTranscript(PROJECT, WORKSPACE, TUI_SESSION))
      .rejects.toMatchObject({ code: 'TOO_LARGE' })
  })

  it('reads nothing through a link or a FIFO planted where a transcript belongs', async () => {
    // Both files are written from inside the sandbox. A symlink could expose
    // another project's conversation; a FIFO would block a server fs thread.
    await seedSession(TUI_SESSION)
    await seedSession(ACP_SESSION, { mode: 'acp' })
    const elsewhere = await writeClaudeTranscript(TUI_SESSION, path.join(tmpDir, 'elsewhere', 't.jsonl'))
    const file = path.join(claudeDir(PROJECT), 'projects', '-workspace', `${TUI_SESSION}.jsonl`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.symlink(elsewhere, file)
    expect(await getAgentSessionTranscript(PROJECT, WORKSPACE, TUI_SESSION)).toEqual([])

    await fs.rm(file)
    await promisify(execFile)('mkfifo', [file])
    await fs.mkdir(acpLogDir(PROJECT, WORKSPACE), { recursive: true })
    await promisify(execFile)('mkfifo', [path.join(acpLogDir(PROJECT, WORKSPACE), `${ACP_SESSION}.jsonl`)])
    expect(await getAgentSessionTranscript(PROJECT, WORKSPACE, TUI_SESSION)).toEqual([])
    expect(await getAgentSessionTranscript(PROJECT, WORKSPACE, ACP_SESSION)).toEqual([])
  })

  it('refuses a conversation the workspace never had', async () => {
    await seedSession(TUI_SESSION)
    await expect(getAgentSessionTranscript(PROJECT, WORKSPACE, 'never-happened'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('reads an acp conversation by its mode, whatever tool it ran', async () => {
    // The mode picks the file, not the tool: an acp conversation always has
    // an acpd record.
    await seedSession(ACP_SESSION, { tool: 'opencode', mode: 'acp' })
    await writeAcpRecord(ACP_SESSION, [
      {
        jsonrpc: '2.0', method: 'session/update',
        params: {
          sessionId: ACP_SESSION,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
        },
      },
    ])

    expect((await getAgentSessionTranscript(PROJECT, WORKSPACE, ACP_SESSION)).map((e) => e.type))
      .toEqual(['agent'])
  })
})
