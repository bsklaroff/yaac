import { randomUUID } from 'node:crypto'
import { Cron } from 'croner'
import { desc, eq } from 'drizzle-orm'
import { getDb } from '#lib/db/client'
import { schedules } from '#lib/db/schema'
import { assertProjectExists } from '#lib/project/detail'
import { isValidTool } from '#lib/project/preferences'
import { ServerError } from '@yaac/shared/errors'
import type { ScheduleEntry } from '@yaac/shared/types'

/** Input for a new schedule; `tool` empty/undefined → default tool at fire time. */
export interface ScheduleInput {
  projectSlug: string
  spec: string
  prompt: string
  tool?: string
}

type ScheduleRow = typeof schedules.$inferSelect

function toEntry(row: ScheduleRow): ScheduleEntry {
  return {
    id: row.id,
    projectSlug: row.projectSlug,
    spec: row.spec,
    prompt: row.prompt,
    // A raw text column; rows only ever get tool values vetted on insert,
    // so a non-tool value means a hand-edited DB — surface it as null.
    tool: row.tool !== null && isValidTool(row.tool) ? row.tool : null,
    createdAt: row.createdAt.toISOString(),
    lastFiredAt: row.lastFiredAt?.toISOString() ?? null,
  }
}

/**
 * Parse a cron expression, throwing `VALIDATION` when croner rejects it.
 * Without a callback the Cron instance is inert (no timer) — safe to use
 * purely for validation and `nextRun` math.
 */
export function parseCronSpec(spec: string): Cron {
  try {
    return new Cron(spec)
  } catch (err) {
    throw new ServerError('VALIDATION', `Invalid cron expression "${spec}": ${String(err instanceof Error ? err.message : err)}`)
  }
}

/** Validate and persist a new schedule, returning the stored entry. */
export async function addSchedule(input: ScheduleInput): Promise<ScheduleEntry> {
  await assertProjectExists(input.projectSlug)
  parseCronSpec(input.spec)
  if (!input.prompt.trim()) throw new ServerError('VALIDATION', 'Schedule prompt must not be empty')
  if (input.tool !== undefined && !isValidTool(input.tool)) {
    throw new ServerError('VALIDATION', `Invalid tool "${input.tool}"`)
  }
  const db = await getDb()
  const rows = await db.insert(schedules).values({
    id: randomUUID(),
    projectSlug: input.projectSlug,
    spec: input.spec,
    prompt: input.prompt,
    tool: input.tool ?? null,
  }).returning()
  return toEntry(rows[0])
}

/** All schedules, newest first, optionally scoped to one project. */
export async function listSchedules(projectSlug?: string): Promise<ScheduleEntry[]> {
  const db = await getDb()
  const query = db.select().from(schedules)
  const rows = projectSlug !== undefined
    ? await query.where(eq(schedules.projectSlug, projectSlug)).orderBy(desc(schedules.createdAt))
    : await query.orderBy(desc(schedules.createdAt))
  return rows.map(toEntry)
}

/** Delete a schedule, throwing `NOT_FOUND` for an unknown id. */
export async function removeScheduleChecked(id: string): Promise<void> {
  const db = await getDb()
  const rows = await db.delete(schedules).where(eq(schedules.id, id)).returning()
  if (rows.length === 0) throw new ServerError('NOT_FOUND', `No schedule with id "${id}"`)
}

/** Persist a fire: the at-most-once anchor, written before the session
 *  create is launched so a crash loses the fire rather than doubling it. */
export async function markFired(id: string, at: Date): Promise<void> {
  const db = await getDb()
  await db.update(schedules).set({ lastFiredAt: at }).where(eq(schedules.id, id))
}
