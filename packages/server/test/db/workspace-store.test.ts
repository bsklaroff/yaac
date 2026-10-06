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

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'
const OTHER = '795f3202-b17c-46bc-8d4b-771d8c6c9eaf'

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
    recordWorkspaceCreated({ projectId: PROJ, workspaceId, ...extra })

  /** A spare as prewarm leaves it: warming inserts the row, then stamps the
   *  life its pod starts. */
  const warmSpare = async (): Promise<void> => {
    await applyWorkspaceEvent({
      type: 'workspace-created', projectId: PROJ, workspaceId: 'spare1',
      spare: true, baseBranch: 'main', permissionMode: 'bypass', mode: 'tui',
    })
    await applyWorkspaceEvent({ type: 'workspace-life-started', projectId: PROJ, workspaceId: 'spare1' })
  }

  describe('recordWorkspaceCreated', () => {
    it('stores the row', async () => {
      await create('sid-1', { baseBranch: 'main' })

      const row = (await getProjectWorkspaceRows(PROJ)).get('sid-1')
      expect(row).toMatchObject({
        projectId: PROJ,
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

      await claimSpareWorkspace(PROJ, 'spare1', {
        permissionMode: 'plan', mode: 'acp', model: 'claude-opus-5-5',
      })

      expect(await getWorkspaceRow(PROJ, 'spare1')).toMatchObject({
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
      await expect(claimSpareWorkspace(PROJ, 'spare1')).rejects.toMatchObject({ code: 'CONFLICT' })
      await expect(claimSpareWorkspace(PROJ, 'no-such-spare')).rejects.toMatchObject({ code: 'CONFLICT' })
    })
  })

  describe('restoreSpareWorkspace', () => {
    it('puts back everything the claim stamped and drops the conversation it recorded', async () => {
      await warmSpare()
      const warmed = (await getWorkspaceRow(PROJ, 'spare1'))!
      await claimSpareWorkspace(PROJ, 'spare1', {
        permissionMode: 'plan', mode: 'acp', model: 'claude-opus-5-5',
      })
      await applyWorkspaceEvent({
        type: 'sessions-launched', projectId: PROJ, workspaceId: 'spare1',
        sessions: [{ tool: 'claude', agentSessionId: 'spare1' }],
      })

      await restoreSpareWorkspace(warmed)

      expect(await getWorkspaceRow(PROJ, 'spare1')).toEqual(warmed)
      expect(await firstAgentSession(PROJ, 'spare1')).toBeUndefined()
    })
  })

  describe('deletion', () => {
    it('records the deletion time and clears it again on restart', async () => {
      await create('sid-1')
      await recordWorkspaceStopped(PROJ, 'sid-1')
      expect((await getProjectWorkspaceRows(PROJ)).get('sid-1')?.stoppedAt).toBeInstanceOf(Date)

      await clearWorkspaceStopped(PROJ, 'sid-1')
      expect((await getProjectWorkspaceRows(PROJ)).get('sid-1')?.stoppedAt).toBeUndefined()
    })

    it('stores a reaper-supplied cause and drops it on a plain delete', async () => {
      await create('sid-1')
      await recordWorkspaceStopped(PROJ, 'sid-1', { reason: 'oom', detail: 'exit code 137' })
      expect((await getProjectWorkspaceRows(PROJ)).get('sid-1')).toMatchObject({
        deathReason: 'oom',
        deathDetail: 'exit code 137',
      })

      await recordWorkspaceStopped(PROJ, 'sid-1')
      const row = (await getProjectWorkspaceRows(PROJ)).get('sid-1')
      expect(row?.deathReason).toBeUndefined()
      expect(row?.deathDetail).toBeUndefined()
    })

    it('tracks whether the user has seen the death, re-flagging on a re-death', async () => {
      await create('sid-1')
      await recordWorkspaceStopped(PROJ, 'sid-1', { reason: 'crashed' })
      expect((await getProjectWorkspaceRows(PROJ)).get('sid-1')?.deathSeen).toBe(false)

      await recordDeathSeen(PROJ, 'sid-1')
      expect((await getProjectWorkspaceRows(PROJ)).get('sid-1')?.deathSeen).toBe(true)

      await recordWorkspaceStopped(PROJ, 'sid-1', { reason: 'evicted' })
      expect((await getProjectWorkspaceRows(PROJ)).get('sid-1')?.deathSeen).toBe(false)
    })

    it('never creates a row — an unrecorded session (a prewarmed spare) stays invisible', async () => {
      await recordWorkspaceStopped(PROJ, 'spare')
      await recordDeathSeen(PROJ, 'spare')
      await setWorkspaceTitle(PROJ, 'spare', 'nope')
      expect(await listWorkspaceRows()).toEqual([])
    })
  })

  describe('title', () => {
    it('normalizes on write and clears on a blank title', async () => {
      await create('sid-1')
      await setWorkspaceTitle(PROJ, 'sid-1', '  fix   the  parser \n')
      expect((await getProjectWorkspaceRows(PROJ)).get('sid-1')?.title).toBe('fix the parser')

      await setWorkspaceTitle(PROJ, 'sid-1', '   ')
      expect((await getProjectWorkspaceRows(PROJ)).get('sid-1')?.title).toBeUndefined()
    })

    it('with ifUntitled, writes only a row that has no title yet', async () => {
      await create('sid-1')
      await create('sid-2')
      await setWorkspaceTitle(PROJ, 'sid-1', 'user rename')
      await setWorkspaceTitle(PROJ, 'sid-1', 'generated', { ifUntitled: true })
      await setWorkspaceTitle(PROJ, 'sid-2', 'generated', { ifUntitled: true })

      const rows = await getProjectWorkspaceRows(PROJ)
      expect(rows.get('sid-1')?.title).toBe('user rename')
      expect(rows.get('sid-2')?.title).toBe('generated')
    })

    // The rename is a snapshot input, so the writer pushes it; the route and
    // title generator need not know about the push channel.
    it('pushes a fresh snapshot on every write', async () => {
      await create('sid-1')
      const before = pushes
      await setWorkspaceTitle(PROJ, 'sid-1', 'renamed')
      expect(pushes - before).toBe(1)
      await setWorkspaceTitle(PROJ, 'sid-1', '')
      expect(pushes - before).toBe(2)
    })
  })

  describe('deleteWorkspaceRow', () => {
    it('removes one session and leaves its siblings', async () => {
      await create('sid-1')
      await create('sid-2')
      await deleteWorkspaceRow(PROJ, 'sid-1')
      expect((await listWorkspaceRows(PROJ)).map((r) => r.workspaceId)).toEqual(['sid-2'])
    })

    it('is a no-op for a session that was never recorded', async () => {
      await expect(deleteWorkspaceRow(PROJ, 'ghost')).resolves.toBeUndefined()
    })
  })

  describe('setWorkspaceBaseBranch', () => {
    it('stamps the branch after the row exists, without touching anything else', async () => {
      await create('sid-1')
      await setWorkspaceBaseBranch(PROJ, 'sid-1', 'release/2.x')
      expect((await getProjectWorkspaceRows(PROJ)).get('sid-1')).toMatchObject({
        baseBranch: 'release/2.x',
      })
    })

    it('no-ops for an unrecorded session rather than creating one', async () => {
      await setWorkspaceBaseBranch(PROJ, 'ghost', 'main')
      expect(await listWorkspaceRows(PROJ)).toEqual([])
    })
  })

  describe('listLiveWorkspaceRows', () => {
    it('excludes stopped workspaces and reports whether each ever ran', async () => {
      // A link alone proves nothing: create records one before the agent
      // launches. `ran` needs a captured opening message or a transcript.
      await create('never-ran')
      await recordAgentSessions(PROJ, 'never-ran', [
        { tool: 'claude', agentSessionId: 'never-ran' },
      ])
      await create('has-prompt')
      await recordAgentSessions(PROJ, 'has-prompt', [
        { tool: 'claude', agentSessionId: 'conv-a', firstPrompt: 'hello' },
      ])
      await create('has-transcript')
      await recordAgentSessions(PROJ, 'has-transcript', [
        {
          tool: 'claude',
          agentSessionId: 'conv-b',
          // Inside the tool home: the column stores paths relative to it, so
          // one outside has no storable form and would record as null.
          transcriptPath: path.join(claudeDir(PROJ), 'projects', '-workspace', 'conv-b.jsonl'),
        },
      ])
      await create('gone')
      await recordWorkspaceStopped(PROJ, 'gone')

      const rows = await listLiveWorkspaceRows()
      expect(rows.map((r) => [r.workspaceId, r.ran]).sort())
        .toEqual([['has-prompt', true], ['has-transcript', true], ['never-ran', false]])
    })
  })

  describe('deleteProjectWorkspaces', () => {
    it('forgets one project\'s sessions and leaves the rest', async () => {
      await create('sid-1')
      await create('sid-2')
      await recordWorkspaceCreated({ projectId: OTHER, workspaceId: 'sid-3' })

      await deleteProjectWorkspaces(PROJ)

      expect(await listWorkspaceRows(PROJ)).toEqual([])
      expect((await listWorkspaceRows(OTHER)).map((r) => r.workspaceId)).toEqual(['sid-3'])
    })
  })

  describe('getWorkspaceRow', () => {
    it('point-reads one session, in the project named', async () => {
      await create('sid-1')

      expect(await getWorkspaceRow(PROJ, 'sid-1')).toMatchObject({ workspaceId: 'sid-1' })
      expect(await getWorkspaceRow(OTHER, 'sid-1')).toBeUndefined()
      expect(await getWorkspaceRow(PROJ, 'nope')).toBeUndefined()
    })
  })

  describe('listStoppedWorkspaceIds', () => {
    it('returns only sessions with a recorded deletion, keyed by project', async () => {
      await create('live')
      await create('dead')
      await recordWorkspaceStopped(PROJ, 'dead')

      expect(await listStoppedWorkspaceIds()).toEqual(new Set([`${PROJ}/dead`]))
    })
  })

  describe('findWorkspaceRow', () => {
    it('finds an exact id in whichever project holds it, and nothing shorter', async () => {
      await create('abcdef-1234')
      await recordWorkspaceCreated({ projectId: OTHER, workspaceId: 'zzz' })
      await create('spare-1', { spare: true })

      expect((await findWorkspaceRow('abcdef-1234'))?.projectId).toBe(PROJ)
      expect((await findWorkspaceRow('zzz'))?.projectId).toBe(OTHER)
      // Prefix expansion is domain's `resolveWorkspace`, never this.
      expect(await findWorkspaceRow('abcdef')).toBeUndefined()
      expect(await findWorkspaceRow('spare-1')).toBeUndefined()
      expect(await findWorkspaceRow('nope')).toBeUndefined()
      expect(await findWorkspaceRow('')).toBeUndefined()
    })
  })
})
