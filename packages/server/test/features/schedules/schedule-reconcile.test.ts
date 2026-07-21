import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getDb, closeDb } from '#platform/db/client'
import { schedules } from '#platform/db/schema'
import { listSchedules } from '#features/schedules/schedules'
import { cronDue, reconcileSchedules } from '#features/schedules/schedule-reconcile'
import { setDefaultTool } from '#features/projects/preferences'
import { listProvisioning, clearAllProvisioningForTests } from '#features/sessions/provisioning'
import { preferences } from '#platform/db/schema'

// Local-time constructor keeps the expectations valid in any timezone.
const at = (h: number, m: number, s = 0): Date => new Date(2026, 6, 20, h, m, s)

describe('cronDue', () => {
  it('is due when an occurrence falls between lastFired and now', () => {
    expect(cronDue('0 9 * * *', at(8, 0), at(9, 0))).toBe(true)
    expect(cronDue('0 9 * * *', at(8, 0), at(10, 30))).toBe(true)
  })

  it('is not due before the next occurrence', () => {
    expect(cronDue('0 9 * * *', at(9, 0), at(10, 0))).toBe(false)
    expect(cronDue('* * * * *', at(9, 0, 0), at(9, 0, 30))).toBe(false)
  })

  it('coalesces any number of missed occurrences into one due signal', () => {
    // Four days of missed daily fires (e.g. laptop asleep): due once, and
    // anchoring `after` at that fire clears it until the next occurrence.
    const lastFired = new Date(2026, 6, 16, 9, 0)
    const now = new Date(2026, 6, 20, 14, 0)
    expect(cronDue('0 9 * * *', lastFired, now)).toBe(true)
    expect(cronDue('0 9 * * *', now, new Date(2026, 6, 20, 18, 0))).toBe(false)
  })

  it('the occurrence must be strictly after the anchor', () => {
    // Anchored exactly on an occurrence: that occurrence itself never
    // re-fires (markFired stamps the occurrence's tick time).
    expect(cronDue('0 9 * * *', at(9, 0), at(9, 0))).toBe(false)
  })
})

describe('reconcileSchedules', () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = await createTempDataDir()
  })

  afterAll(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  beforeEach(async () => {
    clearAllProvisioningForTests()
    const db = await getDb()
    await db.delete(schedules)
    await db.delete(preferences)
  })

  /** Insert a row directly (no on-disk project needed for the sweep). */
  async function seedRow(over: Partial<typeof schedules.$inferInsert> = {}): Promise<string> {
    const db = await getDb()
    const id = randomUUID()
    await db.insert(schedules).values({
      id,
      projectSlug: 'proj-a',
      spec: '0 9 * * *',
      prompt: 'do the thing',
      createdAt: at(8, 0),
      ...over,
    })
    return id
  }

  it('fires a due schedule once, persisting lastFiredAt before the create runs', async () => {
    const id = await seedRow()
    const seen: string[] = []
    const createSessionFn = vi.fn(async (slug: string, _opts: { tool?: string; initialPrompt?: string }) => {
      // The fire must already be durable when the create starts — a crash
      // mid-create loses the fire instead of re-firing on the next tick.
      const [row] = await listSchedules('proj-a')
      expect(row.lastFiredAt).not.toBeNull()
      seen.push(slug)
      return { sessionId: 's', jobName: 'j', forwardedPorts: [], tool: 'claude' as const }
    })

    await reconcileSchedules({ now: () => at(9, 30), createSessionFn })
    await vi.waitFor(() => expect(createSessionFn).toHaveBeenCalledTimes(1))
    expect(seen).toEqual(['proj-a'])
    expect(createSessionFn.mock.calls[0][1]).toMatchObject({
      tool: 'claude',
      initialPrompt: 'do the thing',
      sessionId: expect.any(String) as string,
      onProgress: expect.any(Function) as (message: string) => void,
    })
    // The fired session provisioned under a sidebar row (same lifecycle as a
    // user create); the row is gone once the detached create resolves.
    await vi.waitFor(() => expect(listProvisioning()).toEqual([]))

    // Same tick time again: the fire is anchored, nothing re-fires.
    await reconcileSchedules({ now: () => at(9, 30), createSessionFn })
    await new Promise((r) => setTimeout(r, 20))
    expect(createSessionFn).toHaveBeenCalledTimes(1)

    const [row] = await listSchedules('proj-a')
    expect(row.id).toBe(id)
    expect(row.lastFiredAt).toBe(at(9, 30).toISOString())
  })

  it('does not fire before the schedule is due', async () => {
    await seedRow()
    const createSessionFn = vi.fn()
    await reconcileSchedules({ now: () => at(8, 30), createSessionFn })
    await new Promise((r) => setTimeout(r, 20))
    expect(createSessionFn).not.toHaveBeenCalled()
    const [row] = await listSchedules('proj-a')
    expect(row.lastFiredAt).toBeNull()
  })

  it('uses the row tool, else the configured default tool', async () => {
    await setDefaultTool('opencode')
    await seedRow({ spec: '0 9 * * *', tool: 'codex' })
    await seedRow({ projectSlug: 'proj-b', spec: '0 9 * * *' })
    const createSessionFn = vi.fn().mockResolvedValue(
      { sessionId: 's', jobName: 'j', forwardedPorts: [], tool: 'claude' as const },
    )

    await reconcileSchedules({ now: () => at(9, 30), createSessionFn })
    await vi.waitFor(() => expect(createSessionFn).toHaveBeenCalledTimes(2))
    const byProject = new Map(createSessionFn.mock.calls.map((c) => [c[0], c[1]]))
    expect(byProject.get('proj-a')).toMatchObject({ tool: 'codex' })
    expect(byProject.get('proj-b')).toMatchObject({ tool: 'opencode' })
  })

  it('isolates a bad row: an invalid spec cannot block other schedules', async () => {
    await seedRow({ spec: 'bogus spec' })
    await seedRow({ projectSlug: 'proj-b' })
    const createSessionFn = vi.fn().mockResolvedValue(
      { sessionId: 's', jobName: 'j', forwardedPorts: [], tool: 'claude' as const },
    )

    await reconcileSchedules({ now: () => at(9, 30), createSessionFn })
    await vi.waitFor(() => expect(createSessionFn).toHaveBeenCalledTimes(1))
    expect(createSessionFn.mock.calls[0][0]).toBe('proj-b')
  })

  it('a failed create is a lost fire, not a retry (lastFiredAt stays advanced)', async () => {
    await seedRow()
    const createSessionFn = vi.fn().mockRejectedValue(new Error('image build exploded'))

    await reconcileSchedules({ now: () => at(9, 30), createSessionFn })
    await vi.waitFor(() => expect(createSessionFn).toHaveBeenCalledTimes(1))

    await reconcileSchedules({ now: () => at(9, 45), createSessionFn })
    await new Promise((r) => setTimeout(r, 20))
    expect(createSessionFn).toHaveBeenCalledTimes(1)
    const [row] = await listSchedules('proj-a')
    expect(row.lastFiredAt).toBe(at(9, 30).toISOString())
    // The lost fire stays visible as a failed provisioning row until dismissed.
    expect(listProvisioning()[0]).toMatchObject({
      projectSlug: 'proj-a',
      kind: 'create',
      error: 'image build exploded',
    })
  })
})
