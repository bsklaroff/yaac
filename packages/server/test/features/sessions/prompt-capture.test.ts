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
  getProjectSessionRows,
  recordSessionCreated,
  setSessionCapture,
} from '#features/sessions/store'

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

  it('stores the first message and the transcript path on the row', async () => {
    const file = await writeClaudeTranscript('sid-1', 'refactor the parser')
    await recordSessionCreated({ projectSlug: 'demo', sessionId: 'sid-1', tool: 'claude' })
    mockListPods.mockResolvedValue([pod('sid-1')])

    await captureSessionPrompts()

    expect((await getProjectSessionRows('demo')).get('sid-1')).toMatchObject({
      prompt: 'refactor the parser',
      transcriptPath: file,
    })
  })

  it('leaves the row alone until the agent has been prompted', async () => {
    await recordSessionCreated({ projectSlug: 'demo', sessionId: 'sid-1', tool: 'claude' })
    mockListPods.mockResolvedValue([pod('sid-1')])

    await captureSessionPrompts()
    expect((await getProjectSessionRows('demo')).get('sid-1')?.prompt).toBeUndefined()

    // …and picks it up on a later pass, once there is one.
    await writeClaudeTranscript('sid-1', 'later ask')
    await captureSessionPrompts()
    expect((await getProjectSessionRows('demo')).get('sid-1')?.prompt).toBe('later ask')
  })

  it('stamps the transcript path of a session that was created with a prompt', async () => {
    // The mainstream `session create -p` / spawn path: nothing to capture,
    // but the deleted listing needs a path to stat for last activity.
    await recordSessionCreated({
      projectSlug: 'demo', sessionId: 'sid-1', tool: 'claude', prompt: 'already captured',
    })
    const file = await writeClaudeTranscript('sid-1', 'a different first message')
    mockListPods.mockResolvedValue([pod('sid-1')])

    await captureSessionPrompts()

    expect((await getProjectSessionRows('demo')).get('sid-1')).toMatchObject({
      prompt: 'already captured', // the stored prompt wins over the transcript
      transcriptPath: file,
    })
  })

  it('does no work once a session has both its prompt and its path', async () => {
    await recordSessionCreated({
      projectSlug: 'demo', sessionId: 'sid-1', tool: 'claude', prompt: 'already captured',
    })
    await setSessionCapture('demo', 'sid-1', { transcriptPath: '/tmp/already.jsonl' })
    mockListPods.mockResolvedValue([pod('sid-1')])

    await captureSessionPrompts()

    // Short-circuits before listing pods at all.
    expect(mockListPods).not.toHaveBeenCalled()
  })

  it('ignores a live pod with no recorded session', async () => {
    // Nothing records a row here, so there is nothing to capture onto — a
    // create that could not write its row failed, and its pod was torn down.
    await writeClaudeTranscript('orphan', 'unrecorded')
    mockListPods.mockResolvedValue([pod('orphan')])

    await captureSessionPrompts()

    expect(await getProjectSessionRows('demo')).toEqual(new Map())
  })

  it('probes an opencode session over HTTP, since it leaves no transcript', async () => {
    await recordSessionCreated({ projectSlug: 'demo', sessionId: 'oc-1', tool: 'opencode' })
    mockListPods.mockResolvedValue([pod('oc-1', 'opencode')])
    mockedExec.mockImplementation((_job: string, cmd: string) =>
      cmd.includes('curl')
        ? Promise.resolve({
          stdout: JSON.stringify([{ id: 'ses_1', title: 'build a thing', time: { updated: 1 } }]),
          stderr: '',
        })
        : Promise.reject(new Error('unexpected exec')))

    await captureSessionPrompts()

    const row = (await getProjectSessionRows('demo')).get('oc-1')
    expect(row?.prompt).toBe('build a thing')
    expect(row?.transcriptPath).toBeUndefined()
  })

  it('skips a session with no live pod, and survives an unreachable cluster', async () => {
    await recordSessionCreated({ projectSlug: 'demo', sessionId: 'sid-1', tool: 'claude' })
    await writeClaudeTranscript('sid-1', 'never seen')

    await captureSessionPrompts() // no pods listed
    expect((await getProjectSessionRows('demo')).get('sid-1')?.prompt).toBeUndefined()

    mockListPods.mockRejectedValue(new Error('cluster down'))
    await expect(captureSessionPrompts()).resolves.toBeUndefined()
  })
})
