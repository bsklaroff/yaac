import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

// opencode's opening message is not on the host — it is probed inside the pod
// — so the transport is stubbed to assert the sweep carries the job name down
// to that read. Nothing else here execs.
vi.mock('#platform/k8s/stream-relay', async (importOriginal) => ({
  ...await importOriginal<typeof relayModule>(),
  sessionExec: vi.fn(),
}))

// The pod-level entry point is driven only for the unreachable-cluster case.
vi.mock('#platform/k8s/pods', async (importOriginal) => ({
  ...await importOriginal<typeof podsModule>(),
  listSessionPods: vi.fn().mockResolvedValue([]),
}))
import { closeDb } from '#platform/db/client'
import { claudeDir, worktreeLinksDir } from '@yaac/shared/project-paths'
import {
  reconcileAgentSessions,
  reconcileWorktreeAgentSessions,
} from '#features/sessions/agent-session-registry'
import {
  listWorktreeAgentSessions,
  recordAgentSessions,
} from '#features/records/agent-session-store'
import { applyHerdEvent } from '#features/records/apply-herd-event'
import { _resetPromptCaptureForTests } from '#features/sessions/prompt-capture'
import { recordWorktreeCreated } from '#features/records/worktree-store'
import { onHerdEvent, _resetHerdEventsForTests } from '#herd-events'
import { listSessionPods } from '#platform/k8s/pods'
import { sessionExec } from '#platform/k8s/stream-relay'
import type * as relayModule from '#platform/k8s/stream-relay'
import type * as podsModule from '#platform/k8s/pods'
import {
  setLiveAgents,
  _resetSessionStatusStoreForTests,
} from '#features/status/status-store'

/**
 * The registry is the join: the hook's link tree says which conversations a
 * worktree has hosted and which pane each sat on; the status watcher says
 * which panes are alive right now. Only their intersection is "active", and
 * only `active` survives teardown to drive a restart.
 *
 * The link tree is written here directly rather than by running the hook —
 * `agent-links.test.ts` covers the hook→tree half end to end, so this file can
 * stay about the join.
 *
 * The sweep reports what it found rather than writing rows, so the real
 * `applyHerdEvent` is wired as the sink: every assertion below is on the rows
 * a herd's report actually produces, end to end.
 */
describe('reconcileWorktreeAgentSessions', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    _resetSessionStatusStoreForTests()
    _resetPromptCaptureForTests()
    onHerdEvent(applyHerdEvent)
    await recordWorktreeCreated({ projectSlug: 'demo', worktreeId: 'wt-1' })
  })

  afterEach(async () => {
    _resetHerdEventsForTests()
    await closeDb()
    await cleanupTempDir(tmpDir)
    vi.restoreAllMocks()
  })

  /** A claude transcript whose first user message is `firstMessage`. */
  async function writeTranscript(id: string, firstMessage: string): Promise<string> {
    const dir = path.join(claudeDir('demo'), 'projects', '-workspace')
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, `${id}.jsonl`)
    await fs.writeFile(file, `${JSON.stringify({
      type: 'user', message: { role: 'user', content: firstMessage },
    })}\n`)
    return file
  }

  /** The worktree's founding ask: its first conversation's opening message. */
  const foundingAsk = async (): Promise<string | undefined> =>
    (await listWorktreeAgentSessions('demo', 'wt-1'))[0]?.firstPrompt

  /** Link a conversation, optionally pinning it to a pane, as the hook would. */
  async function link(agentSessionId: string, paneId?: string): Promise<void> {
    const dir = worktreeLinksDir('demo', 'claude', 'wt-1')
    await fs.mkdir(path.join(dir, 'sessions'), { recursive: true })
    await fs.mkdir(path.join(dir, 'panes'), { recursive: true })
    const transcripts = path.join(claudeDir('demo'), 'projects', '-workspace')
    await fs.mkdir(transcripts, { recursive: true })
    const transcript = path.join(transcripts, `${agentSessionId}.jsonl`)
    await fs.writeFile(transcript, '{"type":"user"}\n')
    // A record file naming the transcript relative to the tool home, which is
    // exactly what the hook writes; `agent-links.test.ts` owns both formats.
    await fs.writeFile(
      path.join(dir, 'sessions', agentSessionId),
      `${path.relative(claudeDir('demo'), transcript)}\n`,
    )
    if (paneId !== undefined) {
      await fs.writeFile(path.join(dir, 'panes', paneId.slice(1)), `${agentSessionId}\n`)
    }
  }

  const states = async (): Promise<Array<[string, boolean]>> =>
    (await listWorktreeAgentSessions('demo', 'wt-1')).map((l) => [l.agentSessionId, l.active])

  it('activates only the conversations whose pane is alive', async () => {
    // conv-a was `/clear`ed away: its pointer is gone, but it is still part of
    // the worktree's history. conv-b holds the pane.
    await link('conv-a')
    await link('conv-b', '%0')
    setLiveAgents('demo', 'wt-1', [{ handle: '%0', tool: 'claude' }])

    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')

    expect(await states()).toEqual([['conv-a', false], ['conv-b', true]])
  })

  it('deactivates a conversation whose pane exited, keeping it linked', async () => {
    await link('conv-a', '%0')
    setLiveAgents('demo', 'wt-1', [{ handle: '%0', tool: 'claude' }])
    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')
    expect(await states()).toEqual([['conv-a', true]])

    // The pane is gone but its pointer file survives — exactly the case the
    // pointers alone would get wrong.
    setLiveAgents('demo', 'wt-1', [])
    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')
    expect(await states()).toEqual([['conv-a', false]])
  })

  it('keeps two agents active on two panes, and orders them by first sighting', async () => {
    await link('conv-a', '%0')
    await link('conv-b', '%3')
    setLiveAgents('demo', 'wt-1', [{ handle: '%0', tool: 'claude' }, { handle: '%3', tool: 'claude' }])

    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')

    const links = await listWorktreeAgentSessions('demo', 'wt-1')
    expect(links.map((l) => [l.agentSessionId, l.ordinal, l.active]))
      .toEqual([['conv-a', 0, true], ['conv-b', 1, true]])
  })

  it('leaves the active set untouched when no pane list has arrived yet', async () => {
    await link('conv-a', '%0')
    setLiveAgents('demo', 'wt-1', [{ handle: '%0', tool: 'claude' }])
    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')

    // A watcher that dropped its stream reports nothing — which must not read
    // as "every agent exited", or a restart would come back empty.
    _resetSessionStatusStoreForTests()
    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')

    expect(await states()).toEqual([['conv-a', true]])
  })

  it('records the pinned conversation for a pod that predates the hook', async () => {
    // No link tree, but the transcript the old `--session-id` pin guarantees
    // is on disk — that is the evidence this worktree really does predate the
    // hook, and its conversation id IS the worktree id.
    const dir = path.join(claudeDir('demo'), 'projects', '-workspace')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'wt-1.jsonl'), '{"type":"user"}\n')
    setLiveAgents('demo', 'wt-1', [{ handle: '%0', tool: 'claude' }])

    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')

    expect(await states()).toEqual([['wt-1', true]])
  })

  it('records nothing for a pod whose agent has not started yet', async () => {
    // Same shape as the case above — no links — but no transcript either. A
    // pod lists as running as soon as its keepalive tmux is up, minutes
    // before the agent window is respawned, so this branch is hit on nearly
    // every fresh create. Recording the pin here would mint a conversation
    // that never existed, claim ordinal 0, and starve the real one of its
    // founding prompt.
    setLiveAgents('demo', 'wt-1', [{ handle: '%0', tool: 'claude' }])

    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')

    expect(await states()).toEqual([])
  })

  it('records an acp conversation off the live set, with its transcript', async () => {
    // ACP mode has no hook and no link tree: the server IS the ACP client, so
    // `session/new` hands it the id and the live set carries it. The adapter
    // still writes the tool's usual transcript, and naming it is what gives
    // the conversation a last-activity time for the stopped listing — which
    // outlives the pod and so cannot ask the conversation anything.
    const transcripts = path.join(claudeDir('demo'), 'projects', '-workspace')
    await fs.mkdir(transcripts, { recursive: true })
    await fs.writeFile(path.join(transcripts, 'acp-1.jsonl'), '{"type":"user"}\n')
    setLiveAgents('demo', 'wt-1', [
      { handle: 'claude', tool: 'claude', agentSessionId: 'acp-1' },
    ])

    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude', 'acp')

    const [link] = await listWorktreeAgentSessions('demo', 'wt-1')
    expect(link).toMatchObject({ agentSessionId: 'acp-1', mode: 'acp', active: true })
    // The handle is the acpd window, not a pane id — that is what the status
    // store keys this conversation's busy/idle by.
    expect(link.paneId).toBe('claude')
    expect(link.transcriptPath).toBe(path.join(transcripts, 'acp-1.jsonl'))
    expect(link.lastActiveAt).toBeInstanceOf(Date)
  })

  it('keeps the acp handle across a reconcile, so a restart can resume the conversation', async () => {
    // The handle is what a restart reads back to address the conversation:
    // lose it and the fresh acpd handshake mints a NEW session and abandons
    // the history the mode column exists to preserve. Session create stamps
    // it (it is the deterministic window name), and reconciling must not
    // blank it.
    setLiveAgents('demo', 'wt-1', [
      { handle: 'claude', tool: 'claude', agentSessionId: 'acp-1' },
    ])
    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude', 'acp')

    const [link] = await listWorktreeAgentSessions('demo', 'wt-1')
    expect(link.paneId).toBe('claude')
    expect(link.active).toBe(true)
  })

  it('records nothing for an acp conversation whose handshake has not landed', async () => {
    // No id yet — `session/new` has not answered. Recording it under its
    // handle would mint a phantom the real conversation could never displace.
    setLiveAgents('demo', 'wt-1', [{ handle: 'claude', tool: 'claude' }])

    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude', 'acp')

    expect(await states()).toEqual([])
  })

  it('reports each conversation\'s opening message, read from its transcript', async () => {
    await link('conv-a')
    await writeTranscript('conv-a', 'refactor the parser')
    setLiveAgents('demo', 'wt-1', [])

    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')

    expect(await foundingAsk()).toBe('refactor the parser')
  })

  it('keeps the founding ask when a later conversation opens differently', async () => {
    // What `/clear` produces: a second conversation whose opening message is
    // not the ask the worktree was created for. The sidebar keeps the first.
    await link('conv-a')
    await writeTranscript('conv-a', 'the original ask')
    setLiveAgents('demo', 'wt-1', [])
    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')

    await link('conv-b')
    await writeTranscript('conv-b', 'something else entirely')
    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')

    expect(await foundingAsk()).toBe('the original ask')
    expect((await listWorktreeAgentSessions('demo', 'wt-1'))
      .map((l) => [l.agentSessionId, l.firstPrompt]))
      .toEqual([['conv-a', 'the original ask'], ['conv-b', 'something else entirely']])
  })

  it('reports no message until the agent has been prompted, then picks it up', async () => {
    await link('conv-a') // transcript exists but holds no user message yet
    setLiveAgents('demo', 'wt-1', [])
    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')
    expect(await foundingAsk()).toBeUndefined()

    await writeTranscript('conv-a', 'later ask')
    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')
    expect(await foundingAsk()).toBe('later ask')
  })

  it('cannot overwrite the create-time prompt with what the transcript now opens with', async () => {
    // The mainstream `worktree create -p` / spawn path: create reported the
    // conversation it launched with the ask the user typed. A sweep reading a
    // transcript that has since been compacted must not replace it — the
    // server's write is fill-only, which is what makes re-reporting safe.
    await link('conv-a')
    await writeTranscript('conv-a', 'a different first message')
    await recordAgentSessions('demo', 'wt-1', [
      { tool: 'claude', agentSessionId: 'conv-a', firstPrompt: 'already captured' },
    ])
    setLiveAgents('demo', 'wt-1', [])

    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')

    expect(await foundingAsk()).toBe('already captured')
  })

  it('probes an opencode conversation in the pod, since it leaves no transcript', async () => {
    // The one tool whose opening message is not on the host — which is why the
    // sweep has to carry the job name down to the read.
    // No link tree and no transcript will ever exist for it, so the sweep has
    // only the pin create made — and that exemption is what keeps an opencode
    // worktree from going permanently unlabelled.
    vi.mocked(sessionExec).mockResolvedValue({
      stdout: JSON.stringify([{ id: 'ses_1', title: 'build a thing', time: { updated: 1 } }]),
      stderr: '',
    })
    setLiveAgents('demo', 'wt-1', [{ handle: '%0', tool: 'opencode' }])

    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'opencode', 'tui', 'yaac-demo-wt-1')

    expect(await foundingAsk()).toBe('build a thing')
    expect((await listWorktreeAgentSessions('demo', 'wt-1'))
      .map((l) => l.agentSessionId)).toEqual(['wt-1'])
    expect(vi.mocked(sessionExec).mock.calls[0]?.[0]).toBe('yaac-demo-wt-1')
  })

  // The exemption's whole safety rests on there being exactly one
  // conversation to report, because this branch does not join against the
  // live set — see the comment on the emit. If a second one ever becomes
  // reachable here, this fails rather than silently deactivating it.
  it('reports only the pinned conversation for a tool with no discovery source', async () => {
    vi.mocked(sessionExec).mockResolvedValue({ stdout: '[]', stderr: '' })
    setLiveAgents('demo', 'wt-1', [
      { handle: '%0', tool: 'opencode' },
      { handle: '%1', tool: 'opencode' },
    ])

    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'opencode', 'tui', 'yaac-demo-wt-1')

    expect(await states()).toEqual([['wt-1', true]])
  })

  // A sweep that cannot list pods reports nothing rather than an empty world,
  // which would blank every worktree's active set at once.
  it('survives an unreachable cluster without reporting anything', async () => {
    vi.mocked(listSessionPods).mockRejectedValue(new Error('cluster down'))

    await expect(reconcileAgentSessions()).resolves.toBeUndefined()

    expect(await states()).toEqual([])
  })

  it('keeps an ordinal stable once assigned, so a restart\'s windows do not reshuffle', async () => {
    await link('conv-a', '%0')
    setLiveAgents('demo', 'wt-1', [{ handle: '%0', tool: 'claude' }])
    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')

    await link('conv-b', '%1')
    setLiveAgents('demo', 'wt-1', [{ handle: '%0', tool: 'claude' }, { handle: '%1', tool: 'claude' }])
    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')
    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')

    const links = await listWorktreeAgentSessions('demo', 'wt-1')
    expect(links.map((l) => [l.agentSessionId, l.ordinal])).toEqual([['conv-a', 0], ['conv-b', 1]])
  })
})
