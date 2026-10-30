import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { sql } from 'drizzle-orm'
import { closeDb, getDb } from '#db/client'
import {
  backfillWorkspaceScratchDirs,
  deleteProjectWorkspaces,
  forgetWorkspaceScratchDirs,
  deleteWorkspaceRecords,
  findWorkspaceRow,
  listLiveWorkspaceRows,
  setWorkspaceBaseBranch,
  getProjectWorkspaceRows,
  getWorkspaceRow,
  countStoppedWorkspaces,
  listStoppedWorkspaceRows,
  listUncleanedStoppedWorkspaces,
  recordIgnoredFilesCleaned,
  listWorkspaceRows,
  listProjectWorkspaceIds,
  listOverdueWorkspaceRows,
  recordDeathSeen,
  recordWorkspaceCreated,
  recordWorkspaceLife,
  recordWorkspaceResumed,
  recordWorkspaceStopped,
  setWorkspaceDeadline,
  clearWorkspaceStopped,
  setWorkspaceGeneratedTitle,
  setWorkspaceTitle,
  type StoppedRowCursor,
} from '#db/workspace-store'
import { createWorkspaceGroup, deleteWorkspaceGroup } from '#db/group-store'
import { listWorkspaceConversations, recordConversations } from '#db/conversation-store'
import { insertSession, markSessionsLaunched } from '#db/session-store'
import { BUILT_IN_USER_ID } from '#db/user-store'
import { onWorkspaceListChanged, _resetWorkspaceListChangedForTests } from '#lib/notify'

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'
const OTHER = '795f3202-b17c-46bc-8d4b-771d8c6c9eaf'
const TEAMMATE = '5b1c9d3e-2f0a-4e6b-9c7d-8a1e2f3b4c5d'

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

  describe('recordWorkspaceCreated', () => {
    it('stores the row', async () => {
      await create('sid-1', { baseBranch: 'main' })

      const row = (await getProjectWorkspaceRows(PROJ)).get('sid-1')
      expect(row).toMatchObject({
        projectId: PROJ,
        workspaceId: 'sid-1',
        baseBranch: 'main',
        deathSeenBy: [],
      })
      expect(row?.stoppedAt).toBeUndefined()
    })

    it('files it under its title and group, or ungrouped once the group is gone', async () => {
      const group = await createWorkspaceGroup(PROJ, 'Team', null)
      const gone = await createWorkspaceGroup(PROJ, 'Gone', null)
      await deleteWorkspaceGroup(PROJ, gone.groupId)

      await create('filed', { title: '  Fix   it ', groupId: group.groupId })
      await create('orphan', { title: ' ', groupId: gone.groupId })

      expect(await getWorkspaceRow(PROJ, 'filed')).toMatchObject({ title: 'Fix it', groupId: group.groupId })
      const orphan = await getWorkspaceRow(PROJ, 'orphan')
      expect(orphan?.title).toBeUndefined()
      expect(orphan?.groupId).toBeUndefined()
      await expect(create('filed')).rejects.toMatchObject({ code: 'CONFLICT' })
    })
  })

  describe('deadline', () => {
    it('is stored at create, changed only while running, listed once overdue, and replaced by a restart', async () => {
      const at = new Date('2026-10-24T09:00:00Z')
      await create('timed', { deadline: at })
      await create('untimed')
      expect((await getWorkspaceRow(PROJ, 'timed'))?.deadline).toEqual(at)
      expect(await listOverdueWorkspaceRows(new Date('2026-10-24T08:59:00Z'))).toEqual([])
      expect((await listOverdueWorkspaceRows(at)).map((r) => r.workspaceId)).toEqual(['timed'])

      const later = new Date('2026-10-24T10:00:00Z')
      pushes = 0
      expect(await setWorkspaceDeadline(PROJ, 'untimed', later)).toBe(true)
      expect(pushes).toBe(1)
      expect((await listOverdueWorkspaceRows(later)).map((r) => r.workspaceId).sort()).toEqual(['timed', 'untimed'])

      // Stopped rows are not overdue, and only a restart sets their next one.
      await recordWorkspaceStopped(PROJ, 'timed')
      expect((await listOverdueWorkspaceRows(later)).map((r) => r.workspaceId)).toEqual(['untimed'])
      expect(await setWorkspaceDeadline(PROJ, 'timed', null)).toBe(false)
      await recordWorkspaceResumed({ projectId: PROJ, workspaceId: 'timed' })
      expect((await getWorkspaceRow(PROJ, 'timed'))?.deadline).toBeUndefined()
      await recordWorkspaceResumed({ projectId: PROJ, workspaceId: 'timed', deadline: later })
      expect((await getWorkspaceRow(PROJ, 'timed'))?.deadline).toEqual(later)
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

    it('keeps the first stop of a life, but replaces one recorded before the current life', async () => {
      const stoppedAt = async () => (await getProjectWorkspaceRows(PROJ)).get('sid-1')?.stoppedAt?.getTime()
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(1_000_000)
        await create('sid-1')
        await recordWorkspaceLife(PROJ, 'sid-1')
        vi.setSystemTime(2_000_000)
        await recordWorkspaceStopped(PROJ, 'sid-1')
        // A second stop in the same life (a reaper probing a user stop).
        vi.setSystemTime(3_000_000)
        await recordWorkspaceStopped(PROJ, 'sid-1', { reason: 'crashed' })
        expect(await stoppedAt()).toBe(2_000_000)

        // A restart whose clear of the stop was lost, then a stop much later.
        vi.setSystemTime(4_000_000)
        await recordWorkspaceLife(PROJ, 'sid-1')
        vi.setSystemTime(9_000_000)
        await recordWorkspaceStopped(PROJ, 'sid-1')
        expect(await stoppedAt()).toBe(9_000_000)
      } finally {
        vi.useRealTimers()
      }
    })

    it('tracks which users have seen the death, re-flagging on a re-death', async () => {
      const seen = async () => (await getProjectWorkspaceRows(PROJ)).get('sid-1')?.deathSeenBy
      await create('sid-1')
      await recordWorkspaceStopped(PROJ, 'sid-1', { reason: 'crashed' })
      expect(await seen()).toEqual([])

      await recordDeathSeen(PROJ, 'sid-1', TEAMMATE)
      await recordDeathSeen(PROJ, 'sid-1', BUILT_IN_USER_ID)
      await recordDeathSeen(PROJ, 'sid-1', TEAMMATE)
      expect(await seen()).toEqual([TEAMMATE, BUILT_IN_USER_ID])

      await clearWorkspaceStopped(PROJ, 'sid-1')
      await recordWorkspaceStopped(PROJ, 'sid-1', { reason: 'evicted' })
      expect(await seen()).toEqual([])
    })

    it('never creates a row — an unrecorded session (a prewarmed spare) stays invisible', async () => {
      await recordWorkspaceStopped(PROJ, 'spare')
      await recordDeathSeen(PROJ, 'spare', BUILT_IN_USER_ID)
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

    // A generated title sits beside the user's, and the first one recorded
    // (carried from a draft at create, or generated later) is kept.
    it('records a generated title apart from the user one, only while there is none', async () => {
      await create('sid-1')
      await setWorkspaceTitle(PROJ, 'sid-1', 'user rename')
      await setWorkspaceGeneratedTitle(PROJ, 'sid-1', 'Generated')
      await setWorkspaceGeneratedTitle(PROJ, 'sid-1', 'Generated again')
      expect((await getProjectWorkspaceRows(PROJ)).get('sid-1'))
        .toMatchObject({ title: 'user rename', generatedTitle: 'Generated' })
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

  describe('deleteWorkspaceRecords', () => {
    it('removes one workspace and its conversation links, leaving its siblings', async () => {
      await create('sid-1')
      await create('sid-2')
      await recordConversations(PROJ, 'sid-1', [{ tool: 'claude', conversationId: 'conv-1' }])
      const before = pushes
      await deleteWorkspaceRecords(PROJ, 'sid-1')
      expect((await listWorkspaceRows(PROJ)).map((r) => r.workspaceId)).toEqual(['sid-2'])
      expect(await listWorkspaceConversations(PROJ, 'sid-1')).toEqual([])
      expect(pushes - before).toBe(1)
    })

    it('is a no-op for a workspace that was never recorded', async () => {
      await expect(deleteWorkspaceRecords(PROJ, 'ghost')).resolves.toBeUndefined()
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
      // Only a live agent names a conversation, so any recorded one proves a
      // start; so does a session whose window was launched.
      await create('never-ran')
      await insertSession(PROJ, 'never-ran', { tool: 'claude', mode: 'tui', permissionMode: 'bypass' })
      await create('conversed')
      await recordConversations(PROJ, 'conversed', [{ tool: 'opencode', conversationId: 'ses_1' }])
      await create('launched')
      const s = await insertSession(PROJ, 'launched', { tool: 'claude', mode: 'acp', permissionMode: 'bypass' })
      await markSessionsLaunched([s.id])
      await create('gone')
      await recordWorkspaceStopped(PROJ, 'gone')

      const rows = await listLiveWorkspaceRows()
      expect(rows.map((r) => [r.workspaceId, r.ran]).sort()).toEqual([
        ['conversed', true], ['launched', true], ['never-ran', false],
      ])
    })
  })

  describe('forgetWorkspaceScratchDirs', () => {
    it('takes the paths off what the workspace started with, leaving a row that records none', async () => {
      await create('started', { scratchDirs: ['node_modules', 'target'] })
      await create('old')

      await forgetWorkspaceScratchDirs(PROJ, 'started', ['target'])
      await forgetWorkspaceScratchDirs(PROJ, 'old', ['target'])

      expect((await getWorkspaceRow(PROJ, 'started'))?.scratchDirs).toEqual(['node_modules'])
      expect((await getWorkspaceRow(PROJ, 'old'))?.scratchDirs).toBeUndefined()
    })
  })

  describe('backfillWorkspaceScratchDirs', () => {
    it('fills only the project\'s rows that record none', async () => {
      await create('old')
      await create('new', { scratchDirs: ['node_modules', 'target'] })
      await recordWorkspaceCreated({ projectId: OTHER, workspaceId: 'elsewhere' })

      await backfillWorkspaceScratchDirs(PROJ, ['web/node_modules'])

      expect((await getWorkspaceRow(PROJ, 'old'))?.scratchDirs).toEqual(['web/node_modules'])
      expect((await getWorkspaceRow(PROJ, 'new'))?.scratchDirs).toEqual(['node_modules', 'target'])
      expect((await getWorkspaceRow(OTHER, 'elsewhere'))?.scratchDirs).toBeUndefined()
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

  describe('listStoppedWorkspaceRows', () => {
    it('lists recorded stops newest first, leaving out the excluded ids, with the full total', async () => {
      await create('live')
      for (const id of ['a', 'b', 'c']) {
        await create(id)
        await recordWorkspaceStopped(PROJ, id)
        await new Promise((r) => setTimeout(r, 5))
      }

      const page = await listStoppedWorkspaceRows({ projectIds: [PROJ], excludeIds: ['b'] }, { limit: 1 })
      expect(page.rows.map((r) => r.workspaceId)).toEqual(['c'])
      expect(page.total).toBe(2)
      const c = page.rows[0]
      const rest = await listStoppedWorkspaceRows(
        { projectIds: [PROJ], excludeIds: ['b'] },
        { after: { stoppedAt: c?.stoppedAt ?? new Date(), workspaceId: 'c' } },
      )
      expect(rest.rows.map((r) => r.workspaceId)).toEqual(['a'])
    })

    it('lists only the named projects, and nothing for none', async () => {
      await create('mine')
      await recordWorkspaceStopped(PROJ, 'mine')
      expect((await listStoppedWorkspaceRows({ projectIds: [PROJ] })).rows.map((r) => r.workspaceId)).toEqual(['mine'])
      expect((await listStoppedWorkspaceRows({ projectIds: ['0a0a0a0a-0000-4000-8000-0000000000ff'] })).total).toBe(0)
      expect((await listStoppedWorkspaceRows({ projectIds: [] })).total).toBe(0)
    })

    it('pages stops written with microseconds without skipping any', async () => {
      // Older installs hold stops the database stamped, with microseconds;
      // a cursor carries milliseconds.
      const ids = ['us-1', 'us-2', 'us-3', 'us-4']
      for (const id of ids) {
        await create(id)
        await recordWorkspaceStopped(PROJ, id)
      }
      const db = await getDb()
      for (const [i, id] of ids.entries()) {
        await db.execute(sql`update workspaces set stopped_at = ${`2026-07-01 00:00:00.000${i + 1}00+00`}::timestamptz
          where workspace_id = ${id}`)
      }
      const seen: string[] = []
      let after: StoppedRowCursor | undefined
      for (let i = 0; i < 4; i++) {
        const { rows } = await listStoppedWorkspaceRows({ projectIds: [PROJ] }, { limit: 1, ...(after ? { after } : {}) })
        const row = rows[0]
        if (row?.stoppedAt === undefined) break
        seen.push(row.workspaceId)
        after = { stoppedAt: row.stoppedAt, workspaceId: row.workspaceId }
      }
      expect(seen).toEqual(['us-4', 'us-3', 'us-2', 'us-1'])
    })
  })

  describe('listUncleanedStoppedWorkspaces', () => {
    it('lists stopped workspaces not cleaned since their stop, oldest stop first', async () => {
      for (const id of ['live', 'first', 'cleaned', 'second']) await recordWorkspaceCreated({ projectId: PROJ, workspaceId: id })
      for (const id of ['first', 'cleaned', 'second']) {
        await recordWorkspaceStopped(PROJ, id)
        await new Promise((r) => setTimeout(r, 5))
      }
      await recordIgnoredFilesCleaned(PROJ, 'cleaned', new Date())
      expect(await listUncleanedStoppedWorkspaces()).toEqual([
        { projectId: PROJ, workspaceId: 'first' },
        { projectId: PROJ, workspaceId: 'second' },
      ])

      // A later stop needs another clean.
      await clearWorkspaceStopped(PROJ, 'cleaned')
      await recordWorkspaceStopped(PROJ, 'cleaned')
      expect((await listUncleanedStoppedWorkspaces()).map((w) => w.workspaceId)).toEqual(['first', 'second', 'cleaned'])
    })
  })

  describe('countStoppedWorkspaces', () => {
    it('counts stops, deaths and who saw them per project and group, less the stops excluded', async () => {
      await create('live')
      await create('quit')
      await recordWorkspaceStopped(PROJ, 'quit')
      await create('oom')
      await recordWorkspaceStopped(PROJ, 'oom', { reason: 'oom' })
      await create('seen')
      await recordWorkspaceStopped(PROJ, 'seen', { reason: 'oom' })
      // The snapshot carries who saw each death, so marking one seen pushes.
      const before = pushes
      await recordDeathSeen(PROJ, 'seen', BUILT_IN_USER_ID)
      expect(pushes).toBe(before + 1)
      await recordDeathSeen(PROJ, 'seen', TEAMMATE)
      await recordDeathSeen(PROJ, 'oom', TEAMMATE)
      await recordWorkspaceCreated({ projectId: OTHER, workspaceId: 'other' })
      await recordWorkspaceStopped(OTHER, 'other')

      expect(await countStoppedWorkspaces()).toEqual(expect.arrayContaining([
        { projectId: PROJ, groupId: null, stopped: 3, deaths: 2, deathsSeenBy: { [BUILT_IN_USER_ID]: 1, [TEAMMATE]: 2 } },
        { projectId: OTHER, groupId: null, stopped: 1, deaths: 0, deathsSeenBy: {} },
      ]))
      // An excluded stop still counts toward deaths.
      expect(await countStoppedWorkspaces(['oom', 'other'])).toEqual(expect.arrayContaining([
        { projectId: PROJ, groupId: null, stopped: 2, deaths: 2, deathsSeenBy: { [BUILT_IN_USER_ID]: 1, [TEAMMATE]: 2 } },
        { projectId: OTHER, groupId: null, stopped: 0, deaths: 0, deathsSeenBy: {} },
      ]))
    })
  })

  describe('findWorkspaceRow', () => {
    it('finds an exact id in whichever project holds it, and nothing shorter', async () => {
      await create('abcdef-1234')
      await recordWorkspaceCreated({ projectId: OTHER, workspaceId: 'zzz' })

      expect((await findWorkspaceRow('abcdef-1234'))?.projectId).toBe(PROJ)
      expect((await findWorkspaceRow('zzz'))?.projectId).toBe(OTHER)
      // Prefix expansion is domain's `resolveWorkspace`, never this.
      expect(await findWorkspaceRow('abcdef')).toBeUndefined()
      expect(await findWorkspaceRow('nope')).toBeUndefined()
      expect(await findWorkspaceRow('')).toBeUndefined()
    })
  })

  describe('listProjectWorkspaceIds', () => {
    it('lists one project\'s ids', async () => {
      await create('sid-1')
      await create('sid-2')
      await recordWorkspaceCreated({ projectId: OTHER, workspaceId: 'zzz' })

      expect((await listProjectWorkspaceIds(PROJ)).sort()).toEqual(['sid-1', 'sid-2'])
    })
  })
})
