import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { recordAgentSessions, setAgentSessionCapture } from '#db/agent-session-store'
import { closeDb } from '#db/client'
import { acpLogDir, agentHistoryDir, claudeDir } from '@yaac/shared/project-paths'
import { getAgentSessionTranscript } from '#domain/workspaces/transcript'
import type { AgentMode, AgentTool } from '@yaac/shared/types'

/**
 * Which file a conversation's history is read from. Both readers run for
 * real against files on disk, since the feature exists to read a
 * conversation with no pod.
 */

const SLUG = 'demo'
const WORKSPACE = 'wt-1'
/** claude conversation ids are UUIDs; the first one is the workspace's id. */
const ACP_SESSION = '11111111-1111-1111-1111-111111111111'
const TUI_SESSION = '22222222-2222-2222-2222-222222222222'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await recordWorkspaceCreated({ projectSlug: SLUG, workspaceId: WORKSPACE })
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

async function seedSession(
  agentSessionId: string,
  opts: { tool?: AgentTool; mode?: AgentMode } = {},
): Promise<void> {
  await recordAgentSessions(SLUG, WORKSPACE, [
    { tool: opts.tool ?? 'claude', agentSessionId, mode: opts.mode ?? 'tui' },
  ])
}

/** Write the record acpd keeps of an `acp` conversation. */
async function writeAcpRecord(agentSessionId: string, lines: unknown[]): Promise<void> {
  const dir = acpLogDir(SLUG, WORKSPACE)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, `${agentSessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  )
}

/** Write claude's own transcript at its conventional path, used for a `tui`
 *  conversation with no recorded path. */
async function writeClaudeTranscript(agentSessionId: string, at?: string): Promise<string> {
  const file = at ?? path.join(claudeDir(SLUG), 'projects', '-workspace', `${agentSessionId}.jsonl`)
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

    const events = await getAgentSessionTranscript(SLUG, WORKSPACE, ACP_SESSION)

    expect(events.map((e) => e.type)).toEqual(['user', 'agent'])
    expect(events[0].type === 'user' && events[0].content).toEqual([{ type: 'text', text: 'ship it' }])
  })

  it('replays a tui claude conversation from claude\'s own transcript', async () => {
    await seedSession(TUI_SESSION)
    await writeClaudeTranscript(TUI_SESSION)

    const events = await getAgentSessionTranscript(SLUG, WORKSPACE, TUI_SESSION)

    expect(events.map((e) => e.type)).toEqual(['user', 'agent'])
    expect(events[1].type === 'agent' && events[1].content).toEqual([{ type: 'text', text: 'the router' }])
  })

  it('finds a conversation with no recorded path in the workspace\'s own history', async () => {
    // Finding it needs both the conversation id and the workspace id.
    await seedSession(TUI_SESSION)
    await writeClaudeTranscript(
      TUI_SESSION,
      path.join(agentHistoryDir(SLUG, WORKSPACE, 'claude'), '-workspace', `${TUI_SESSION}.jsonl`),
    )

    const events = await getAgentSessionTranscript(SLUG, WORKSPACE, TUI_SESSION)

    expect(events.map((e) => e.type)).toEqual(['user', 'agent'])
  })

  it('prefers a recorded transcript path over the one the layout implies', async () => {
    // codex's rollout filename cannot be derived, and a `/clear`ed claude
    // conversation can be anywhere, so a recorded path wins.
    await seedSession(TUI_SESSION)
    const elsewhere = path.join(claudeDir(SLUG), 'projects', '-elsewhere', 'moved.jsonl')
    await writeClaudeTranscript(TUI_SESSION, elsewhere)
    await setAgentSessionCapture(SLUG, 'claude', TUI_SESSION, {
      transcriptPath: path.relative(path.dirname(claudeDir(SLUG)), elsewhere),
    })

    expect((await getAgentSessionTranscript(SLUG, WORKSPACE, TUI_SESSION)).map((e) => e.type))
      .toEqual(['user', 'agent'])
  })

  it('answers empty for a conversation whose file was never written', async () => {
    // An agent that never spoke has an empty history, as with acp.
    await seedSession(TUI_SESSION)
    expect(await getAgentSessionTranscript(SLUG, WORKSPACE, TUI_SESSION)).toEqual([])

    await seedSession(ACP_SESSION, { mode: 'acp' })
    expect(await getAgentSessionTranscript(SLUG, WORKSPACE, ACP_SESSION)).toEqual([])
  })

  it('refuses a conversation this install cannot read', async () => {
    // opencode keeps history in a sqlite database inside the container, so
    // nothing is left on the host. An empty answer would wrongly suggest
    // nothing was said.
    await seedSession('oc-1', { tool: 'opencode' })
    await expect(getAgentSessionTranscript(SLUG, WORKSPACE, 'oc-1'))
      .rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
  })

  it('finds a claude transcript filed under a cwd that is not the pod\'s', async () => {
    // A containerless workspace runs claude in the host checkout, not
    // `/workspace`, so claude files the conversation under a directory named
    // for that path.
    await seedSession(TUI_SESSION)
    await writeClaudeTranscript(TUI_SESSION, path.join(
      claudeDir(SLUG), 'projects', '-home-yaac--yaac-projects-demo-workspaces-wt-1',
      `${TUI_SESSION}.jsonl`,
    ))

    expect((await getAgentSessionTranscript(SLUG, WORKSPACE, TUI_SESSION)).map((e) => e.type))
      .toEqual(['user', 'agent'])
  })

  it('refuses a conversation too large to answer with, rather than reading it', async () => {
    // The whole file is read into one JSON body, so a huge one would stall
    // the server. Truncating would look like a conversation that started
    // later, so it is refused.
    await seedSession(TUI_SESSION)
    const file = path.join(claudeDir(SLUG), 'projects', '-workspace', `${TUI_SESSION}.jsonl`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    // Sparse, so the file uses no real disk.
    const handle = await fs.open(file, 'w')
    await handle.truncate(65 * 1024 * 1024)
    await handle.close()

    await expect(getAgentSessionTranscript(SLUG, WORKSPACE, TUI_SESSION))
      .rejects.toMatchObject({ code: 'TOO_LARGE' })
  })

  it('reads nothing through a link or a FIFO planted where a transcript belongs', async () => {
    // Both files are written from inside the sandbox. A symlink could expose
    // another project's conversation; a FIFO would block a server fs thread.
    await seedSession(TUI_SESSION)
    await seedSession(ACP_SESSION, { mode: 'acp' })
    const elsewhere = await writeClaudeTranscript(TUI_SESSION, path.join(tmpDir, 'elsewhere', 't.jsonl'))
    const file = path.join(claudeDir(SLUG), 'projects', '-workspace', `${TUI_SESSION}.jsonl`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.symlink(elsewhere, file)
    expect(await getAgentSessionTranscript(SLUG, WORKSPACE, TUI_SESSION)).toEqual([])

    await fs.rm(file)
    await promisify(execFile)('mkfifo', [file])
    await fs.mkdir(acpLogDir(SLUG, WORKSPACE), { recursive: true })
    await promisify(execFile)('mkfifo', [path.join(acpLogDir(SLUG, WORKSPACE), `${ACP_SESSION}.jsonl`)])
    expect(await getAgentSessionTranscript(SLUG, WORKSPACE, TUI_SESSION)).toEqual([])
    expect(await getAgentSessionTranscript(SLUG, WORKSPACE, ACP_SESSION)).toEqual([])
  })

  it('refuses a conversation the workspace never had', async () => {
    await seedSession(TUI_SESSION)
    await expect(getAgentSessionTranscript(SLUG, WORKSPACE, 'never-happened'))
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

    expect((await getAgentSessionTranscript(SLUG, WORKSPACE, ACP_SESSION)).map((e) => e.type))
      .toEqual(['agent'])
  })
})
