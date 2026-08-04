import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#platform/db/client'
import { claudeDir, worktreeLinksDir } from '@yaac/shared/project-paths'
import { reconcileWorktreeAgentSessions } from '#features/sessions/agent-session-registry'
import { listWorktreeAgentSessions } from '#features/sessions/agent-session-store'
import { recordWorktreeCreated } from '#features/sessions/worktree-store'
import {
  setLiveAgentPanes,
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
 */
describe('reconcileWorktreeAgentSessions', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    _resetSessionStatusStoreForTests()
    await recordWorktreeCreated({ projectSlug: 'demo', worktreeId: 'wt-1' })
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
    vi.restoreAllMocks()
  })

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
    setLiveAgentPanes('demo', 'wt-1', ['%0'])

    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')

    expect(await states()).toEqual([['conv-a', false], ['conv-b', true]])
  })

  it('deactivates a conversation whose pane exited, keeping it linked', async () => {
    await link('conv-a', '%0')
    setLiveAgentPanes('demo', 'wt-1', ['%0'])
    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')
    expect(await states()).toEqual([['conv-a', true]])

    // The pane is gone but its pointer file survives — exactly the case the
    // pointers alone would get wrong.
    setLiveAgentPanes('demo', 'wt-1', [])
    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')
    expect(await states()).toEqual([['conv-a', false]])
  })

  it('keeps two agents active on two panes, and orders them by first sighting', async () => {
    await link('conv-a', '%0')
    await link('conv-b', '%3')
    setLiveAgentPanes('demo', 'wt-1', ['%0', '%3'])

    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')

    const links = await listWorktreeAgentSessions('demo', 'wt-1')
    expect(links.map((l) => [l.agentSessionId, l.ordinal, l.active]))
      .toEqual([['conv-a', 0, true], ['conv-b', 1, true]])
  })

  it('leaves the active set untouched when no pane list has arrived yet', async () => {
    await link('conv-a', '%0')
    setLiveAgentPanes('demo', 'wt-1', ['%0'])
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
    setLiveAgentPanes('demo', 'wt-1', ['%0'])

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
    setLiveAgentPanes('demo', 'wt-1', ['%0'])

    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')

    expect(await states()).toEqual([])
  })

  it('keeps an ordinal stable once assigned, so a restart\'s windows do not reshuffle', async () => {
    await link('conv-a', '%0')
    setLiveAgentPanes('demo', 'wt-1', ['%0'])
    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')

    await link('conv-b', '%1')
    setLiveAgentPanes('demo', 'wt-1', ['%0', '%1'])
    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')
    await reconcileWorktreeAgentSessions('demo', 'wt-1', 'claude')

    const links = await listWorktreeAgentSessions('demo', 'wt-1')
    expect(links.map((l) => [l.agentSessionId, l.ordinal])).toEqual([['conv-a', 0], ['conv-b', 1]])
  })
})
