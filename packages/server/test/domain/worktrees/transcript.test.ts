import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { recordWorktreeCreated } from '#db/worktree-store'
import { recordAgentSessions, setAgentSessionCapture } from '#db/agent-session-store'
import { closeDb } from '#db/client'
import { acpLogDir, claudeDir } from '@yaac/shared/project-paths'
import { getAgentSessionTranscript } from '#domain/worktrees/transcript'
import type { AgentMode, AgentTool } from '@yaac/shared/types'

/**
 * Which file a conversation's history comes out of, which is the whole of what
 * this mediator decides. Both readers behind it run for real against files on
 * disk — the point of the feature is that a conversation is readable with no
 * pod, so a test that mocked the read would be testing nothing.
 */

const SLUG = 'demo'
const WORKTREE = 'wt-1'
/** claude conversation ids are UUIDs; the founding one is the worktree's. */
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

async function seedSession(
  agentSessionId: string,
  opts: { tool?: AgentTool; mode?: AgentMode } = {},
): Promise<void> {
  await recordAgentSessions(SLUG, WORKTREE, [
    { tool: opts.tool ?? 'claude', agentSessionId, mode: opts.mode ?? 'tui' },
  ])
}

/** The record acpd tees as it relays — where an `acp` conversation lives. */
async function writeAcpRecord(agentSessionId: string, lines: unknown[]): Promise<void> {
  const dir = acpLogDir(SLUG, WORKTREE)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, `${agentSessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  )
}

/** claude's own transcript, at the layout-derived path — where a `tui`
 *  conversation lives when nothing recorded a path for it. */
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

    const events = await getAgentSessionTranscript(SLUG, WORKTREE, ACP_SESSION)

    expect(events.map((e) => e.type)).toEqual(['user', 'agent'])
    expect(events[0].type === 'user' && events[0].content).toEqual([{ type: 'text', text: 'ship it' }])
  })

  it('replays a tui claude conversation from claude\'s own transcript', async () => {
    await seedSession(TUI_SESSION)
    await writeClaudeTranscript(TUI_SESSION)

    const events = await getAgentSessionTranscript(SLUG, WORKTREE, TUI_SESSION)

    expect(events.map((e) => e.type)).toEqual(['user', 'agent'])
    expect(events[1].type === 'agent' && events[1].content).toEqual([{ type: 'text', text: 'the router' }])
  })

  it('prefers a recorded transcript path over the one the layout implies', async () => {
    // codex's rollout filename is not derivable, and a `/clear`ed claude
    // conversation can sit anywhere the hook found it — so the recorded path
    // is what a reader must use when there is one.
    await seedSession(TUI_SESSION)
    const elsewhere = path.join(claudeDir(SLUG), 'projects', '-elsewhere', 'moved.jsonl')
    await writeClaudeTranscript(TUI_SESSION, elsewhere)
    await setAgentSessionCapture(SLUG, 'claude', TUI_SESSION, {
      transcriptPath: path.relative(path.dirname(claudeDir(SLUG)), elsewhere),
    })

    expect((await getAgentSessionTranscript(SLUG, WORKTREE, TUI_SESSION)).map((e) => e.type))
      .toEqual(['user', 'agent'])
  })

  it('answers empty for a conversation whose file was never written', async () => {
    // An agent that never spoke has an empty history, not a failure — the
    // same verdict the acp reader reaches for a missing record.
    await seedSession(TUI_SESSION)
    expect(await getAgentSessionTranscript(SLUG, WORKTREE, TUI_SESSION)).toEqual([])

    await seedSession(ACP_SESSION, { mode: 'acp' })
    expect(await getAgentSessionTranscript(SLUG, WORKTREE, ACP_SESSION)).toEqual([])
  })

  it('refuses a conversation this install cannot read', async () => {
    // opencode keeps its history in a sqlite database inside the container, so
    // once the worktree is gone there is nothing on the host to read. Saying
    // so beats answering with an empty conversation, which would read as "you
    // said nothing".
    await seedSession('oc-1', { tool: 'opencode' })
    await expect(getAgentSessionTranscript(SLUG, WORKTREE, 'oc-1'))
      .rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
  })

  it('finds a claude transcript filed under a cwd that is not the pod\'s', async () => {
    // Only the pod driver runs claude in `/workspace`. A containerless
    // worktree runs it in the host checkout, so claude files the conversation
    // under a directory named for that path instead — and this fallback is
    // exactly the case (no recorded path) where nothing else would find it.
    await seedSession(TUI_SESSION)
    await writeClaudeTranscript(TUI_SESSION, path.join(
      claudeDir(SLUG), 'projects', '-home-yaac--yaac-projects-demo-worktrees-wt-1',
      `${TUI_SESSION}.jsonl`,
    ))

    expect((await getAgentSessionTranscript(SLUG, WORKTREE, TUI_SESSION)).map((e) => e.type))
      .toEqual(['user', 'agent'])
  })

  it('refuses a conversation too large to answer with, rather than reading it', async () => {
    // Whole-file read, projection, one JSON body: a conversation of hundreds
    // of megabytes would stall the server. Refusing says so; truncating would
    // look like a conversation that simply started later.
    await seedSession(TUI_SESSION)
    const file = path.join(claudeDir(SLUG), 'projects', '-workspace', `${TUI_SESSION}.jsonl`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    // Sparse, so the test costs an inode rather than 65 MB of disk.
    const handle = await fs.open(file, 'w')
    await handle.truncate(65 * 1024 * 1024)
    await handle.close()

    await expect(getAgentSessionTranscript(SLUG, WORKTREE, TUI_SESSION))
      .rejects.toMatchObject({ code: 'TOO_LARGE' })
  })

  it('refuses a conversation the worktree never had', async () => {
    await seedSession(TUI_SESSION)
    await expect(getAgentSessionTranscript(SLUG, WORKTREE, 'never-happened'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('reads an acp conversation by its mode, whatever tool it ran', async () => {
    // The mode decides the file, not the tool: an acp conversation has a
    // record whether or not its tool leaves a transcript of its own.
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

    expect((await getAgentSessionTranscript(SLUG, WORKTREE, ACP_SESSION)).map((e) => e.type))
      .toEqual(['agent'])
  })
})
