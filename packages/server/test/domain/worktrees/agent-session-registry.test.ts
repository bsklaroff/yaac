import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

// opencode's opening message is not on the host — it is probed inside the
// workspace — so the driver's `exec` is stubbed to assert the sweep carries
// the job name down to that read. Nothing else here execs.
// The pod-level entry point is driven only for the unreachable-cluster case.
vi.mock('#drivers/k8s/substrate/pods', async (importOriginal) => ({
  ...await importOriginal<typeof podsModule>(),
  listWorktreePods: vi.fn().mockResolvedValue([]),
}))

// The shrunk-log tripwire below is a log line and nothing else, so the log
// is the only place its firing (or its silence) can be asserted.
vi.mock('#log', () => ({ serverLog: vi.fn(), pipeToServerLog: vi.fn() }))
import { closeDb } from '#db/client'
import { claudeDir, worktreeSessionStartsPath } from '@yaac/shared/project-paths'
import {
  reconcileAgentSessions,
  reconcileWorktreeAgentSessions,
} from '#domain/worktrees/agent-session-registry'
import {
  listWorktreeAgentSessions,
  recordAgentSessions,
} from '#db/agent-session-store'
import { absoluteTranscriptPath } from '#domain/worktrees/agent-session-paths'
import { _resetPromptCaptureForTests } from '#domain/worktrees/prompt-capture'
import { recordWorktreeCreated, recordWorktreeLife } from '#db/worktree-store'
import { sessionStartsLogSize } from '#domain/worktrees/session-starts'
import { serverLog } from '#log'
import { installFakeWorktreeDriver } from '@yaac/test-utils/fake-driver'
import type { WorktreeDriver } from '#drivers/contract'
import { listWorktreePods } from '#drivers/k8s/substrate/pods'
import type * as podsModule from '#drivers/k8s/substrate/pods'
import {
  setLiveAgents,
  _resetWorktreeStatusStoreForTests,
} from '#runtime/status/status-store'

/**
 * The registry is the join: the worktree's rows say which agent sessions it
 * has hosted and which handle each sat on — fed by the in-pod hook's log —
 * and the status watcher says which handles are alive right now. Only their
 * intersection is "active", and only `active` survives teardown to drive a
 * restart.
 *
 * Sightings are appended to the session-starts log here rather than by running
 * the in-pod hook — its line format is covered by
 * session-start-hook.test.ts, which extracts and runs the real script — so this file can stay about the join.
 *
 * The sweep reports what it found rather than writing rows, so the real
 * `applyWorktreeEvent` is wired as the sink: every assertion below is on the rows
 * a discovery report actually produces, end to end.
 */
describe('reconcileWorktreeAgentSessions', () => {
  let tmpDir: string
  const podExec = vi.fn<WorktreeDriver['exec']>()

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    podExec.mockReset()
    installFakeWorktreeDriver({ exec: podExec })
    _resetWorktreeStatusStoreForTests()
    _resetPromptCaptureForTests()
    await recordWorktreeCreated({ projectSlug: 'demo', worktreeId: 'wt-1' })
    // The life create would have stamped. The log is empty at this point, so
    // every sighting below belongs to it.
    await recordWorktreeLife('demo', 'wt-1', 0)
  })

  afterEach(async () => {
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

  /** Append a sighting, optionally on a pane, exactly as the in-pod hook does. */
  async function link(agentSessionId: string, paneId?: string): Promise<void> {
    const transcripts = path.join(claudeDir('demo'), 'projects', '-workspace')
    await fs.mkdir(transcripts, { recursive: true })
    const transcript = path.join(transcripts, `${agentSessionId}.jsonl`)
    await fs.writeFile(transcript, '{"type":"user"}\n')
    const log = worktreeSessionStartsPath('demo', 'wt-1')
    await fs.mkdir(path.dirname(log), { recursive: true })
    // Project-relative, which is the form the hook records and every layer
    // above stores.
    await fs.appendFile(log, `${JSON.stringify({
      id: agentSessionId,
      tool: 'claude',
      pane: paneId?.slice(1) ?? '',
      path: path.join('claude', 'projects', '-workspace', `${agentSessionId}.jsonl`),
    })}\n`)
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
    _resetWorktreeStatusStoreForTests()
    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')

    expect(await states()).toEqual([['conv-a', true]])
  })

  it('does not revive the previous life\'s pane after a restart', async () => {
    // Nothing truncates the log, so the old pod's lines are re-folded on every
    // tick of the new one. Carrying their handles forward would be worse than
    // useless: tmux pane ids restart at %0, so the dead conversation's pane
    // number now belongs to whatever the new pod opened there, and the
    // intersection below would report it active on another conversation's
    // pane — then freeze that at teardown for the next restart to resume.
    await link('cleared-away', '%0')
    setLiveAgents('demo', 'wt-1', [{ handle: '%0', tool: 'claude' }])
    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')
    expect(await states()).toEqual([['cleared-away', true]])

    // The pod restarts: a new life, stamped at the log's current length. The
    // old line stays on disk, and the new pod hands the same pane number to a
    // different conversation.
    await recordWorktreeLife('demo', 'wt-1', await sessionStartsLogSize('demo', 'wt-1'))
    await link('the-new-one', '%0')
    setLiveAgents('demo', 'wt-1', [{ handle: '%0', tool: 'claude' }])

    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')

    // Both are still part of the worktree's history, with their transcripts.
    // Only the one this life actually opened is on the pane.
    expect(await states()).toEqual([['cleared-away', false], ['the-new-one', true]])
  })

  it('stays quiet about the log while a restarted pod has yet to append', async () => {
    // The routine post-restart state: every existing line sits BELOW the new
    // boundary, and the first new-life line will land exactly ON it. A
    // tripwire that fires here would fire on every fold during pod boot —
    // and forever for a worktree whose current life never appends at all
    // (an opencode conversation, which no hook fires for) — which trains
    // everyone to ignore it.
    await link('conv-a', '%0')
    await recordWorktreeLife('demo', 'wt-1', await sessionStartsLogSize('demo', 'wt-1'))
    setLiveAgents('demo', 'wt-1', [])

    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')

    expect(vi.mocked(serverLog).mock.calls.flat().join('\n'))
      .not.toContain('session-starts log')
  })

  it('reports a log that shrank below the boundary recorded into it', async () => {
    // Nothing yaac does can produce this — the log is only ever appended to —
    // so it means something outside replaced or rotated it. Worth saying,
    // because the symptom is otherwise silent: every line falls below the
    // boundary, loses its handle, and the worktree reports no live agents at
    // all until its next restart.
    await link('conv-a', '%0')
    await recordWorktreeLife('demo', 'wt-1', await sessionStartsLogSize('demo', 'wt-1'))
    await fs.writeFile(worktreeSessionStartsPath('demo', 'wt-1'), '')
    setLiveAgents('demo', 'wt-1', [])

    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')

    expect(vi.mocked(serverLog).mock.calls.flat().join('\n'))
      .toContain('shorter than the recorded life boundary')
  })

  it('clears the handles of a life that has ended, so a stale pane cannot resume', async () => {
    // The clear happens in the same transaction that stamps the life, which is
    // what stops a crash between the two from leaving a dead pod's handles
    // against a fresh one.
    await link('conv-a', '%0')
    setLiveAgents('demo', 'wt-1', [{ handle: '%0', tool: 'claude' }])
    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')
    expect((await listWorktreeAgentSessions('demo', 'wt-1'))[0]?.paneId).toBe('%0')

    await recordWorktreeLife('demo', 'wt-1', await sessionStartsLogSize('demo', 'wt-1'))

    const [link0] = await listWorktreeAgentSessions('demo', 'wt-1')
    expect(link0?.paneId).toBeUndefined()
    // The conversation itself survives — and so does the frozen active set a
    // restart reads back. Only the pane it sat on is forgotten.
    expect(link0?.active).toBe(true)
  })

  it('records the pinned conversation for a pod that predates the hook', async () => {
    // Nothing in the log, but the transcript the old `--session-id` pin guarantees
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
    // ACP mode has no hook and no log to fold: the server IS the ACP client, so
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
    // Recorded in the column's portable form, and resolvable back to the file
    // the adapter actually wrote — the round trip every reader depends on.
    expect(link.transcriptPath).toBe(path.join('claude', 'projects', '-workspace', 'acp-1.jsonl'))
    expect(absoluteTranscriptPath(link)).toBe(path.join(transcripts, 'acp-1.jsonl'))
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
    // No hook line and no transcript will ever exist for it, so the sweep has
    // only the pin create made — and that exemption is what keeps an opencode
    // worktree from going permanently unlabelled.
    podExec.mockResolvedValue({
      stdout: JSON.stringify([{ id: 'ses_1', title: 'build a thing', time: { updated: 1 } }]),
      stderr: '',
    })
    setLiveAgents('demo', 'wt-1', [{ handle: '%0', tool: 'opencode' }])

    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'opencode', 'tui', 'yaac-demo-wt-1')

    expect(await foundingAsk()).toBe('build a thing')
    expect((await listWorktreeAgentSessions('demo', 'wt-1'))
      .map((l) => l.agentSessionId)).toEqual(['wt-1'])
    expect(podExec.mock.calls[0]?.[0]).toBe('yaac-demo-wt-1')
  })

  // The exemption's whole safety rests on there being exactly one
  // conversation to report, because this branch does not join against the
  // live set — see the comment on the emit. If a second one ever becomes
  // reachable here, this fails rather than silently deactivating it.
  it('reports only the pinned conversation for a tool with no discovery source', async () => {
    podExec.mockResolvedValue({ stdout: '[]', stderr: '' })
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
    vi.mocked(listWorktreePods).mockRejectedValue(new Error('cluster down'))

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
