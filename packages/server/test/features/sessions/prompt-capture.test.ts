import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

vi.mock('#platform/k8s/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return {
    ...actual,
    listSessionPods: vi.fn().mockResolvedValue([]),
  }
})

vi.mock('#features/sessions/cleanup', () => ({
  probeTmuxLiveness: vi.fn().mockResolvedValue('alive'),
}))

vi.mock('#platform/k8s/stream-relay', async (importOriginal) => ({
  ...await importOriginal<typeof relayModule>(),
  sessionExec: vi.fn(),
}))

import { listSessionPods, type SessionPod } from '#platform/k8s/pods'
import type * as podsModule from '#platform/k8s/pods'
import { sessionExec } from '#platform/k8s/stream-relay'
import type * as relayModule from '#platform/k8s/stream-relay'
import { closeDb } from '#platform/db/client'
import { claudeDir } from '@yaac/shared/project-paths'
import { captureSessionPrompts } from '#features/sessions/prompt-capture'
import {
  getProjectWorktreeRows,
  recordWorktreeCreated,
} from '#features/sessions/worktree-store'
import {
  listWorktreeAgentSessions,
  recordAgentSessions,
} from '#features/sessions/agent-session-store'

/**
 * Link a conversation to a worktree the way the registry reconciler would,
 * so the capture step has something to capture for. Capture is now
 * per-conversation: the worktree's own prompt is whatever its *first*
 * conversation opened with.
 */
/** The worktree's founding ask: its first conversation's opening message. */
async function foundingAsk(worktreeId: string): Promise<string | undefined> {
  const [first] = await listWorktreeAgentSessions('demo', worktreeId)
  return first?.firstPrompt
}

function seedAgentSession(
  worktreeId: string,
  agentSessionId: string,
  transcriptPath?: string,
  tool: 'claude' | 'codex' | 'opencode' | 'pi' = 'claude',
  firstPrompt?: string,
): Promise<void> {
  return recordAgentSessions('demo', worktreeId, [{
    tool,
    agentSessionId,
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
    ...(firstPrompt !== undefined ? { firstPrompt } : {}),
  }])
}

const mockListPods = vi.mocked(listSessionPods)
const mockedExec = vi.mocked(sessionExec)

function pod(sessionId: string, tool = 'claude'): SessionPod {
  return {
    jobName: `yaac-demo-${sessionId}`,
    podName: `yaac-demo-${sessionId}-x1`,
    sessionId,
    projectSlug: 'demo',
    tool,
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: Date.now(),
    labels: {},
  }
}

/** Where a claude transcript for `id` lands, without writing one. */
async function transcriptPathFor(id: string): Promise<string> {
  const dir = path.join(claudeDir('demo'), 'projects', '-workspace')
  await fs.mkdir(dir, { recursive: true })
  return path.join(dir, `${id}.jsonl`)
}

async function writeClaudeTranscript(sessionId: string, firstMessage: string): Promise<string> {
  const dir = path.join(claudeDir('demo'), 'projects', '-workspace')
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${sessionId}.jsonl`)
  const entry = JSON.stringify({ type: 'user', message: { role: 'user', content: firstMessage } })
  await fs.writeFile(file, `${entry}\n`)
  return file
}

describe('captureSessionPrompts', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    mockListPods.mockReset().mockResolvedValue([])
    mockedExec.mockReset()
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('stores the first message on both the conversation and the worktree', async () => {
    const file = await writeClaudeTranscript('sid-1', 'refactor the parser')
    await recordWorktreeCreated({ projectSlug: 'demo', worktreeId: 'sid-1' })
    await seedAgentSession('sid-1', 'sid-1', file)
    mockListPods.mockResolvedValue([pod('sid-1')])

    await captureSessionPrompts()

    // The worktree's founding ask...
    expect(await foundingAsk('sid-1')).toBe('refactor the parser')
    // ...and the conversation's own, which is the same one here because this
    // is the worktree's first conversation.
    expect((await listWorktreeAgentSessions('demo', 'sid-1'))[0])
      .toMatchObject({ agentSessionId: 'sid-1', firstPrompt: 'refactor the parser' })
  })

  it('keeps the founding ask when a later conversation opens differently', async () => {
    // What `/clear` produces: a second conversation whose opening message is
    // not the ask the worktree was created for. The sidebar keeps the first.
    const first = await writeClaudeTranscript('conv-a', 'the original ask')
    await recordWorktreeCreated({ projectSlug: 'demo', worktreeId: 'sid-1' })
    await seedAgentSession('sid-1', 'conv-a', first)
    mockListPods.mockResolvedValue([pod('sid-1')])
    await captureSessionPrompts()

    const second = await writeClaudeTranscript('conv-b', 'something else entirely')
    await seedAgentSession('sid-1', 'conv-b', second)
    await captureSessionPrompts()

    expect(await foundingAsk('sid-1')).toBe('the original ask')
    const links = await listWorktreeAgentSessions('demo', 'sid-1')
    expect(links.map((l) => [l.agentSessionId, l.firstPrompt])).toEqual([
      ['conv-a', 'the original ask'],
      ['conv-b', 'something else entirely'],
    ])
  })

  it('leaves the row alone until the agent has been prompted', async () => {
    await recordWorktreeCreated({ projectSlug: 'demo', worktreeId: 'sid-1' })
    await seedAgentSession('sid-1', 'sid-1', await transcriptPathFor('sid-1'))
    mockListPods.mockResolvedValue([pod('sid-1')])

    await captureSessionPrompts()
    expect(await foundingAsk('sid-1')).toBeUndefined()

    // …and picks it up on a later pass, once there is one.
    await writeClaudeTranscript('sid-1', 'later ask')
    await captureSessionPrompts()
    expect(await foundingAsk('sid-1')).toBe('later ask')
  })

  it('keeps the create-time prompt over whatever the transcript opens with', async () => {
    // The mainstream `worktree create -p` / spawn path: create records the
    // conversation it launches with the ask the user typed, and that is the
    // worktree's founding ask. Capture must leave it alone — re-reading a
    // transcript that has since been compacted would replace it with whatever
    // the log now starts with.
    await recordWorktreeCreated({ projectSlug: 'demo', worktreeId: 'sid-1' })
    const file = await writeClaudeTranscript('sid-1', 'a different first message')
    await seedAgentSession('sid-1', 'sid-1', file, 'claude', 'already captured')
    mockListPods.mockResolvedValue([pod('sid-1')])

    await captureSessionPrompts()

    expect(await foundingAsk('sid-1')).toBe('already captured')
    expect((await listWorktreeAgentSessions('demo', 'sid-1'))[0]?.firstPrompt)
      .toBe('already captured')
  })

  it('ignores a live pod with no recorded session', async () => {
    // Nothing records a row here, so there is nothing to capture onto — a
    // create that could not write its row failed, and its pod was torn down.
    await writeClaudeTranscript('orphan', 'unrecorded')
    mockListPods.mockResolvedValue([pod('orphan')])

    await captureSessionPrompts()

    expect(await getProjectWorktreeRows('demo')).toEqual(new Map())
  })

  it('probes an opencode session over HTTP, since it leaves no transcript', async () => {
    await recordWorktreeCreated({ projectSlug: 'demo', worktreeId: 'oc-1' })
    await seedAgentSession('oc-1', 'oc-1', undefined, 'opencode')
    mockListPods.mockResolvedValue([pod('oc-1', 'opencode')])
    mockedExec.mockImplementation((_job: string, cmd: string) =>
      cmd.includes('curl')
        ? Promise.resolve({
          stdout: JSON.stringify([{ id: 'ses_1', title: 'build a thing', time: { updated: 1 } }]),
          stderr: '',
        })
        : Promise.reject(new Error('unexpected exec')))

    await captureSessionPrompts()

    expect(await foundingAsk('oc-1')).toBe('build a thing')
  })

  it('skips a worktree with no live pod, and survives an unreachable cluster', async () => {
    await recordWorktreeCreated({ projectSlug: 'demo', worktreeId: 'sid-1' })
    const file = await writeClaudeTranscript('sid-1', 'never seen')
    await seedAgentSession('sid-1', 'sid-1', file)

    await captureSessionPrompts() // no pods listed
    expect(await foundingAsk('sid-1')).toBeUndefined()

    mockListPods.mockRejectedValue(new Error('cluster down'))
    await expect(captureSessionPrompts()).resolves.toBeUndefined()
  })
})
