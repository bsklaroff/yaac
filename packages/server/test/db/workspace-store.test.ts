import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { claudeDir } from '@yaac/shared/project-paths'
import { closeDb } from '#db/client'
import {
  deleteProjectWorkspaces,
  deleteWorkspaceRow,
  findWorkspaceRow,
  listLiveWorkspaceRows,
  priorStopOf,
  restoreWorkspaceStop,
  setWorkspaceBaseBranch,
  getProjectWorkspaceRows,
  getWorkspaceRow,
  listStoppedWorkspaceIds,
  listWorkspaceRows,
  recordDeathSeen,
  recordWorkspaceCreated,
  recordWorkspaceStopped,
  claimSpareWorkspace,
  restoreSpareWorkspace,
  clearWorkspaceStopped,
  setWorkspaceTitle,
} from '#db/workspace-store'
import { applyWorkspaceEvent } from '#db/apply-workspace-event'
import { firstAgentSession, recordAgentSessions } from '#db/agent-session-store'
import { onWorkspaceListChanged, _resetWorkspaceListChangedForTests } from '#notify'

describe('session store', () => {
  let tmpDir: string

  let pushes: number

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    _resetWorkspaceListChangedForTests()
    pushes = 0
    onWorkspaceListChanged(() => { pushes += 1 })
  })

  afterEach(async () => {
    _resetWorkspaceListChangedForTests()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  const create = (workspaceId: string, extra = {}): Promise<void> =>
    recordWorkspaceCreated({ projectSlug: 'proj', workspaceId, ...extra })

  /** A spare as prewarm leaves it: warming inserts the row, then stamps the
   *  life its pod starts. */
  const warmSpare = async (): Promise<void> => {
    await applyWorkspaceEvent({
      type: 'workspace-created', projectSlug: 'proj', workspaceId: 'spare1',
      spare: true, baseBranch: 'main', permissionMode: 'bypass', mode: 'tui',
    })
    await applyWorkspaceEvent({ type: 'workspace-life-started', projectSlug: 'proj', workspaceId: 'spare1' })
  }

  describe('recordWorkspaceCreated', () => {
    it('stores the row', async () => {
      await create('sid-1', { baseBranch: 'main' })

      const row = (await getProjectWorkspaceRows('proj')).get('sid-1')
      expect(row).toMatchObject({
        projectSlug: 'proj',
        workspaceId: 'sid-1',
        baseBranch: 'main',
        deathSeen: false,
      })
      expect(row?.stoppedAt).toBeUndefined()
    })
  })

  // The calls prewarm makes, against the real table: warming inserts the
  // row, and the claim must reuse it, since a second insert on the id is
  // refused (which would send every claim to a cold create).
  describe('claimSpareWorkspace', () => {
    const warmT = new Date('2026-01-01T00:00:00Z')
    const claimT = new Date('2026-01-01T00:05:00Z')
    afterEach(() => { vi.useRealTimers() })

    it('hands the warmed row over with the claim\'s launch and time, and refuses a second claim', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(warmT)
      await warmSpare()
      pushes = 0
      vi.setSystemTime(claimT)

      await claimSpareWorkspace('proj', 'spare1', {
        permissionMode: 'plan', mode: 'acp', model: 'claude-opus-5-5',
      })

      expect(await getWorkspaceRow('proj', 'spare1')).toMatchObject({
        spare: false,
        // The workspace is born at the claim, not the warm…
        createdAt: claimT,
        // …but it is the warmed row: only warming stamps the life.
        lifeStartedAt: warmT,
        permissionMode: 'plan',
        mode: 'acp',
        model: 'claude-opus-5-5',
      })
      expect(pushes).toBe(1)
      await expect(claimSpareWorkspace('proj', 'spare1')).rejects.toMatchObject({ code: 'CONFLICT' })
      await expect(claimSpareWorkspace('proj', 'no-such-spare')).rejects.toMatchObject({ code: 'CONFLICT' })
    })
  })

  describe('restoreSpareWorkspace', () => {
    it('puts back everything the claim stamped and drops the conversation it recorded', async () => {
      await warmSpare()
      const warmed = (await getWorkspaceRow('proj', 'spare1'))!
      await claimSpareWorkspace('proj', 'spare1', {
        permissionMode: 'plan', mode: 'acp', model: 'claude-opus-5-5',
      })
      await applyWorkspaceEvent({
        type: 'sessions-launched', projectSlug: 'proj', workspaceId: 'spare1',
        sessions: [{ tool: 'claude', agentSessionId: 'spare1' }],
      })

      await restoreSpareWorkspace(warmed)

      expect(await getWorkspaceRow('proj', 'spare1')).toEqual(warmed)
      expect(await firstAgentSession('proj', 'spare1')).toBeUndefined()
    })
  })

  describe('deletion', () => {
    it('records the deletion time and clears it again on restart', async () => {
      await create('sid-1')
      await recordWorkspaceStopped('proj', 'sid-1')
      expect((await getProjectWorkspaceRows('proj')).get('sid-1')?.stoppedAt).toBeInstanceOf(Date)

      await clearWorkspaceStopped('proj', 'sid-1')
      expect((await getProjectWorkspaceRows('proj')).get('sid-1')?.stoppedAt).toBeUndefined()
    })

    it('stores a reaper-supplied cause and drops it on a plain delete', async () => {
      await create('sid-1')
      await recordWorkspaceStopped('proj', 'sid-1', { reason: 'oom', detail: 'exit code 137' })
      expect((await getProjectWorkspaceRows('proj')).get('sid-1')).toMatchObject({
        deathReason: 'oom',
        deathDetail: 'exit code 137',
      })

      await recordWorkspaceStopped('proj', 'sid-1')
      const row = (await getProjectWorkspaceRows('proj')).get('sid-1')
      expect(row?.deathReason).toBeUndefined()
      expect(row?.deathDetail).toBeUndefined()
    })

    it('tracks whether the user has seen the death, re-flagging on a re-death', async () => {
      await create('sid-1')
      await recordWorkspaceStopped('proj', 'sid-1', { reason: 'crashed' })
      expect((await getProjectWorkspaceRows('proj')).get('sid-1')?.deathSeen).toBe(false)

      await recordDeathSeen('proj', 'sid-1')
      expect((await getProjectWorkspaceRows('proj')).get('sid-1')?.deathSeen).toBe(true)

      await recordWorkspaceStopped('proj', 'sid-1', { reason: 'evicted' })
      expect((await getProjectWorkspaceRows('proj')).get('sid-1')?.deathSeen).toBe(false)
    })

    it('never creates a row — an unrecorded session (a prewarmed spare) stays invisible', async () => {
      await recordWorkspaceStopped('proj', 'spare')
      await recordDeathSeen('proj', 'spare')
      await setWorkspaceTitle('proj', 'spare', 'nope')
      expect(await listWorkspaceRows()).toEqual([])
    })
  })

  describe('title', () => {
    it('normalizes on write and clears on a blank title', async () => {
      await create('sid-1')
      await setWorkspaceTitle('proj', 'sid-1', '  fix   the  parser \n')
      expect((await getProjectWorkspaceRows('proj')).get('sid-1')?.title).toBe('fix the parser')

      await setWorkspaceTitle('proj', 'sid-1', '   ')
      expect((await getProjectWorkspaceRows('proj')).get('sid-1')?.title).toBeUndefined()
    })

    it('with ifUntitled, writes only a row that has no title yet', async () => {
      await create('sid-1')
      await create('sid-2')
      await setWorkspaceTitle('proj', 'sid-1', 'user rename')
      await setWorkspaceTitle('proj', 'sid-1', 'generated', { ifUntitled: true })
      await setWorkspaceTitle('proj', 'sid-2', 'generated', { ifUntitled: true })

      const rows = await getProjectWorkspaceRows('proj')
      expect(rows.get('sid-1')?.title).toBe('user rename')
      expect(rows.get('sid-2')?.title).toBe('generated')
    })

    // The rename is a snapshot input, so the writer pushes it; the route and
    // title generator need not know about the push channel.
    it('pushes a fresh snapshot on every write', async () => {
      await create('sid-1')
      const before = pushes
      await setWorkspaceTitle('proj', 'sid-1', 'renamed')
      expect(pushes - before).toBe(1)
      await setWorkspaceTitle('proj', 'sid-1', '')
      expect(pushes - before).toBe(2)
    })
  })

  describe('deleteWorkspaceRow', () => {
    it('removes one session and leaves its siblings', async () => {
      await create('sid-1')
      await create('sid-2')
      await deleteWorkspaceRow('proj', 'sid-1')
      expect((await listWorkspaceRows('proj')).map((r) => r.workspaceId)).toEqual(['sid-2'])
    })

    it('is a no-op for a session that was never recorded', async () => {
      await expect(deleteWorkspaceRow('proj', 'ghost')).resolves.toBeUndefined()
    })
  })

  describe('setWorkspaceBaseBranch', () => {
    it('stamps the branch after the row exists, without touching anything else', async () => {
      await create('sid-1')
      await setWorkspaceBaseBranch('proj', 'sid-1', 'release/2.x')
      expect((await getProjectWorkspaceRows('proj')).get('sid-1')).toMatchObject({
        baseBranch: 'release/2.x',
      })
    })

    it('no-ops for an unrecorded session rather than creating one', async () => {
      await setWorkspaceBaseBranch('proj', 'ghost', 'main')
      expect(await listWorkspaceRows('proj')).toEqual([])
    })
  })

  describe('listLiveWorkspaceRows', () => {
    it('excludes stopped workspaces and reports whether each ever ran', async () => {
      // A link alone proves nothing: create records one before the agent
      // launches. `ran` needs a captured opening message or a transcript.
      await create('never-ran')
      await recordAgentSessions('proj', 'never-ran', [
        { tool: 'claude', agentSessionId: 'never-ran' },
      ])
      await create('has-prompt')
      await recordAgentSessions('proj', 'has-prompt', [
        { tool: 'claude', agentSessionId: 'conv-a', firstPrompt: 'hello' },
      ])
      await create('has-transcript')
      await recordAgentSessions('proj', 'has-transcript', [
        {
          tool: 'claude',
          agentSessionId: 'conv-b',
          // Inside the tool home: the column stores paths relative to it, so
          // one outside has no storable form and would record as null.
          transcriptPath: path.join(claudeDir('proj'), 'projects', '-workspace', 'conv-b.jsonl'),
        },
      ])
      await create('gone')
      await recordWorkspaceStopped('proj', 'gone')

      const rows = await listLiveWorkspaceRows()
      expect(rows.map((r) => [r.workspaceId, r.ran]).sort())
        .toEqual([['has-prompt', true], ['has-transcript', true], ['never-ran', false]])
    })
  })

  describe('restoreWorkspaceStop', () => {
    it('puts a failed restart\'s row back, cause and seen flag intact', async () => {
      await create('sid-1')
      await recordWorkspaceStopped('proj', 'sid-1', { reason: 'oom', detail: 'exit code 137' })
      await recordDeathSeen('proj', 'sid-1')
      const before = (await getProjectWorkspaceRows('proj')).get('sid-1')
      const prior = priorStopOf(before)
      expect(prior).toBeDefined()

      // The restart clears the deletion, then fails.
      await clearWorkspaceStopped('proj', 'sid-1')
      await restoreWorkspaceStop('proj', 'sid-1', prior!)

      expect((await getProjectWorkspaceRows('proj')).get('sid-1')).toMatchObject({
        stoppedAt: before?.stoppedAt,
        deathReason: 'oom',
        deathDetail: 'exit code 137',
        deathSeen: true, // the user had already dismissed this death
      })
    })

    it('priorStopOf ignores a row that was not deleted', async () => {
      await clearWorkspaceStopped('proj', 'sid-1')
      expect(priorStopOf((await getProjectWorkspaceRows('proj')).get('sid-1'))).toBeUndefined()
      expect(priorStopOf(undefined)).toBeUndefined()
    })
  })

  describe('deleteProjectWorkspaces', () => {
    it('forgets one project\'s sessions and leaves the rest', async () => {
      await create('sid-1')
      await create('sid-2')
      await recordWorkspaceCreated({ projectSlug: 'other', workspaceId: 'sid-3' })

      await deleteProjectWorkspaces('proj')

      expect(await listWorkspaceRows('proj')).toEqual([])
      expect((await listWorkspaceRows('other')).map((r) => r.workspaceId)).toEqual(['sid-3'])
    })
  })

  describe('getWorkspaceRow', () => {
    it('point-reads one session, in the project named', async () => {
      await create('sid-1')

      expect(await getWorkspaceRow('proj', 'sid-1')).toMatchObject({ workspaceId: 'sid-1' })
      expect(await getWorkspaceRow('other', 'sid-1')).toBeUndefined()
      expect(await getWorkspaceRow('proj', 'nope')).toBeUndefined()
    })
  })

  describe('listStoppedWorkspaceIds', () => {
    it('returns only sessions with a recorded deletion, keyed by project', async () => {
      await create('live')
      await create('dead')
      await recordWorkspaceStopped('proj', 'dead')

      expect(await listStoppedWorkspaceIds()).toEqual(new Set(['proj/dead']))
    })
  })

  describe('findWorkspaceRow', () => {
    it('finds an exact id in whichever project holds it, and nothing shorter', async () => {
      await create('abcdef-1234')
      await recordWorkspaceCreated({ projectSlug: 'other', workspaceId: 'zzz' })
      await create('spare-1', { spare: true })

      expect((await findWorkspaceRow('abcdef-1234'))?.projectSlug).toBe('proj')
      expect((await findWorkspaceRow('zzz'))?.projectSlug).toBe('other')
      // Prefix expansion is domain's `resolveWorkspace`, never this.
      expect(await findWorkspaceRow('abcdef')).toBeUndefined()
      expect(await findWorkspaceRow('spare-1')).toBeUndefined()
      expect(await findWorkspaceRow('nope')).toBeUndefined()
      expect(await findWorkspaceRow('')).toBeUndefined()
    })
  })
})
