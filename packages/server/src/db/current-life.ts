import { and, eq, sql } from 'drizzle-orm'
import { workspaceLives, workspaces } from './schema'

/**
 * A workspace's current life is its newest (docs/workspace-steps.md
 * "Lives"): the one its stop, deadline and launch facts are read from and
 * written to. Named in raw SQL so the same condition holds in a join and in
 * an UPDATE of `workspace_lives` alone.
 */
export const isCurrentLife = sql`workspace_lives.started_at = (
  select max(l.started_at) from workspace_lives l where l.workspace_id = workspace_lives.workspace_id)`

/** Joins a workspace to its current life. */
export const currentLife = and(eq(workspaceLives.workspaceId, workspaces.workspaceId), isCurrentLife)
